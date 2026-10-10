import { assetUrl, liveSiteUrl, sitePublicUrl } from "./config.js";
import {
  comparePhotoCodes,
  decadeLabel,
  findOrganisation,
  isListed,
  mergeById,
  subscriptionState,
} from "./model.js";
import { clearLocal, LOCAL_ORGS, LOCAL_SITES, readLocal, writeLocal } from "./storage.js";

const $ = (id) => document.getElementById(id);

let organisations = [];
let sites = [];
let draftPhotos = [];
let activeSiteId = "";

function setStatus(message) {
  $("admin-status").textContent = message || "";
}

function todayISO() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function selectedOrg() {
  return findOrganisation(organisations, $("siteOrg").value);
}

function listingText(site) {
  const org = findOrganisation(organisations, site.organisationId);
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
    organisationId: $("siteOrg").value,
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

function renderOrgs() {
  const list = $("org-list");
  list.replaceChildren();
  [...organisations].sort((a, b) => a.number - b.number).forEach((org) => {
    const card = document.createElement("form");
    card.className = "border border-slate-200 rounded-xl p-3 space-y-2";
    const title = document.createElement("div");
    title.className = "flex justify-between gap-2 text-sm";
    const name = document.createElement("strong");
    name.textContent = `${org.number} · ${org.name}`;
    const pill = document.createElement("span");
    pill.className = "text-xs text-slate-500";
    pill.textContent = statusLabel(org);
    title.append(name, pill);

    const email = document.createElement("input");
    email.type = "email";
    email.value = org.email;
    email.required = true;
    email.className = "w-full border rounded-xl p-2 text-sm";
    email.setAttribute("aria-label", `Email for ${org.name}`);

    const date = document.createElement("input");
    date.type = "date";
    date.value = org.subscribedAt;
    date.required = true;
    date.className = "w-full border rounded-xl p-2 text-sm";
    date.setAttribute("aria-label", `Subscription start for ${org.name}`);

    const save = document.createElement("button");
    save.type = "submit";
    save.className = "text-xs bg-slate-800 text-white px-3 py-2 rounded-xl";
    save.textContent = "Save sponsor";

    card.append(title, email, date, save);
    card.addEventListener("submit", async (event) => {
      event.preventDefault();
      org.email = email.value.trim();
      org.subscribedAt = date.value;
      try {
        await saveOrganisations();
      } catch (error) {
        keepLocalCopy();
        setStatus(`${error.message} The sponsor change is kept in this browser.`);
      }
    });
    list.append(card);
  });
}

function renderSelector() {
  const selector = $("site-selector");
  const current = selector.value;
  selector.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Choose a site";
  selector.append(blank);
  sites.forEach((site) => {
    const org = findOrganisation(organisations, site.organisationId);
    const option = document.createElement("option");
    option.value = site.id;
    option.textContent = `${site.name} · sponsor ${org?.number || "?"} · ${isListed(site, org) ? "public" : "archived"}`;
    selector.append(option);
  });
  selector.value = sites.some((site) => site.id === current) ? current : "";
}

function renderOrgOptions() {
  const select = $("siteOrg");
  const current = select.value;
  select.replaceChildren();
  [...organisations].sort((a, b) => a.number - b.number).forEach((org) => {
    const option = document.createElement("option");
    option.value = org.id;
    option.textContent = `${org.number} · ${org.name}`;
    select.append(option);
  });
  if (current) select.value = current;
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

function renderLibrary(photos) {
  const library = $("photo-library");
  library.replaceChildren();
  photos.forEach((photo) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "w-full flex items-center gap-3 text-left border border-slate-200 rounded-xl p-2 hover:bg-slate-50";
    const image = document.createElement("img");
    image.src = photoSrc(photo.url);
    image.alt = "";
    image.className = "w-14 h-14 object-cover rounded-lg bg-slate-200";
    const text = document.createElement("span");
    const code = document.createElement("span");
    code.className = "font-mono font-semibold block";
    code.textContent = photo.code;
    const detail = document.createElement("span");
    detail.className = "text-xs text-slate-500 block";
    detail.textContent = `${photo.siteName}${photo.kind ? ` · ${photo.kind}` : ""}`;
    text.append(code, detail);
    button.append(image, text);
    if (photo.siteId) button.addEventListener("click", () => loadSite(photo.siteId));
    library.append(button);
  });
}

function photoSrc(url) {
  if (!url || /^(https?:|data:|blob:)/.test(url)) return url || "";
  const [path, query] = String(url).split("?");
  const full = assetUrl(path);
  return query ? `${full}?${query}` : full;
}

function libraryFromSites() {
  const rows = [];
  for (const site of sites) {
    const org = findOrganisation(organisations, site.organisationId);
    for (const photo of photosInOrder(site.photos)) {
      rows.push({
        ...photo,
        siteId: site.id,
        siteName: site.name,
        sponsorNumber: org?.number ?? null,
      });
    }
  }
  return rows;
}

function photosInOrder(photos) {
  return [...(photos || [])].sort((a, b) => comparePhotoCodes(a.code, b.code));
}

function renderLibraryFromSites() {
  renderLibrary(libraryFromSites());
}

async function loadLibrary() {
  try {
    const response = await fetch(assetUrl("api/photos"));
    if (response.ok) {
      renderLibrary(await response.json());
      return;
    }
  } catch {
    // The published site has no photo API. The catalogue list is enough.
  }
  renderLibraryFromSites();
}

function slugify(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function renderAllQr() {
  const list = $("qr-list");
  list.replaceChildren();
  if (!sites.length) {
    const empty = document.createElement("p");
    empty.className = "text-sm text-slate-500 col-span-full";
    empty.textContent = "No sites yet. Enter one above and its QR code will appear here.";
    list.append(empty);
    return;
  }
  sites.forEach((site) => {
    const card = document.createElement("div");
    card.className = "border border-slate-200 rounded-xl p-3 text-center space-y-2";
    const canvas = document.createElement("canvas");
    canvas.className = "mx-auto";
    const title = document.createElement("p");
    title.className = "text-sm font-medium";
    title.textContent = site.name;
    const address = document.createElement("p");
    address.className = "text-[11px] text-slate-500 break-all font-mono";
    const target = sitePublicUrl(site.id);
    address.textContent = target;
    const download = document.createElement("a");
    download.className = "inline-block bg-slate-800 text-white text-xs px-3 py-1.5 rounded-lg";
    download.textContent = "Download";
    card.append(canvas, title, address, download);
    list.append(card);
    if (typeof QRious === "undefined") return;
    const qr = new QRious({ element: canvas, value: target, size: 160 });
    download.href = qr.toDataURL();
    download.download = `${site.id}-qr-code.png`;
  });
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
  $("siteOrg").value = site?.organisationId || organisations[0]?.id || "";
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
  draftPhotos = (site?.photos || []).map((photo) => ({ ...photo }));
  renderPhotoRows();
  refreshComputed();
  $("delete-site").classList.toggle("hidden", !site);
  if (site) generateQR(site.id);
}

function loadSite(id) {
  const site = sites.find((item) => item.id === id);
  if (!site) return;
  $("site-selector").value = id;
  fillForm(site);
}

function resizeImageFile(file) {
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
        if (!blob) reject(new Error("This photograph could not be resized."));
        else resolve(blob);
      }, "image/jpeg", 0.82);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Use a JPEG or PNG photograph."));
    };
    image.src = url;
  });
}

