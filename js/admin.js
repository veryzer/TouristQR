import { assetUrl, liveSiteUrl, sitePublicUrl } from "./config.js";
import {
  addMonths,
  comparePhotoCodes,
  decadeLabel,
  findOrganisation,
  formatPhotoCode,
  isListed,
  nextPhotoCode,
  parseISODate,
  parsePhotoCode,
  subscriptionState,
} from "./model.js";
import { clearLocal, LOCAL_ORGS, LOCAL_SITES, writeLocal } from "./storage.js";

const $ = (id) => document.getElementById(id);

let organisations = [];
let sites = [];
let draftPhotos = [];
let activeSiteId = "";
let selectedOrgId = "";
let currentUser = null;
let usePhpApi = false;
let sponsorNotice = "";

function isAdmin() {
  return currentUser?.role === "site-admin";
}

function apiUrl(path) {
  if (!usePhpApi) return assetUrl(path);
  const stripped = path.replace(/^api\/?/, "");
  const qIndex = stripped.indexOf("?");
  const route = qIndex === -1 ? stripped : stripped.slice(0, qIndex);
  const extra = qIndex === -1 ? "" : stripped.slice(qIndex + 1);
  const params = new URLSearchParams(extra);
  params.set("r", route);
  return assetUrl(`api.php?${params}`);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof Blob) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(apiUrl(path), {
    credentials: "include",
    ...options,
    headers,
  });
}

async function detectApi() {
  const native = await fetch(assetUrl("api/session"), { credentials: "include" });
  if (native.status !== 404) return native;
  usePhpApi = true;
  return fetch(apiUrl("api/session"), { credentials: "include" });
}

function setLoginStatus(message, type = "error") {
  const el = $("login-status");
  el.classList.remove("hidden", "bg-red-50", "text-red-800", "border-red-200", "bg-amber-50", "text-amber-900", "border-amber-200");
  el.textContent = message || "";
  if (!message) {
    el.classList.add("hidden");
    return;
  }
  if (type === "error") el.classList.add("bg-red-50", "text-red-800", "border-red-200");
  else el.classList.add("bg-amber-50", "text-amber-900", "border-amber-200");
}

function showApp(signedIn) {
  $("login-screen").classList.toggle("hidden", signedIn);
  $("app-screen").classList.toggle("hidden", !signedIn);
}

function applyRoleUi() {
  const admin = isAdmin();
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !admin));
  $("session-label").textContent = admin
    ? `Signed in as ${currentUser.username} · site admin`
    : `Signed in as ${currentUser.username} · ${selectedOrg()?.name || organisations[0]?.name || "sponsor"}`;
  $("sponsor-started").disabled = !admin;
  renderNotice();
}

const STATUS_CLASSES = [
  "hidden", "border", "bg-red-50", "text-red-800", "border-red-200",
  "bg-green-50", "text-green-800", "border-green-200",
  "bg-amber-50", "text-amber-900", "border-amber-200", "text-slate-600",
];

