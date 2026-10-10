import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectPhotoCodes,
  comparePhotoCodes,
  findOrganisation,
  nextPhotoCode,
  parsePhotoCode,
  formatPhotoCode,
} from "./js/model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT) || 4173;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
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

function logActivity(entry) {
  const current = readJson("activity.json");
  current.push({ at: new Date().toISOString(), ...entry });
  writeJson("activity.json", current);
}

function codesOnDisk() {
  const dir = path.join(root, "images");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => name.replace(/\.jpe?g$/i, ""))
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
  const photos = (site.photos || []).map((photo) => {
    const parsed = parsePhotoCode(photo.code);
    if (!parsed || parsed.sponsorNumber !== org.number) {
      const error = new Error(`Photograph codes for this sponsor start with ${org.number}-`);
      error.status = 400;
      throw error;
    }
    const code = formatPhotoCode(parsed.sponsorNumber, parsed.reference);
    return {
      code,
      url: `images/${code}.jpg`,
      caption: String(photo.caption || "").trim(),
      credit: String(photo.credit || "Demonstration photograph").trim(),
      kind: photo.kind === "historical" ? "historical" : "current",
    };
  });
  return {
    id,
    organisationId: org.id,
    name,
    buildYear,
    yearStart,
    yearEnd: Number(site.yearEnd) || yearStart,
    circa: Boolean(site.circa),
    category: String(site.category || "").trim(),
    country: String(site.country || "Australia").trim(),
    state: String(site.state || "Victoria").trim(),
    city: String(site.city || "Geelong").trim(),
    suburb: String(site.suburb || "").trim(),
    mapArea: String(site.mapArea || "").trim(),
    mapsQuery: String(site.mapsQuery || "").trim(),
    description: String(site.description || "").trim(),
    facts: asLines(site.facts),
    furtherReading: String(site.furtherReading || "").trim(),
    sources: asLines(site.sources),
    createdAt,
    photos,
  };
}

function photoLibrary() {
  const sites = readJson("sites.json");
  const organisations = readJson("organisations.json");
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

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
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

function safeFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const cleaned = decoded.replace(/^\/+/, "");
  if (!cleaned || cleaned === "/") return path.join(root, "index.html");
  const full = path.resolve(root, cleaned);
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (relative === ".git" || relative.startsWith(`.git${path.sep}`)) return null;
  return full;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === "/api/sites" && req.method === "GET") {
      sendJson(res, 200, readJson("sites.json"));
      return;
    }

    if (url.pathname === "/api/organisations" && req.method === "GET") {
      sendJson(res, 200, readJson("organisations.json"));
      return;
    }

    if (url.pathname === "/api/photos" && req.method === "GET") {
      sendJson(res, 200, photoLibrary());
      return;
    }

    if (url.pathname === "/api/organisations" && req.method === "PUT") {
      const incoming = JSON.parse((await readBody(req, 1_000_000)).toString("utf8"));
      const current = readJson("organisations.json");
      const next = current.map((org) => {
        const edited = incoming.find((item) => item.id === org.id);
        if (!edited) return org;
        const email = String(edited.email || org.email).trim();
        const subscribedAt = /^\d{4}-\d{2}-\d{2}$/.test(edited.subscribedAt) ? edited.subscribedAt : org.subscribedAt;
        return { ...org, email, subscribedAt };
      });
      writeJson("organisations.json", next);
      logActivity({ action: "save-organisations" });
      sendJson(res, 200, next);
      return;
    }

    if (url.pathname === "/api/sites" && req.method === "PUT") {
      const incoming = JSON.parse((await readBody(req, 8_000_000)).toString("utf8"));
      if (!Array.isArray(incoming)) {
        sendJson(res, 400, { error: "Expected a list of sites." });
        return;
      }
      const organisations = readJson("organisations.json");
      const sites = incoming.map((site) => normaliseSite(site, organisations));
      const ids = new Set();
      const photoCodes = new Set();
      for (const site of sites) {
        if (ids.has(site.id)) {
          sendJson(res, 400, { error: `Two sites use the id ${site.id}.` });
          return;
        }
        ids.add(site.id);
        for (const photo of site.photos) {
          if (photoCodes.has(photo.code)) {
            sendJson(res, 400, { error: `Photograph ${photo.code} is already used.` });
            return;
          }
          photoCodes.add(photo.code);
        }
      }
      writeJson("sites.json", sites);
      logActivity({ action: "save-sites", count: sites.length });
      sendJson(res, 200, sites);
      return;
    }

    if (url.pathname === "/api/media" && req.method === "POST") {
      const sponsor = Number(url.searchParams.get("sponsor"));
      const organisations = readJson("organisations.json");
      if (!organisations.some((org) => org.number === sponsor)) {
        sendJson(res, 400, { error: "Unknown sponsor number." });
        return;
      }
      const sites = readJson("sites.json");
      const existing = [...collectPhotoCodes(sites), ...codesOnDisk()];
      const requested = parsePhotoCode(url.searchParams.get("code") || "");
      const code = requested && requested.sponsorNumber === sponsor
        ? formatPhotoCode(requested.sponsorNumber, requested.reference)
        : nextPhotoCode(sponsor, existing);
      const buffer = await readBody(req, 1_600_000);
      if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        sendJson(res, 400, { error: "Save the photograph as a JPEG." });
        return;
      }
      fs.mkdirSync(path.join(root, "images"), { recursive: true });
      fs.writeFileSync(path.join(root, "images", `${code}.jpg`), buffer);
      logActivity({ action: "save-photo", code, sponsor });
      sendJson(res, 200, { code, url: `images/${code}.jpg` });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "That action is not available." });
      return;
    }

    const filePath = safeFile(url.pathname);
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

server.listen(port, "127.0.0.1", () => {
  console.log(`TouristQR is running at http://127.0.0.1:${port}/`);
  console.log(`Admin console       http://127.0.0.1:${port}/admin.html`);
});