async function uploadPhoto(file, code) {
  const org = selectedOrg();
  if (!org) throw new Error("Choose a sponsor before adding a photograph.");
  const blob = await resizeImageFile(file);
  const params = new URLSearchParams({ sponsor: String(org.number) });
  if (code) params.set("code", code);
  const response = await fetch(`${assetUrl("api/media")}?${params}`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The photograph was not saved.");
  return body;
}

async function replacePhoto(index, file) {
  try {
    setStatus("Resizing photograph…");
    const saved = await uploadPhoto(file, draftPhotos[index].code);
    draftPhotos[index] = {
      ...draftPhotos[index],
      code: saved.code,
      url: saved.url,
      preview: `${saved.url}?t=${Date.now()}`,
    };
    renderPhotoRows();
    setStatus(`Replaced ${saved.code}. Save the site to keep it on the record.`);
    await loadLibrary();
  } catch (error) {
    setStatus(error.message);
  }
}

function formPayload() {
  const site = draftSite();
  return {
    ...site,
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

async function saveSites(nextSites) {
  const response = await fetch(assetUrl("api/sites"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextSites),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "This page cannot write the shared catalogue.");
  }
  sites = await response.json();
  clearLocal(LOCAL_SITES);
  renderSelector();
  renderAllQr();
  await loadLibrary();
}

async function saveOrganisations() {
  const response = await fetch(assetUrl("api/organisations"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(organisations),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "This page cannot write the shared catalogue.");
  }
  organisations = await response.json();
  clearLocal(LOCAL_ORGS);
  renderOrgs();
  renderOrgOptions();
  renderSelector();
  refreshComputed();
  setStatus("Sponsor saved.");
}

function keepLocalCopy() {
  writeLocal(LOCAL_SITES, sites);
  writeLocal(LOCAL_ORGS, organisations);
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

$("site-selector").addEventListener("change", () => {
  if ($("site-selector").value) loadSite($("site-selector").value);
});

$("new-site").addEventListener("click", () => {
  $("site-selector").value = "";
  fillForm(null);
  clearQr();
  setStatus("New site. Enter an id and a name, and its QR code will appear below.");
});

$("siteId").addEventListener("input", () => {
  if ($("siteId").readOnly) return;
  generateQR($("siteId").value.trim());
});

["siteYear", "siteYearStart", "siteCreated", "siteOrg", "siteCirca"].forEach((id) => {
  $(id).addEventListener("input", refreshComputed);
  $(id).addEventListener("change", refreshComputed);
});

$("add-photo").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    setStatus("Resizing photograph to about 1200 pixels…");
    const saved = await uploadPhoto(file);
    draftPhotos.push({
      code: saved.code,
      url: saved.url,
      preview: `${saved.url}?t=${Date.now()}`,
      caption: "",
      credit: "Demonstration photograph",
      kind: "current",
    });
    renderPhotoRows();
    setStatus(`Filed as ${saved.code}. Save the site to attach it.`);
    await loadLibrary();
  } catch (error) {
    setStatus(error.message);
  }
});