function setStatus(message, type = "info") {
  const el = $("admin-status");
  el.classList.remove(...STATUS_CLASSES);
  el.textContent = message || "";
  if (!message) {
    el.classList.add("hidden");
    return;
  }
  el.classList.add("border");
  if (type === "error") el.classList.add("bg-red-50", "text-red-800", "border-red-200");
  else if (type === "success") el.classList.add("bg-green-50", "text-green-800", "border-green-200");
  else el.classList.add("bg-amber-50", "text-amber-900", "border-amber-200");
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function clearFieldErrors() {
  for (const id of ["siteId", "siteName", "siteYear", "siteMaps", "siteDesc", "siteCreated"]) {
    $(id)?.classList.remove("border-red-500", "ring-1", "ring-red-300");
  }
}

function markInvalid(fieldId) {
  const el = $(fieldId);
  if (!el) return;
  el.classList.add("border-red-500", "ring-1", "ring-red-300");
  el.focus();
}

function validateSiteForm() {
  const id = $("siteId").value.trim();
  if (!selectedOrgId) return { ok: false, message: "Choose a sponsor first." };
  if (!id) return { ok: false, message: "Enter a permanent site id (for example old-mill).", fieldId: "siteId" };
  if (!/^[a-z0-9-]{1,80}$/.test(id)) {
    return { ok: false, message: "The site id can only use lowercase letters, numbers, and hyphens.", fieldId: "siteId" };
  }
  if (!$("siteName").value.trim()) return { ok: false, message: "Enter the place name.", fieldId: "siteName" };
  if (!$("siteYear").value.trim()) return { ok: false, message: "Enter the build year (or an approximate year).", fieldId: "siteYear" };
  if (!$("siteMaps").value.trim()) {
    return { ok: false, message: "Enter a Google Maps search or address so visitors can open Navigate.", fieldId: "siteMaps" };
  }
  if (!$("siteDesc").value.trim()) return { ok: false, message: "Enter the site history text.", fieldId: "siteDesc" };
  if (!$("siteCreated").value) return { ok: false, message: "Choose the listing created date.", fieldId: "siteCreated" };
  if (!activeSiteId && sites.some((site) => site.id === id)) {
    return { ok: false, message: "That site id is already used. Pick another id.", fieldId: "siteId" };
  }
  return { ok: true };
}

function allPhotoCodes() {
  const codes = [];
  for (const site of sites) {
    for (const photo of site.photos || []) {
      if (photo.code) codes.push(photo.code);
    }
  }
  for (const photo of draftPhotos) {
    if (photo.code) codes.push(photo.code);
  }
  return codes;
}

function photoCount(list = sites) {
  return list.reduce((sum, site) => sum + (site.photos?.length || 0), 0);
}

function todayISO() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function toIsoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function publicUntilDate(subscribedAt) {
  const start = parseISODate(subscribedAt);
  return start ? addMonths(start, 12) : null;
}

function publicUntilIso(subscribedAt) {
  const date = publicUntilDate(subscribedAt);
  return date ? toIsoDate(date) : "";
}

function formatDay(iso) {
  const date = parseISODate(iso);
  if (!date) return iso || "";
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function selectedOrg() {
  return findOrganisation(organisations, selectedOrgId);
}

function sitesForSelectedSponsor() {
  if (!selectedOrgId) return [];
  return sites.filter((site) => site.organisationId === selectedOrgId);
}

function listingText(site) {
  const org = selectedOrg() || findOrganisation(organisations, site.organisationId);
  if (!org) return "Choose a sponsor";
  if (!isListed(site, org)) return "Archived — the public page shows the name and year";
  if (subscriptionState(org.subscribedAt) === "grace" || subscriptionState(site.createdAt) === "grace") {
    return "Grace month — still on the public list";
  }
  return "Public";
}

function draftSite() {
  const yearText = $("siteYear").value.trim();
  const fromText = Number(yearText.match(/\d{3,4}/)?.[0]);
  return {
    id: $("siteId").value.trim(),
    organisationId: selectedOrgId,
    name: $("siteName").value.trim(),
    buildYear: yearText,
    yearStart: Number($("siteYearStart").value) || fromText || null,
    yearEnd: Number($("siteYearEnd").value) || fromText || null,
    circa: $("siteCirca").checked,
    createdAt: $("siteCreated").value,
    category: $("siteCategory").value.trim(),
  };
}

function refreshComputed() {
  const site = draftSite();
  const decade = decadeLabel(site);
  $("computed-status").textContent = `${listingText(site)}${decade ? ` · Decade filter ${decade}` : ""}`;
}

function statusLabel(org) {
  const state = subscriptionState(org.subscribedAt);
  if (state === "lapsed") return "Archived";
  if (state === "grace") return "Grace month";
  return "Active";
}

function sortedOrganisations() {
  const list = [...organisations];
  if ($("sort-by-expiry")?.checked) {
    list.sort((a, b) => {
      const aDate = publicUntilIso(a.subscribedAt) || "9999-99-99";
      const bDate = publicUntilIso(b.subscribedAt) || "9999-99-99";
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });
    return list;
  }
  return list.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
}

function sponsorOptionLabel(org) {
  const until = publicUntilIso(org.subscribedAt);
  return `${org.name} · ${statusLabel(org)} · public until ${formatDay(until)}`;
}

function renderTotals() {
  const el = $("catalogue-totals");
  if (!el) return;
  const sponsors = organisations.length;
  const siteCount = sites.length;
  const photos = photoCount();
  el.textContent = `${sponsors} supporter${sponsors === 1 ? "" : "s"} · ${siteCount} site${siteCount === 1 ? "" : "s"} · ${photos} photograph${photos === 1 ? "" : "s"}`;
}

function renderSponsorOptions() {
  const selector = $("sponsor-selector");
  if (!selector) return;
  selector.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Choose a sponsor";
  selector.append(blank);
  sortedOrganisations().forEach((org) => {
    const option = document.createElement("option");
    option.value = org.id;
    option.textContent = sponsorOptionLabel(org);
    selector.append(option);
  });
  selector.value = organisations.some((org) => org.id === selectedOrgId) ? selectedOrgId : "";
}

function renderSponsorPanel() {
  const org = selectedOrg();
  $("sponsor-panel").classList.toggle("hidden", !org);
  if (!org) {
    hideSitePanel();
    return;
  }
  $("sponsor-heading").textContent = `${org.number} · ${org.name}`;
  $("sponsor-status-pill").textContent = statusLabel(org);
  if ($("sponsor-name")) $("sponsor-name").value = org.name || "";
  $("sponsor-email").value = org.email || "";
  $("sponsor-started").value = org.subscribedAt || "";
  const mine = sitesForSelectedSponsor();
  const publicCount = mine.filter((site) => isListed(site, org)).length;
  const photos = photoCount(mine);
  const until = publicUntilIso(org.subscribedAt);
  $("sponsor-report").textContent = `${statusLabel(org)} · started ${formatDay(org.subscribedAt)} · public listing ends ${formatDay(until)} · ${mine.length} site${mine.length === 1 ? "" : "s"} · ${publicCount} on the public list · ${photos} photograph${photos === 1 ? "" : "s"}`;
  $("site-sponsor-label").textContent = org.name;
  renderSelector();
}

function selectSponsor(id, { keepSite = false } = {}) {
  selectedOrgId = organisations.some((org) => org.id === id) ? id : "";
  if ($("sponsor-selector")) $("sponsor-selector").value = selectedOrgId;
  renderSponsorPanel();
  if (!keepSite || !sitesForSelectedSponsor().some((site) => site.id === activeSiteId)) {
    hideSitePanel();
  }
}

function hideSitePanel() {
  $("site-panel").classList.add("hidden");
  activeSiteId = "";
  if ($("site-selector")) $("site-selector").value = "";
  fillForm(null);
  clearQr();
}

function showSitePanel() {
  $("site-panel").classList.remove("hidden");
}

function renderSelector() {
  const selector = $("site-selector");
  const current = selector.value;
  selector.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Choose a site";
  selector.append(blank);
  const mine = sitesForSelectedSponsor().slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
  mine.forEach((site) => {
    const org = findOrganisation(organisations, site.organisationId);
    const option = document.createElement("option");
    option.value = site.id;
    option.textContent = `${site.name} · ${isListed(site, org) ? "public" : "archived"}`;
    selector.append(option);
  });
  selector.value = mine.some((site) => site.id === current) ? current : "";
}

function photosInOrder(photos) {
  return [...(photos || [])].sort((a, b) => comparePhotoCodes(a.code, b.code));
}

function renderPhotoRows() {
  const wrap = $("photo-rows");
  wrap.replaceChildren();
  if (!draftPhotos.length) {
    const empty = document.createElement("p");
    empty.className = "text-xs text-slate-500";
    empty.textContent = "No photographs on this site yet.";
    wrap.append(empty);
    return;
  }
  draftPhotos.forEach((photo, index) => {
    const row = document.createElement("div");
    row.className = "border border-slate-200 rounded-xl p-3 grid grid-cols-[72px_1fr] gap-3";
    const image = document.createElement("img");
    image.src = photoSrc(photo.preview || photo.url);
    image.alt = "";
    image.className = "w-[72px] h-[72px] object-cover rounded-lg bg-slate-200";
    const fields = document.createElement("div");
    fields.className = "space-y-2";
    const code = document.createElement("p");
    code.className = "font-mono text-sm font-semibold";
    code.textContent = photo.code;

    const caption = document.createElement("input");
    caption.value = photo.caption || "";
    caption.placeholder = "Caption";
    caption.className = "w-full border rounded-xl p-2 text-sm";
    caption.addEventListener("input", () => {
      draftPhotos[index].caption = caption.value;
    });

    const kind = document.createElement("select");
    kind.className = "border rounded-xl p-2 text-sm bg-white";
    for (const value of ["current", "historical"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "historical" ? "Historical" : "Current";
      kind.append(option);
    }
    kind.value = photo.kind === "historical" ? "historical" : "current";
    kind.addEventListener("change", () => {
      draftPhotos[index].kind = kind.value;
    });

    const actions = document.createElement("div");
    actions.className = "flex gap-2";
    const replace = document.createElement("label");
    replace.className = "text-xs border border-slate-300 px-2 py-1 rounded-lg cursor-pointer";
    replace.textContent = "Replace file";
    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.className = "hidden";
    file.addEventListener("change", async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      await replacePhoto(index, chosen);
    });
    replace.append(file);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-xs text-slate-600 underline";
    remove.textContent = "Remove from site";
    remove.addEventListener("click", () => {
      draftPhotos.splice(index, 1);
      renderPhotoRows();
    });
    actions.append(replace, remove);
    fields.append(code, caption, kind, actions);
    row.append(image, fields);
    wrap.append(row);
  });
}

function photoSrc(url) {
  if (!url || /^(https?:|data:|blob:)/.test(url)) return url || "";
  const [path, query] = String(url).split("?");
  const full = assetUrl(path);
  return query ? `${full}?${query}` : full;
}

function slugify(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function clearQr() {
  const canvas = $("qr-canvas");
  canvas.width = 220;
  canvas.height = 220;
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  $("qr-target-url").textContent = "Enter a site id to show its QR code.";
  $("download-qr").removeAttribute("href");
}

function fillForm(site) {
  activeSiteId = site?.id || "";
  $("siteId").value = site?.id || "";
  $("siteId").readOnly = Boolean(site);
  $("siteName").value = site?.name || "";
  $("siteYear").value = site?.buildYear || "";
  $("siteCirca").checked = Boolean(site?.circa);
  $("siteCategory").value = site?.category || "";
  $("siteSuburb").value = site?.suburb || "";
  $("siteMapArea").value = site?.mapArea || "";
  $("siteMaps").value = site?.mapsQuery || "";
  $("siteDesc").value = site?.description || "";
  $("siteCountry").value = site?.country || "Australia";
  $("siteState").value = site?.state || "Victoria";
  $("siteCity").value = site?.city || "Geelong";
  $("siteYearStart").value = site?.yearStart || "";
  $("siteYearEnd").value = site?.yearEnd || "";
  $("siteCreated").value = site?.createdAt || todayISO();
  $("siteFacts").value = (site?.facts || []).join("\n");
  $("siteReading").value = site?.furtherReading || "";
  $("siteSources").value = (site?.sources || []).join("\n");
  draftPhotos = photosInOrder(site?.photos || []).map((photo) => ({ ...photo }));
  $("site-sponsor-label").textContent = selectedOrg()?.name || "";
  renderPhotoRows();
  refreshComputed();
  $("delete-site").classList.toggle("hidden", !site);
  if (site) generateQR(site.id);
}

function loadSite(id) {
  const site = sitesForSelectedSponsor().find((item) => item.id === id);
  if (!site) return;
  $("site-selector").value = id;
  fillForm(site);
  showSitePanel();
}

function resizeImageFile(file) {
  const name = String(file.name || "").toLowerCase();
  if (/\.(heic|heif)$/.test(name)) {
    return Promise.reject(new Error("HEIC photos from an iPhone need to be converted to JPEG or PNG first (for example Save as JPEG in Photos)."));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (!blob) reject(new Error("This photograph could not be resized. Try a smaller JPEG or PNG."));
        else resolve(blob);
      }, "image/jpeg", 0.82);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This file could not be opened as a photograph. Use JPEG or PNG."));
    };
    image.src = url;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the photograph."));
    reader.readAsDataURL(blob);
  });
}

