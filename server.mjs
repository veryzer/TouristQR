import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  hashPassword,
  isSiteAdmin,
  normaliseUsername,
  publicUser,
  sponsorOrganisationId,
  validUsername,
  verifyUserPassword,
} from "./js/auth.js";
import {
  applyRestore,
  buildBackup,
  organisationsForActor,
  sitesForActor,
  subscriptionReport,
} from "./js/backup.js";
import {
  collectPhotoCodes,
  comparePhotoCodes,
  findOrganisation,
  genericLabelsForSponsor,
  nextGenericCode,
  nextPhotoCode,
  parseGenericCode,
  parsePhotoCode,
  formatPhotoCode,
} from "./js/model.js";
import { buildSignupRecords } from "./js/signup-records.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || "0.0.0.0";
const sessions = new Map();
const SESSION_HOURS = 12;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function dataFile(name) {
  return path.join(root, "data", name);
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(dataFile(name), "utf8"));
}

function writeJson(name, value) {
  fs.writeFileSync(dataFile(name), `${JSON.stringify(value, null, 2)}\n`);
}

function detectImageUpload(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return { ext: "jpg", mime: "image/jpeg" };
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  const head = buffer.subarray(0, 6).toString("ascii");
  if (head === "GIF87a" || head === "GIF89a") return { ext: "gif", mime: "image/gif" };
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

function imageBufferFromPayload(raw) {
  const text = String(raw || "").trim();
  const match = /^data:image\/(\w+);base64,(.+)$/i.exec(text);
  const b64 = match ? match[2] : (/^data:/i.test(text) ? "" : text.replace(/\s/g, ""));
  if (!b64) {
    throw Object.assign(new Error("Use JPEG, PNG, GIF, or WebP."), { status: 400 });
  }
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length > 1_600_000) {
    throw Object.assign(new Error("A photograph is too large."), { status: 400 });
  }
  const detected = detectImageUpload(buffer);
  if (!detected) {
    throw Object.assign(new Error("Use JPEG, PNG, GIF, or WebP."), { status: 400 });
  }
  return { buffer, ext: detected.ext };
}

function pngBuffer(raw) {
  const text = String(raw || "").trim();
  const match = /^data:image\/png;base64,(.+)$/i.exec(text);
  if (!match) return null;
  const buffer = Buffer.from(match[1], "base64");
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50) return null;
  if (buffer.length > 400_000) return null;
  return buffer;
}

function sendSignupMail() {
  return { sent: false, note: "Welcome email sends on the live TouristQR host." };
}