$("site-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = formPayload();
  if (!/^[a-z0-9-]{1,80}$/.test(payload.id)) {
    setStatus("Use a site id of lowercase letters, numbers, and hyphens.");
    return;
  }
  if (!payload.name) {
    setStatus("A site needs a name.");
    return;
  }
  if (!activeSiteId && sites.some((site) => site.id === payload.id)) {
    setStatus("That site id is already used.");
    return;
  }
  const next = activeSiteId
    ? sites.map((site) => (site.id === activeSiteId ? payload : site))
    : [...sites, payload];
  generateQR(payload.id, { scroll: true });
  try {
    await saveSites(next);
    activeSiteId = payload.id;
    $("site-selector").value = payload.id;
    $("siteId").readOnly = true;
    setStatus("Site saved. The QR code above is ready to download.");
  } catch (error) {
    sites = next;
    activeSiteId = payload.id;
    keepLocalCopy();
    renderSelector();
    renderAllQr();
    renderLibraryFromSites();
    $("site-selector").value = payload.id;
    $("siteId").readOnly = true;
    setStatus(`${error.message} The QR code is ready to download, and this browser can open the site with View live site.`);
  }
});

$("new-sponsor").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("new-sponsor-name").value.trim();
  const email = $("new-sponsor-email").value.trim();
  const id = slugify(name);
  if (!id) {
    setStatus("Enter a sponsor name.");
    return;
  }
  if (organisations.some((org) => org.id === id)) {
    setStatus("That sponsor is already in the list.");
    $("siteOrg").value = id;
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
  $("new-sponsor").reset();
  renderOrgOptions();
  $("siteOrg").value = id;
  refreshComputed();
  try {
    await saveOrganisations();
  } catch (error) {
    keepLocalCopy();
    renderOrgs();
    renderOrgOptions();
    $("siteOrg").value = id;
    setStatus(`${error.message} ${name} is saved in this browser as sponsor ${number}.`);
  }
});

$("delete-site").addEventListener("click", async () => {
  if (!activeSiteId) return;
  const site = sites.find((item) => item.id === activeSiteId);
  if (!window.confirm(`Delete ${site?.name || "this site"}? Its photograph files stay in images so the numbers are not reused.`)) return;
  try {
    await saveSites(sites.filter((item) => item.id !== activeSiteId));
    activeSiteId = "";
    fillForm(null);
    clearQr();
    setStatus("Site deleted from the catalogue.");
  } catch (error) {
    sites = sites.filter((item) => item.id !== activeSiteId);
    keepLocalCopy();
    renderSelector();
    renderAllQr();
    renderLibraryFromSites();
    activeSiteId = "";
    fillForm(null);
    clearQr();
    setStatus(error.message);
  }
});

$("view-live").addEventListener("click", () => {
  const id = $("site-selector").value || $("siteId").value.trim() || sites[0]?.id;
  if (!id) {
    setStatus("Choose a site, or enter a site id, to view it.");
    return;
  }
  const typedId = $("siteId").value.trim();
  if (typedId === id && !sites.some((site) => site.id === id) && $("siteName").value.trim()) {
    sites = [...sites, formPayload()];
    keepLocalCopy();
    renderSelector();
    renderAllQr();
  }
  window.open(liveSiteUrl(id), "_blank", "noopener");
});

async function init() {
  try {
    const [siteResponse, orgResponse] = await Promise.all([
      fetch(assetUrl("data/sites.json")),
      fetch(assetUrl("data/organisations.json")),
    ]);
    if (!siteResponse.ok || !orgResponse.ok) throw new Error("missing");
    sites = mergeById(await siteResponse.json(), readLocal(LOCAL_SITES));
    organisations = mergeById(await orgResponse.json(), readLocal(LOCAL_ORGS));
  } catch {
    setStatus("The site catalogue could not be loaded.");
    return;
  }
  renderOrgs();
  renderOrgOptions();
  renderSelector();
  renderAllQr();
  renderLibraryFromSites();
  if (sites[0]) loadSite(sites[0].id);
  else fillForm(null);
  loadLibrary();
}

init();