async function savePhotoInBrowser(blob, sponsorNumber, code) {
  const dataUrl = await blobToDataUrl(blob);
  const assigned = code || nextPhotoCode(sponsorNumber, allPhotoCodes());
  const parsed = parsePhotoCode(assigned);
  if (!parsed || parsed.sponsorNumber !== sponsorNumber) {
    throw new Error(`Photograph codes for this sponsor start with ${sponsorNumber}-`);
  }
  const finalCode = formatPhotoCode(parsed.sponsorNumber, parsed.reference);
  return {
    code: finalCode,
    url: dataUrl,
    preview: dataUrl,
    stored: "browser",
  };
}

async function uploadPhoto(file, code) {
  const org = selectedOrg();
  if (!org) throw new Error("Choose a sponsor before adding a photograph.");
  const blob = await resizeImageFile(file);
  const params = new URLSearchParams({ sponsor: String(org.number) });
  if (code) params.set("code", code);
  try {
    const response = await api(`api/media?${params}`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.code) {
      return { ...body, url: body.url, preview: `${body.url}?t=${Date.now()}`, stored: "server" };
    }
  } catch {
    // If the upload API is not running, keep the photograph in this browser.
  }
  return savePhotoInBrowser(blob, org.number, code);
}

async function replacePhoto(index, file) {
  try {
    setStatus("Resizing photograph…", "info");
    const saved = await uploadPhoto(file, draftPhotos[index].code);
    draftPhotos[index] = {
      ...draftPhotos[index],
      code: saved.code,
      url: saved.url,
      preview: saved.preview || saved.url,
    };
    renderPhotoRows();
    const where = saved.stored === "server" ? "on the server" : "in this browser";
    setStatus(`Replaced ${saved.code} ${where}. Click Save site to keep it on this record.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function formPayload() {
  const site = draftSite();
  return {
    ...site,
    organisationId: selectedOrgId,
    country: $("siteCountry").value.trim(),
    state: $("siteState").value.trim(),
    city: $("siteCity").value.trim(),
    suburb: $("siteSuburb").value.trim(),
    mapArea: $("siteMapArea").value.trim(),
    mapsQuery: $("siteMaps").value.trim(),
    description: $("siteDesc").value.trim(),
    facts: $("siteFacts").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    furtherReading: $("siteReading").value.trim(),
    sources: $("siteSources").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    photos: draftPhotos.map((photo) => ({
      code: photo.code,
      url: photo.url,
      caption: photo.caption || "",
      credit: photo.credit || "Demonstration photograph",
      kind: photo.kind === "historical" ? "historical" : "current",
    })),
  };
}

function refreshAfterCatalogueChange() {
  renderTotals();
  renderSponsorOptions();
  if (selectedOrgId && organisations.some((org) => org.id === selectedOrgId)) {
    selectSponsor(selectedOrgId, { keepSite: true });
    if (activeSiteId) loadSite(activeSiteId);
  } else if (!isAdmin() && organisations[0]) {
    selectSponsor(organisations[0].id);
  } else {
    selectSponsor("");
  }
}

async function saveSites(nextSites) {
  const response = await api("api/sites", {
    method: "PUT",
    body: JSON.stringify(nextSites),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "This page cannot write the shared catalogue.");
  }
  sites = await response.json();
  clearLocal(LOCAL_SITES);
  refreshAfterCatalogueChange();
}

async function saveOrganisations() {
  const response = await api("api/organisations", {
    method: "PUT",
    body: JSON.stringify(organisations),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "This page cannot write the shared catalogue.");
  }
  organisations = await response.json();
  clearLocal(LOCAL_ORGS);
  refreshAfterCatalogueChange();
  setStatus("Sponsor saved.");
}

function keepLocalCopy() {
  writeLocal(LOCAL_SITES, sites);
  writeLocal(LOCAL_ORGS, organisations);
}

function persistSitesLocally(nextSites, message) {
  sites = nextSites;
  keepLocalCopy();
  refreshAfterCatalogueChange();
  setStatus(message, "success");
}

function generateQR(id, { scroll = false } = {}) {
  if (!/^[a-z0-9-]{1,80}$/.test(id) || typeof QRious === "undefined") {
    clearQr();
    return;
  }
  const target = sitePublicUrl(id);
  $("qr-target-url").textContent = target;
  const qr = new QRious({
    element: $("qr-canvas"),
    value: target,
    size: 220,
  });
  $("download-qr").href = qr.toDataURL();
  $("download-qr").download = `${id}-qr-code.png`;
  if (scroll) $("qr-section").scrollIntoView({ block: "nearest" });
}

$("sponsor-selector").addEventListener("change", () => {
  selectSponsor($("sponsor-selector").value);
});

$("sort-by-expiry").addEventListener("change", () => {
  renderSponsorOptions();
});

$("site-selector").addEventListener("change", () => {
  if ($("site-selector").value) loadSite($("site-selector").value);
  else hideSitePanel();
});

$("new-site").addEventListener("click", () => {
  if (!selectedOrgId) {
    setStatus("Choose a sponsor first.", "error");
    return;
  }
  $("site-selector").value = "";
  fillForm(null);
  clearQr();
  showSitePanel();
  setStatus("New site. Enter an id and a name, and its QR code will appear below.");
});

$("siteId").addEventListener("input", () => {
  if ($("siteId").readOnly) return;
  generateQR($("siteId").value.trim());
});

["siteYear", "siteYearStart", "siteCreated", "siteCirca"].forEach((id) => {
  $(id).addEventListener("input", refreshComputed);
  $(id).addEventListener("change", refreshComputed);
});

$("add-photo").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!selectedOrg()) {
    setStatus("Choose a sponsor before adding a photograph.", "error");
    return;
  }
  try {
    setStatus("Resizing photograph to about 1200 pixels…", "info");
    const saved = await uploadPhoto(file);
    draftPhotos.push({
      code: saved.code,
      url: saved.url,
      preview: saved.preview || saved.url,
      caption: "",
      credit: "Demonstration photograph",
      kind: "current",
    });
    renderPhotoRows();
    const where = saved.stored === "server" ? "saved on the server" : "attached in this browser";
    setStatus(`Added ${saved.code} to this site (${where}). Click Save site when you are finished editing.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("site-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFieldErrors();
  const check = validateSiteForm();
  if (!check.ok) {
    setStatus(check.message, "error");
    if (check.fieldId) markInvalid(check.fieldId);
    return;
  }
  const payload = formPayload();
  const next = activeSiteId
    ? sites.map((site) => (site.id === activeSiteId ? payload : site))
    : [...sites, payload];
  generateQR(payload.id, { scroll: true });
  setStatus("Saving site…", "info");
  activeSiteId = payload.id;
  $("site-selector").value = payload.id;
  $("siteId").readOnly = true;
  try {
    await saveSites(next);
    setStatus("Site saved on the server. The QR code below is ready to download.", "success");
    $("qr-section").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (error) {
    try {
      persistSitesLocally(
        next,
        `Site saved in this browser. ${error.message} Use View live site on this device to check it. When the server is running, save again to publish for everyone.`,
      );
      $("qr-section").scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (storageError) {
      setStatus(storageError.message, "error");
    }
  }
});

function renderNotice() {
  const banner = $("sponsor-notice");
  const text = String(sponsorNotice || "").trim();
  if (!isAdmin() && text) {
    banner.textContent = text;
    banner.classList.remove("hidden");
  } else {
    banner.textContent = "";
    banner.classList.add("hidden");
  }
  if ($("sponsor-notice-input")) $("sponsor-notice-input").value = sponsorNotice;
}

async function loadSettings() {
  try {
    const response = await api("api/settings");
    if (!response.ok) return;
    const body = await response.json();
    sponsorNotice = String(body.sponsorNotice || "");
  } catch {
    sponsorNotice = "";
  }
  renderNotice();
}

$("sponsor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const org = selectedOrg();
  if (!org) return;
  const email = $("sponsor-email").value.trim();
  if (!email) {
    setStatus("Enter a public enquiry email address.", "error");
    $("sponsor-email").focus();
    return;
  }
  org.email = email;
  if (isAdmin()) {
    const name = $("sponsor-name").value.trim();
    if (!name) {
      setStatus("Enter a sponsor name.", "error");
      $("sponsor-name").focus();
      return;
    }
    org.name = name;
    org.subscribedAt = $("sponsor-started").value;
  }
  try {
    await saveOrganisations();
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("notice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isAdmin()) return;
  const notice = $("sponsor-notice-input").value.trim().slice(0, 400);
  try {
    const response = await api("api/settings", {
      method: "PUT",
      body: JSON.stringify({ sponsorNotice: notice }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "The notice could not be saved.");
    sponsorNotice = String(body.sponsorNotice || notice);
    renderNotice();
    setStatus("Notice saved. Every sponsor will see it after they sign in.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

async function createSponsorLogin(organisationId, username, password) {
  const response = await api("api/users", {
    method: "POST",
    body: JSON.stringify({ organisationId, username, password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The sponsor login was not created.");
}

function downloadBackup(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function downloadScope(scope) {
  const params = new URLSearchParams({ scope });
  if (scope === "sponsor") {
    if (!selectedOrgId) throw new Error("Choose a sponsor first.");
    params.set("organisationId", selectedOrgId);
  }
  const response = await api(`api/backup?${params}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The backup could not be downloaded.");
  const stamp = new Date().toISOString().slice(0, 10);
  const name = scope === "full"
    ? `touristqr-all-${stamp}.json`
    : `touristqr-${body.organisationId || "sponsor"}-${stamp}.json`;
  downloadBackup(name, body);
}

async function restoreFromFile(file, expectedKind) {
  const backup = JSON.parse(await file.text());
  if (backup.kind !== expectedKind) {
    throw new Error(expectedKind === "full"
      ? "That file is not a whole-catalogue backup."
      : "That file is not a sponsor backup.");
  }
  const backupOrgId = backup.organisationId || backup.organisations?.[0]?.id || "";
  if (expectedKind === "sponsor") {
    if (!selectedOrgId) throw new Error("Choose a sponsor first.");
    if (backupOrgId && backupOrgId !== selectedOrgId) {
      throw new Error("That backup is for a different sponsor.");
    }
  }
  const response = await api("api/restore", {
    method: "POST",
    body: JSON.stringify(backup),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Restore did not finish.");
  organisations = body.organisations;
  sites = body.sites;
  refreshAfterCatalogueChange();
}

$("new-sponsor").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isAdmin()) return;
  const name = $("new-sponsor-name").value.trim();
  const email = $("new-sponsor-email").value.trim();
  const username = $("new-sponsor-username").value.trim();
  const password = $("new-sponsor-password").value;
  const id = slugify(name);
  if (!id) {
    setStatus("Enter a sponsor name.", "error");
    return;
  }
  if (organisations.some((org) => org.id === id)) {
    setStatus("That sponsor is already in the list.", "error");
    selectSponsor(id);
    return;
  }
  const number = Math.max(0, ...organisations.map((org) => Number(org.number) || 0)) + 1;
  organisations.push({
    number,
    id,
    name,
    type: "Organisation",
    email,
    subscribedAt: todayISO(),
    createdAt: todayISO(),
  });
  try {
    await saveOrganisations();
    await createSponsorLogin(id, username, password);
    $("new-sponsor").reset();
    selectSponsor(id);
    setStatus(`${name} was added as sponsor ${number}, with login ${username}.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("new-sponsor-login").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isAdmin()) return;
  if (!selectedOrgId) {
    setStatus("Choose a sponsor first.", "error");
    return;
  }
  try {
    await createSponsorLogin(
      selectedOrgId,
      $("login-new-username").value.trim(),
      $("login-new-password").value,
    );
    $("new-sponsor-login").reset();
    setStatus("Sponsor login created.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("backup-all").addEventListener("click", async () => {
  try {
    await downloadScope("full");
    setStatus("Whole catalogue downloaded.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("backup-sponsor").addEventListener("click", async () => {
  try {
    await downloadScope("sponsor");
    setStatus("Sponsor backup downloaded.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("restore-all-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!window.confirm("Restore all replaces the current catalogue. Continue?")) return;
  try {
    await restoreFromFile(file, "full");
    setStatus("Restore complete. The previous catalogue was replaced.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("restore-sponsor-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!window.confirm("Restore this sponsor replaces that sponsor’s current records. Continue?")) return;
  try {
    await restoreFromFile(file, "sponsor");
    setStatus("Sponsor restore complete. The previous records for this sponsor were replaced.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginStatus("");
  try {
    const response = await api("api/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("login-username").value,
        password: $("login-password").value,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setLoginStatus(body.error || "Username or password is not correct.");
      return;
    }
    $("login-password").value = "";
    await enterApp(body.user);
  } catch {
    setLoginStatus("Admin login needs the TouristQR server running on this host (node server.mjs, or DreamIT Node.js).");
  }
});

$("sign-out").addEventListener("click", async () => {
  await api("api/logout", { method: "POST" }).catch(() => {});
  currentUser = null;
  selectedOrgId = "";
  showApp(false);
});

$("delete-site").addEventListener("click", async () => {
  if (!activeSiteId) return;
  const site = sites.find((item) => item.id === activeSiteId);
  if (!window.confirm(`Delete ${site?.name || "this site"}? Its photograph files stay in images so the numbers are not reused.`)) return;
  try {
    await saveSites(sites.filter((item) => item.id !== activeSiteId));
    hideSitePanel();
    setStatus("Site deleted from the catalogue.");
  } catch (error) {
    sites = sites.filter((item) => item.id !== activeSiteId);
    keepLocalCopy();
    hideSitePanel();
    refreshAfterCatalogueChange();
    setStatus(error.message);
  }
});

$("view-live").addEventListener("click", () => {
  const id = $("site-selector").value || $("siteId").value.trim();
  if (!selectedOrgId) {
    setStatus("Choose a sponsor first.");
    return;
  }
  if (!id) {
    setStatus("Choose a site, or enter a site id, to view it.");
    return;
  }
  const typedId = $("siteId").value.trim();
  if (typedId === id && !sites.some((site) => site.id === id) && $("siteName").value.trim()) {
    sites = [...sites, formPayload()];
    keepLocalCopy();
    renderSelector();
  }
  window.open(liveSiteUrl(id), "_blank", "noopener");
});

async function enterApp(user) {
  currentUser = user;
  const [siteResponse, orgResponse] = await Promise.all([
    api("api/sites"),
    api("api/organisations"),
  ]);
  if (!siteResponse.ok || !orgResponse.ok) {
    throw new Error("The catalogue could not be loaded.");
  }
  sites = await siteResponse.json();
  organisations = await orgResponse.json();
  showApp(true);
  renderTotals();
  renderSponsorOptions();
  if (isAdmin()) selectSponsor("");
  else selectSponsor(organisations[0]?.id || "");
  applyRoleUi();
  await loadSettings();
}

async function init() {
  try {
    const response = await detectApi();
    if (!response.ok) throw new Error("no-api");
    const body = await response.json();
    if (body.user) await enterApp(body.user);
    else showApp(false);
  } catch {
    showApp(false);
    setLoginStatus("Admin login could not reach the server. Upload api.php with the rest of the site, and make sure the data folder is writable.", "info");
  }
}

init();