function cleanCategoryList(list, fallback) {
  const seen = new Set();
  const names = [];
  for (const item of list || []) {
    const name = String(item || "").trim().slice(0, 40);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (!names.length) names.push(...fallback);
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return names;
}

function readSettings() {
  try {
    const data = readJson("settings.json");
    return {
      sponsorNotice: String(data?.sponsorNotice || "").trim().slice(0, 400),
      heritageCategories: cleanCategoryList(data?.heritageCategories, ["Civic", "Industrial", "Recreation", "Transport"]),
      shopCategories: cleanCategoryList(data?.shopCategories, ["Restaurants", "Shops"]),
      exhibitCategories: cleanCategoryList(data?.exhibitCategories, ["Collectibles", "Industrial", "Transport", "Uncategorised"]),
    };
  } catch {
    return {
      sponsorNotice: "",
      heritageCategories: ["Civic", "Industrial", "Recreation", "Transport"],
      shopCategories: ["Restaurants", "Shops"],
      exhibitCategories: ["Collectibles", "Industrial", "Transport", "Uncategorised"],
    };
  }
}

function writeSettings(value) {
  const current = readSettings();
  const settings = {
    sponsorNotice: value?.sponsorNotice == null ? current.sponsorNotice : String(value.sponsorNotice || "").trim().slice(0, 400),
    heritageCategories: value?.heritageCategories ? cleanCategoryList(value.heritageCategories, current.heritageCategories) : current.heritageCategories,
    shopCategories: value?.shopCategories ? cleanCategoryList(value.shopCategories, current.shopCategories) : current.shopCategories,
    exhibitCategories: value?.exhibitCategories ? cleanCategoryList(value.exhibitCategories, current.exhibitCategories) : current.exhibitCategories,
  };
  writeJson("settings.json", settings);
  writeJson("categories.json", {
    heritage: settings.heritageCategories,
    shop: settings.shopCategories,
    exhibit: settings.exhibitCategories,
  });
  return settings;
}

function organisationKindValue(value, fallback = "site") {
  if (value === "shop" || value === "site" || value === "exhibit") return value;
  if (fallback === "shop" || fallback === "exhibit") return fallback;
  return "site";
}

function shopGroupValue(kind, value, fallback = "shops") {
  if (kind !== "shop") return "";
  if (value === "restaurants" || value === "shops") return value;
  return fallback === "restaurants" ? "restaurants" : "shops";
}

function logActivity(entry) {
  const current = readJson("activity.json");
  current.push({ at: new Date().toISOString(), ...entry });
  writeJson("activity.json", current);
}

function slugifyOrgId(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function orgLogoStem(org) {
  const slug = slugifyOrgId(org?.id) || `sponsor-${org?.number || 0}`;
  return `${slug}-club-logo`;
}

function deleteOrgLogoFiles(org) {
  const dir = path.join(root, "images");
  if (!fs.existsSync(dir)) return;
  const stem = orgLogoStem(org);
  for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) {
    const file = path.join(dir, `${stem}.${ext}`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  const n = Number(org?.number);
  if (Number.isInteger(n) && n > 0) {
    for (const ext of ["jpg", "jpeg", "png", "webp", "gif"]) {
      const legacy = path.join(dir, `logo-${n}.${ext}`);
      if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
    }
  }
  const url = String(org?.logoUrl || "").split("?")[0];
  if (url.startsWith("images/")) {
    const file = path.join(dir, path.basename(url));
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function deletePhotoFilesForSponsorNumber(sponsorNumber) {
  const n = Number(sponsorNumber);
  if (!Number.isInteger(n) || n < 1) return;
  const imageDir = path.join(root, "images");
  if (!fs.existsSync(imageDir)) return;
  const prefix = `${n}-`;
  for (const name of fs.readdirSync(imageDir)) {
    if (!name.toLowerCase().startsWith(prefix)) continue;
    const code = name.replace(/\.(jpe?g|png|gif|webp)$/i, "");
    if (!parsePhotoCode(code)) continue;
    try {
      fs.unlinkSync(path.join(imageDir, name));
    } catch {
      /* ignore */
    }
  }
}

function stampPhotoMediaVersion(code, url) {
  const version = Date.now();
  const sites = readJson("sites.json");
  let changed = false;
  for (let i = 0; i < sites.length; i += 1) {
    let siteChanged = false;
    const photos = sites[i].photos || [];
    for (let j = 0; j < photos.length; j += 1) {
      if (photos[j].code !== code) continue;
      photos[j].url = url;
      photos[j].mediaVersion = version;
      siteChanged = true;
    }
    if (siteChanged) {
      sites[i].photos = photos;
      sites[i].updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeJson("sites.json", sites);
  return version;
}

function deletePhotoFilesForSites(sitesToRemove) {
  const imageDir = path.join(root, "images");
  const exts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
  for (const site of sitesToRemove) {
    for (const photo of site.photos || []) {
      const code = String(photo.code || "").trim();
      if (!code) continue;
      const url = String(photo.url || "");
      if (url.startsWith("data:")) continue;
      const relative = url.replace(/^images\//i, "");
      if (relative) {
        const filePath = path.join(imageDir, ...relative.split("/"));
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch {
            /* ignore */
          }
          continue;
        }
      }
      for (const ext of exts) {
        const alt = path.join(imageDir, `${code}${ext}`);
        if (fs.existsSync(alt)) {
          try {
            fs.unlinkSync(alt);
          } catch {
            /* ignore */
          }
          break;
        }
      }
    }
  }
}

function codesOnDisk() {
  const dir = path.join(root, "images");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => name.replace(/\.(jpe?g|png|gif|webp)$/i, ""))
    .filter((code) => parsePhotoCode(code));
}

function asLines(value) {
  if (Array.isArray(value)) return value.map((line) => String(line).trim()).filter(Boolean);
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normaliseSite(site, organisations) {
  const org = findOrganisation(organisations, site.organisationId);
  if (!org) {
    const error = new Error("Choose an organisation for this site.");
    error.status = 400;
    throw error;
  }
  const id = String(site.id || "").trim();
  if (!/^[a-z0-9-]{1,80}$/.test(id)) {
    const error = new Error("Use a site id of lowercase letters, numbers, and hyphens.");
    error.status = 400;
    throw error;
  }
  const name = String(site.name || "").trim();
  if (!name) {
    const error = new Error("A site needs a name.");
    error.status = 400;
    throw error;
  }
  const createdAt = String(site.createdAt || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(createdAt)) {
    const error = new Error("The created date should look like 2026-05-01.");
    error.status = 400;
    throw error;
  }
  const buildYear = String(site.buildYear || "").trim();
  const fromText = Number(buildYear.match(/\d{3,4}/)?.[0]);
  const yearStart = Number(site.yearStart) || fromText || null;
  if ((site.photos || []).length > 20) {
    const error = new Error("A listing can have at most 20 photographs.");
    error.status = 400;
    throw error;
  }
    const photos = (site.photos || []).map((photo) => {
    const parsed = parsePhotoCode(photo.code);
    if (!parsed || parsed.sponsorNumber !== org.number) {
      const error = new Error(`Photograph codes for this sponsor start with ${org.number}-`);
      error.status = 400;
      throw error;
    }
    const code = formatPhotoCode(parsed.sponsorNumber, parsed.reference);
    const rawUrl = String(photo.url || "").trim();
    let url = rawUrl;
    if (rawUrl.startsWith("data:")) {
      url = rawUrl;
    } else {
      const pathPart = rawUrl.replace(/^images\//i, "").split("?")[0];
      const extMatch = pathPart.match(/\.(jpe?g|png|gif|webp)$/i);
      const ext = extMatch ? extMatch[0].replace(/^\./, "") : "jpg";
      url = `images/${code}.${ext === "jpeg" ? "jpg" : ext}`;
    }
    const row = {
      code,
      url,
      caption: String(photo.caption || "").trim(),
      credit: String(photo.credit || "Demonstration photograph").trim(),
      kind: photo.kind === "historical" ? "historical" : "current",
    };
    const mediaVersion = Number(photo.mediaVersion);
    if (Number.isFinite(mediaVersion) && mediaVersion > 0) row.mediaVersion = mediaVersion;
    return row;
  });
  const updatedAt = String(site.updatedAt || "").trim();
  return {
    id,
    organisationId: org.id,
    name,
    buildYear,
    yearStart,
    yearEnd: Number(site.yearEnd) || yearStart,
    circa: Boolean(site.circa),
    category: String(site.category || "").trim(),
    shopGroup: org.kind === "shop"
      ? (site.shopGroup === "restaurants" || org.shopGroup === "restaurants" ? "restaurants" : "shops")
      : "",
    country: String(site.country || "Australia").trim(),
    state: String(site.state || "Victoria").trim(),
    city: String(site.city || "Geelong").trim(),
    suburb: String(site.suburb || "").trim(),
    mapArea: String(site.mapArea || "").trim(),
    mapsQuery: String(site.mapsQuery || "").trim(),
    phone: String(site.phone || "").trim().slice(0, 40),
    contactPerson: String(site.contactPerson || "").trim(),
    contactEmail: String(site.contactEmail || "").trim(),
    owner: String(site.owner || "").trim(),
    registrationNumber: String(site.registrationNumber || "").trim(),
    description: String(site.description || "").trim(),
    facts: asLines(site.facts),
    furtherReading: String(site.furtherReading || "").trim(),
    sources: asLines(site.sources),
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
    photos,
  };
}

function photoLibrary(sites, organisations) {
  const used = new Map();
  for (const site of sites) {
    const org = findOrganisation(organisations, site.organisationId);
    for (const photo of site.photos || []) {
      used.set(photo.code, {
        code: photo.code,
        url: photo.url,
        caption: photo.caption,
        kind: photo.kind,
        siteId: site.id,
        siteName: site.name,
        sponsorNumber: org?.number || null,
        sponsorName: org?.name || "",
      });
    }
  }
  for (const code of codesOnDisk()) {
    if (!used.has(code)) {
      const parsed = parsePhotoCode(code);
      used.set(code, {
        code,
        url: `images/${code}.jpg`,
        caption: "",
        kind: "",
        siteId: "",
        siteName: "Not used on a site",
        sponsorNumber: parsed.sponsorNumber,
        sponsorName: "",
      });
    }
  }
  return [...used.values()].sort((a, b) => comparePhotoCodes(a.code, b.code));
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Upload is too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name) continue;
    out[name] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function sessionCookie(token, req, maxAgeSeconds) {
  const secure = req.headers["x-forwarded-proto"] === "https" || Boolean(process.env.COOKIE_SECURE);
  const parts = [
    `touristqr_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function currentUser(req) {
  const token = parseCookies(req).touristqr_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const users = readJson("users.json");
  return users.find((user) => user.username === session.username) || null;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sign in to continue." });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (!isSiteAdmin(user)) {
    sendJson(res, 403, { error: "Only the site admin can do that." });
    return null;
  }
  return user;
}

function collectBackupPhotos(sites) {
  const photos = [];
  for (const site of sites) {
    for (const photo of site.photos || []) {
      if (String(photo.url || "").startsWith("data:")) {
        photos.push({ code: photo.code, dataUrl: photo.url });
        continue;
      }
      const relative = String(photo.url || "").replace(/^images\//i, "");
      const file = path.join(root, "images", relative || `${photo.code}.jpg`);
      if (fs.existsSync(file)) {
        photos.push({ code: photo.code, jpeg: fs.readFileSync(file).toString("base64") });
      }
    }
  }
  return photos;
}

function restoreBackupPhotos(photos) {
  if (!Array.isArray(photos)) return;
  fs.mkdirSync(path.join(root, "images"), { recursive: true });
  for (const photo of photos) {
    if (!parsePhotoCode(photo.code) || !photo.jpeg) continue;
    fs.writeFileSync(path.join(root, "images", `${photo.code}.jpg`), Buffer.from(photo.jpeg, "base64"));
  }
}

function blockedStatic(relative) {
  const file = relative.replace(/\\/g, "/").toLowerCase();
  return file === "data/users.json"
    || file.startsWith(".git/")
    || file === ".git"
    || file.startsWith(".vscode/")
    || file.endsWith("sftp.json");
}

function safeFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const cleaned = decoded.replace(/^\/+/, "");
  if (!cleaned || cleaned === "/") return path.join(root, "index.html");
  const full = path.resolve(root, cleaned);
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (blockedStatic(relative)) return null;
  return full;
}

function writeSites(incoming, organisations) {
  const sites = incoming.map((site) => normaliseSite(site, organisations));
  const ids = new Set();
  const photoCodes = new Set();
  for (const site of sites) {
    if (ids.has(site.id)) {
      throw Object.assign(new Error(`Two sites use the id ${site.id}.`), { status: 400 });
    }
    ids.add(site.id);
    for (const photo of site.photos) {
      if (photoCodes.has(photo.code)) {
        throw Object.assign(new Error(`Photograph ${photo.code} is already used.`), { status: 400 });
      }
      photoCodes.add(photo.code);
    }
  }
  writeJson("sites.json", sites);
  return sites;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === "/api/session" && req.method === "GET") {
      sendJson(res, 200, { user: publicUser(currentUser(req)) });
      return;
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 20_000)).toString("utf8"));
      const username = normaliseUsername(body.username);
      const users = readJson("users.json");
      const user = users.find((item) => item.username === username);
      if (!user || !verifyUserPassword(body.password, user)) {
        sendJson(res, 401, { error: "Username or password is not correct." });
        return;
      }
      const token = crypto.randomBytes(24).toString("hex");
      sessions.set(token, {
        username: user.username,
        expiresAt: Date.now() + SESSION_HOURS * 60 * 60 * 1000,
      });
      logActivity({ action: "login", username: user.username });
      sendJson(res, 200, { user: publicUser(user) }, {
        "Set-Cookie": sessionCookie(token, req, SESSION_HOURS * 60 * 60),
      });
      return;
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      const token = parseCookies(req).touristqr_session;
      if (token) sessions.delete(token);
      sendJson(res, 200, { user: null }, {
        "Set-Cookie": sessionCookie("", req, 0),
      });
      return;
    }

    if (url.pathname === "/api/sites" && req.method === "GET") {
      const user = requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, sitesForActor(readJson("sites.json"), user));
      return;
    }

    if (url.pathname === "/api/organisations" && req.method === "GET") {
      const user = requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, organisationsForActor(readJson("organisations.json"), user));
      return;
    }

    if (url.pathname === "/api/photos" && req.method === "GET") {
      const user = requireUser(req, res);
      if (!user) return;
      const sites = sitesForActor(readJson("sites.json"), user);
      const organisations = organisationsForActor(readJson("organisations.json"), user);
      sendJson(res, 200, photoLibrary(sites, organisations).filter((photo) => {
        if (isSiteAdmin(user)) return true;
        const org = organisations[0];
        return org && photo.sponsorNumber === org.number;
      }));
      return;
    }

    if (url.pathname === "/api/report" && req.method === "GET") {
      const user = requireAdmin(req, res);
      if (!user) return;
      sendJson(res, 200, subscriptionReport(readJson("organisations.json"), readJson("sites.json")));
      return;
    }

    if (url.pathname === "/api/users" && req.method === "GET") {
      const user = requireUser(req, res);
      if (!user) return;
      const organisationId = String(url.searchParams.get("organisationId") || "").trim();
      if (!organisationId) {
        sendJson(res, 400, { error: "Choose a sponsor." });
        return;
      }
      if (!isSiteAdmin(user) && sponsorOrganisationId(user) !== organisationId) {
        sendJson(res, 403, { error: "You can only view your own login." });
        return;
      }
      const found = readJson("users.json").find((item) => item.role === "sponsor" && item.organisationId === organisationId);
      sendJson(res, 200, { username: found?.username || "" });
      return;
    }

    if (url.pathname === "/api/users" && req.method === "PUT") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = JSON.parse((await readBody(req, 20_000)).toString("utf8"));
      const organisationId = String(body.organisationId || "").trim();
      const username = normaliseUsername(body.username);
      const password = String(body.password || "");
      if (!organisationId) {
        sendJson(res, 400, { error: "Choose a sponsor." });
        return;
      }
      if (!isSiteAdmin(user) && sponsorOrganisationId(user) !== organisationId) {
        sendJson(res, 403, { error: "You can only change your own login." });
        return;
      }
      if (!findOrganisation(readJson("organisations.json"), organisationId)) {
        sendJson(res, 400, { error: "Choose a sponsor for this login." });
        return;
      }
      const users = readJson("users.json");
      const index = users.findIndex((item) => item.role === "sponsor" && item.organisationId === organisationId);
      if (index < 0) {
        if (!validUsername(username) || password.length < 8) {
          sendJson(res, 400, { error: "A new login needs a login name and a password of at least 8 characters." });
          return;
        }
        if (users.some((item) => item.username === username)) {
          sendJson(res, 400, { error: "That login name is already used." });
          return;
        }
        users.push({ username, role: "sponsor", organisationId, ...hashPassword(password) });
        writeJson("users.json", users);
        logActivity({ action: "create-user", username, organisationId, by: user.username });
        sendJson(res, 200, { username });
        return;
      }
      if (username && !validUsername(username)) {
        sendJson(res, 400, { error: "A login name uses 3–40 letters, numbers, dots, hyphens, or underscores." });
        return;
      }
      if (username && users.some((item, i) => item.username === username && i !== index)) {
        sendJson(res, 400, { error: "That login name is already used." });
        return;
      }
      if (password && password.length < 8) {
        sendJson(res, 400, { error: "A new password needs at least 8 characters." });
        return;
      }
      if (!username && !password) {
        sendJson(res, 200, { username: users[index].username });
        return;
      }
      const previous = users[index].username;
      const nextName = username || previous;
      users[index] = {
        ...users[index],
        username: nextName,
        ...(password ? hashPassword(password) : {}),
      };
      writeJson("users.json", users);
      if (previous !== nextName) {
        for (const session of sessions.values()) {
          if (session.username === previous) session.username = nextName;
        }
      }
      logActivity({ action: "update-user", username: nextName, organisationId, by: user.username });
      sendJson(res, 200, { username: nextName });
      return;
    }

    if (url.pathname === "/api/users" && req.method === "POST") {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = JSON.parse((await readBody(req, 20_000)).toString("utf8"));
      const username = normaliseUsername(body.username);
      const password = String(body.password || "");
      const organisationId = String(body.organisationId || "").trim();
      if (!validUsername(username)) {
        sendJson(res, 400, { error: "A username uses 3–40 letters, numbers, dots, hyphens, or underscores." });
        return;
      }
      if (password.length < 8) {
        sendJson(res, 400, { error: "Give the sponsor a password of at least 8 characters." });
        return;
      }
      const organisations = readJson("organisations.json");
      if (!findOrganisation(organisations, organisationId)) {
        sendJson(res, 400, { error: "Choose a sponsor for this login." });
        return;
      }
      const users = readJson("users.json");
      if (users.some((item) => item.username === username)) {
        sendJson(res, 400, { error: "That username is already used." });
        return;
      }
      const hashed = hashPassword(password);
      users.push({
        username,
        role: "sponsor",
        organisationId,
        ...hashed,
      });
      writeJson("users.json", users);
      logActivity({ action: "create-user", username, organisationId, by: admin.username });
      sendJson(res, 200, { user: { username, role: "sponsor", organisationId } });
      return;
    }

    if (url.pathname === "/api/backup" && req.method === "GET") {
      const user = requireUser(req, res);
      if (!user) return;
      const organisations = readJson("organisations.json");
      const sites = readJson("sites.json");
      const scope = url.searchParams.get("scope") || "sponsor";
      let backup;
      if (scope === "full") {
        if (!isSiteAdmin(user)) {
          sendJson(res, 403, { error: "Only the site admin can download the whole catalogue." });
          return;
        }
        backup = buildBackup({ kind: "full", organisations, sites });
        backup.users = readJson("users.json");
        backup.settings = readSettings();
      } else {
        const organisationId = isSiteAdmin(user)
          ? (url.searchParams.get("organisationId") || organisations[0]?.id)
          : sponsorOrganisationId(user);
        backup = buildBackup({ kind: "sponsor", organisationId, organisations, sites });
      }
      backup.photos = collectBackupPhotos(backup.sites);
      logActivity({ action: "backup", kind: backup.kind, organisationId: backup.organisationId || null, by: user.username });
      sendJson(res, 200, backup);
      return;
    }

    if (url.pathname === "/api/restore" && req.method === "POST") {
      const user = requireUser(req, res);
      if (!user) return;
      const backup = JSON.parse((await readBody(req, 40_000_000)).toString("utf8"));
      const next = applyRestore({
        currentOrganisations: readJson("organisations.json"),
        currentSites: readJson("sites.json"),
        backup,
        user,
      });
      const organisations = next.organisations;
      const sites = writeSites(next.sites, organisations);
      writeJson("organisations.json", organisations);
      if (backup.kind === "full" && Array.isArray(backup.users) && isSiteAdmin(user)) {
        writeJson("users.json", backup.users);
      }
      if (backup.kind === "full" && backup.settings && isSiteAdmin(user)) {
        writeSettings(backup.settings);
      }
      restoreBackupPhotos(backup.photos);
      logActivity({ action: "restore", kind: backup.kind, organisationId: backup.organisationId || null, by: user.username });
      sendJson(res, 200, {
        organisations: organisationsForActor(organisations, user),
        sites: sitesForActor(sites, user),
      });
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      const user = requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, readSettings());
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "PUT") {
      const user = requireAdmin(req, res);
      if (!user) return;
      const body = JSON.parse((await readBody(req, 20_000)).toString("utf8"));
      const settings = writeSettings(body);
      logActivity({ action: "save-notice", by: user.username });
      sendJson(res, 200, settings);
      return;
    }

    if (url.pathname === "/api/organisations" && req.method === "PUT") {
      const user = requireUser(req, res);
      if (!user) return;
      const incoming = JSON.parse((await readBody(req, 1_000_000)).toString("utf8"));
      if (!Array.isArray(incoming)) {
        sendJson(res, 400, { error: "Expected a list of sponsors." });
        return;
      }
      const current = readJson("organisations.json");
      if (!isSiteAdmin(user)) {
        const orgId = sponsorOrganisationId(user);
        const edited = incoming.find((item) => item.id === orgId) || incoming[0];
        const currentOrg = current.find((org) => org.id === orgId);
        const kind = organisationKindValue(currentOrg?.kind, "site");
        const email = String(edited?.email || "").trim();
        const contactName = String(edited?.contactName || "").trim().slice(0, 80);
        const contactEmail = String(edited?.contactEmail || "").trim().slice(0, 120);
        const name = String(edited?.name || currentOrg?.name || "").trim() || currentOrg?.name;
        if (kind !== "shop" && !email) {
          sendJson(res, 400, { error: "Enter a public contact email address." });
          return;
        }
        const next = current.map((org) => {
          if (org.id !== orgId) return org;
          const shopGroup = shopGroupValue(kind, edited?.shopGroup, org.shopGroup);
          const website = String(edited?.website ?? org.website ?? "").trim().slice(0, 200);
          return { ...org, email, contactName, contactEmail, name, website, ...(kind === "shop" ? { shopGroup } : {}) };
        });
        writeJson("organisations.json", next);
        logActivity({ action: "save-organisations", by: user.username });
        sendJson(res, 200, organisationsForActor(next, user));
        return;
      }
      const next = current.map((org) => {
        const edited = incoming.find((item) => item.id === org.id);
        if (!edited) return org;
        const kind = organisationKindValue(org.kind, "site");
        const email = String(edited.email ?? org.email ?? "").trim();
        const contactName = String(edited.contactName ?? org.contactName ?? "").trim().slice(0, 80);
        const contactEmail = String(edited.contactEmail ?? org.contactEmail ?? "").trim().slice(0, 120);
        const name = String(edited.name || org.name).trim() || org.name;
        const subscribedAt = /^\d{4}-\d{2}-\d{2}$/.test(edited.subscribedAt) ? edited.subscribedAt : org.subscribedAt;
        const shopGroup = shopGroupValue(kind, edited.shopGroup, org.shopGroup);
        const website = String(edited.website ?? org.website ?? "").trim().slice(0, 200);
        return { ...org, email, contactName, contactEmail, name, website, subscribedAt, kind, ...(kind === "shop" ? { shopGroup } : { shopGroup: undefined }) };
      });
      for (const item of incoming) {
        if (next.some((org) => org.id === item.id)) continue;
        const id = String(item.id || "").trim();
        const name = String(item.name || "").trim();
        const kind = organisationKindValue(item.kind, "site");
        const email = String(item.email || "").trim();
        if (!/^[a-z0-9-]{1,80}$/.test(id) || !name || (kind !== "shop" && !email)) {
          sendJson(res, 400, { error: kind === "shop" ? "A new shop sponsor needs a name." : "A new sponsor needs a name and an email." });
          return;
        }
        const requested = Number(item.number);
        const sponsorNumber = Number.isInteger(requested) && requested > 0 && !next.some((org) => org.number === requested)
          ? requested
          : Math.max(0, ...next.map((org) => Number(org.number) || 0)) + 1;
        const subscribedAt = /^\d{4}-\d{2}-\d{2}$/.test(item.subscribedAt) ? item.subscribedAt : new Date().toISOString().slice(0, 10);
        const shopGroup = shopGroupValue(kind, item.shopGroup, "shops");
        next.push({
          number: sponsorNumber,
          id,
          name,
          type: String(item.type || (kind === "shop" ? "Shop" : kind === "exhibit" ? "Exhibit" : "Organisation")),
          kind,
          ...(kind === "shop" ? { shopGroup } : {}),
          email,
          contactName: String(item.contactName || "").trim().slice(0, 80),
          contactEmail: String(item.contactEmail || "").trim().slice(0, 120),
          subscribedAt,
          createdAt: /^\d{4}-\d{2}-\d{2}$/.test(item.createdAt) ? item.createdAt : subscribedAt,
        });
      }
      writeJson("organisations.json", next);
      logActivity({ action: "save-organisations", by: user.username });
      sendJson(res, 200, next);
      return;
    }

    if (url.pathname === "/api/delete-sponsor" && req.method === "POST") {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = JSON.parse((await readBody(req, 20_000)).toString("utf8"));
      const organisationId = String(body.organisationId || "").trim();
      const organisations = readJson("organisations.json");
      const org = findOrganisation(organisations, organisationId);
      if (!org) {
        sendJson(res, 400, { error: "Choose a sponsor to delete." });
        return;
      }
      const currentSites = readJson("sites.json");
      const releasedGenerics = genericLabelsForSponsor(currentSites, organisations, organisationId);
      const removedSites = currentSites.filter((site) => site.organisationId === organisationId);
      deletePhotoFilesForSites(removedSites);
      deletePhotoFilesForSponsorNumber(org.number);
      deleteOrgLogoFiles(org);
      const nextOrgs = organisations.filter((item) => item.id !== organisationId);
      const nextSites = currentSites.filter((site) => site.organisationId !== organisationId);
      const nextUsers = readJson("users.json").filter((item) => !(item.role === "sponsor" && item.organisationId === organisationId));
      writeJson("organisations.json", nextOrgs);
      writeJson("sites.json", nextSites);
      writeJson("users.json", nextUsers);
      logActivity({
        action: "delete-sponsor",
        organisationId,
        deleteListings: true,
        releasedGenerics,
        by: admin.username,
      });
      sendJson(res, 200, {
        organisations: organisationsForActor(nextOrgs, admin),
        sites: sitesForActor(nextSites, admin),
        releasedGenerics,
      });
      return;
    }

    if (url.pathname === "/api/signup-meta" && req.method === "GET") {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      sendJson(res, 200, {
        next: nextGenericCode(readJson("sites.json"), readJson("organisations.json")),
      });
      return;
    }

    if (url.pathname === "/api/signup" && req.method === "POST") {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      const body = JSON.parse((await readBody(req, 8_000_000)).toString("utf8"));
      const built = buildSignupRecords({
        body,
        organisations: readJson("organisations.json"),
        sites: readJson("sites.json"),
        users: readJson("users.json"),
      });
      fs.mkdirSync(path.join(root, "images"), { recursive: true });
      for (const photo of built.photos) {
        const { buffer, ext } = imageBufferFromPayload(photo.dataUrl || photo.jpeg);
        fs.writeFileSync(path.join(root, "images", `${photo.code}.${ext}`), buffer);
      }
      const users = readJson("users.json");
      users.push({
        username: built.username,
        role: "sponsor",
        organisationId: built.organisation.id,
        ...hashPassword(built.password),
      });
      writeJson("organisations.json", built.organisations);
      writeJson("sites.json", built.sites);
      writeJson("users.json", users);
      const qr = parseGenericCode(body.genericCode)?.listingId === built.generic.listingId
        ? pngBuffer(body.qrPng)
        : null;
      const mail = sendSignupMail(built.email, built.contactEmail, qr);
      logActivity({
        action: "signup",
        organisationId: built.organisation.id,
        listingId: built.site.id,
        generic: built.generic.label,
        by: admin.username,
      });
      sendJson(res, 200, {
        organisationId: built.organisation.id,
        listingId: built.site.id,
        businessName: built.organisation.name,
        generic: built.generic,
        publicUrl: built.publicUrl,
        previewUrl: `/${built.generic.label}`,
        contactEmail: built.contactEmail,
        emailSent: mail.sent,
        emailNote: mail.note || "",
        referralNote: built.referralNote || "",
      });
      return;
    }

    if (url.pathname === "/api/sites" && req.method === "PUT") {
      const user = requireUser(req, res);
      if (!user) return;
      const incoming = JSON.parse((await readBody(req, 8_000_000)).toString("utf8"));
      if (!Array.isArray(incoming)) {
        sendJson(res, 400, { error: "Expected a list of sites." });
        return;
      }
      const organisations = readJson("organisations.json");
      const current = readJson("sites.json");
      let nextList;
      if (isSiteAdmin(user)) {
        nextList = incoming;
      } else {
        const orgId = sponsorOrganisationId(user);
        if (incoming.some((site) => site.organisationId !== orgId)) {
          sendJson(res, 403, { error: "You can only save your own sites." });
          return;
        }
        nextList = [
          ...current.filter((site) => site.organisationId !== orgId),
          ...incoming,
        ];
      }
      const sites = writeSites(nextList, organisations);
      logActivity({ action: "save-sites", count: incoming.length, by: user.username });
      sendJson(res, 200, sitesForActor(sites, user));
      return;
    }

    if (url.pathname === "/api/org-logo" && (req.method === "POST" || req.method === "DELETE")) {
      const user = requireUser(req, res);
      if (!user) return;
      const organisations = readJson("organisations.json");
      const sponsor = Number(url.searchParams.get("sponsor"));
      const orgIndex = organisations.findIndex((item) => item.number === sponsor);
      if (orgIndex === -1) {
        sendJson(res, 400, { error: "Unknown sponsor number." });
        return;
      }
      const org = organisations[orgIndex];
      if (org.kind !== "exhibit") {
        sendJson(res, 400, { error: "Club logos are only for exhibit sponsors." });
        return;
      }
      if (!isSiteAdmin(user) && org.id !== sponsorOrganisationId(user)) {
        sendJson(res, 403, { error: "You can only change your own sponsor logo." });
        return;
      }
      const imageDir = path.join(root, "images");
      if (req.method === "DELETE") {
        deleteOrgLogoFiles(org);
        delete organisations[orgIndex].logoUrl;
        delete organisations[orgIndex].logoVersion;
        writeJson("organisations.json", organisations);
        logActivity({ action: "remove-org-logo", sponsor, by: user.username });
        sendJson(res, 200, { logoUrl: "", logoVersion: null });
        return;
      }
      const buffer = await readBody(req, 800_000);
      const detected = detectImageUpload(buffer);
      if (!detected) {
        sendJson(res, 400, { error: "Use JPEG, PNG, GIF, or WebP." });
        return;
      }
      fs.mkdirSync(imageDir, { recursive: true });
      deleteOrgLogoFiles(org);
      const stem = orgLogoStem(org);
      const relativeUrl = `images/${stem}.${detected.ext}`;
      fs.writeFileSync(path.join(imageDir, `${stem}.${detected.ext}`), buffer);
      const logoVersion = Date.now();
      organisations[orgIndex].logoUrl = relativeUrl;
      organisations[orgIndex].logoVersion = logoVersion;
      writeJson("organisations.json", organisations);
      logActivity({ action: "save-org-logo", sponsor, by: user.username });
      sendJson(res, 200, { logoUrl: relativeUrl, logoVersion });
      return;
    }

    if (url.pathname === "/api/media" && req.method === "POST") {
      const user = requireUser(req, res);
      if (!user) return;
      const organisations = readJson("organisations.json");
      const sponsor = Number(url.searchParams.get("sponsor"));
      const org = organisations.find((item) => item.number === sponsor);
      if (!org) {
        sendJson(res, 400, { error: "Unknown sponsor number." });
        return;
      }
      if (!isSiteAdmin(user) && org.id !== sponsorOrganisationId(user)) {
        sendJson(res, 403, { error: "You can only add photographs for your own sites." });
        return;
      }
      const sites = readJson("sites.json");
      const existing = [...collectPhotoCodes(sites), ...codesOnDisk()];
      const requested = parsePhotoCode(url.searchParams.get("code") || "");
      const code = requested && requested.sponsorNumber === sponsor
        ? formatPhotoCode(requested.sponsorNumber, requested.reference)
        : nextPhotoCode(sponsor, existing);
      const buffer = await readBody(req, 1_600_000);
      const detected = detectImageUpload(buffer);
      if (!detected) {
        sendJson(res, 400, { error: "Use JPEG, PNG, GIF, or WebP." });
        return;
      }
      fs.mkdirSync(path.join(root, "images"), { recursive: true });
      const relativeUrl = `images/${code}.${detected.ext}`;
      fs.writeFileSync(path.join(root, "images", `${code}.${detected.ext}`), buffer);
      const mediaVersion = stampPhotoMediaVersion(code, relativeUrl);
      logActivity({ action: "save-photo", code, sponsor, mediaVersion, by: user.username });
      sendJson(res, 200, { code, url: relativeUrl, mediaVersion });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "That action is not available." });
      return;
    }

    const genericPath = /^\/Generic\d+\/?$/i.test(url.pathname);
    const filePath = genericPath ? safeFile("/index.html") : safeFile(url.pathname);
    if (!filePath) {
      sendJson(res, 400, { error: "Bad path." });
      return;
    }
    const stat = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
      ? null
      : fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    const full = stat ? filePath : null;
    if (!full) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const data = fs.readFileSync(full);
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { error: status === 500 ? "The server could not finish that." : error.message });
  }
});

server.listen(port, host, () => {
  console.log(`TouristQR is running at http://${host}:${port}/`);
  console.log(`Admin console       http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/admin.html`);
});
