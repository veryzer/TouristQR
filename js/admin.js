import { assetUrl, liveSiteUrl, sitePublicUrl } from "./config.js";
import {
  addMonths,
  categoriesForKind,
  comparePhotoCodes,
  decadeLabel,
  findOrganisation,
  formatPhotoCode,
  isListed,
  MAX_PHOTOS,
  nextPhotoCode,
  organisationKind,
  parseISODate,
  parsePhotoCode,
  shopGroupOf,
  subscriptionState,
  UNCATEGORISED,
  uniqueCategoryNames,
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
let workMode = "site";
let catalogueSettings = { heritageCategories: [], shopCategories: [] };
let syncingSelects = false;
let hasSponsorLogin = false;

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

function isShopOrg(org = selectedOrg()) {
  return organisationKind(org) === "shop";
}

function isShopRecord(org) {
  if (organisationKind(org) === "shop") return true;
  if (org?.shopGroup === "shops" || org?.shopGroup === "restaurants") return true;
  const type = String(org?.type || "").trim().toLowerCase();
  return type === "shop" || type === "restaurant";
}

function sponsorDisplayName(org) {
  const name = String(org?.name || "").trim();
  if (name) return name;
  const id = String(org?.id || "").trim();
  if (id) return id;
  if (org?.number) return `Sponsor ${org.number}`;
  return "Unnamed sponsor";
}

function organisationKey(org) {
  const id = String(org?.id || "").trim();
  if (id) return id;
  if (org?.number != null && org.number !== "") return `number:${org.number}`;
  return "";
}

function selectedShopGroup() {
  const checked = document.querySelector(".shop-group-radio:checked");
  return checked?.value === "restaurants" ? "restaurants" : "shops";
}

function setShopGroupRadios(value) {
  document.querySelectorAll(".shop-group-radio").forEach((input) => {
    input.checked = input.value === (value === "restaurants" ? "restaurants" : "shops");
  });
}

function currentCategoryList() {
  return categoriesForKind(workMode, catalogueSettings);
}

function fillCategorySelect(selected) {
  const select = $("siteCategory");
  if (!select) return;
  const names = currentCategoryList();
  const current = String(selected || select.value || "").trim();
  select.replaceChildren();
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Choose a category";
  select.append(blank);
  if (current && !names.includes(current)) {
    const extra = document.createElement("option");
    extra.value = current;
    extra.textContent = current;
    select.append(extra);
  }
  names.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  });
  select.value = names.includes(current) || current ? current : (workMode === "shop" ? "Shops" : "");
}

function applyWorkModeUi() {
  const shop = workMode === "shop";
  document.querySelectorAll(".heritage-only").forEach((el) => el.classList.toggle("hidden", shop));
  document.querySelectorAll(".shop-only").forEach((el) => el.classList.toggle("hidden", !shop));
  document.querySelectorAll(".site-sponsor-only").forEach((el) => el.classList.toggle("hidden", shop));
  document.querySelectorAll(".shop-sponsor-only").forEach((el) => el.classList.toggle("hidden", !shop));
  if ($("work-sites")) {
    $("work-sites").className = `text-xs px-3 py-2 rounded-xl font-medium ${shop ? "bg-white border border-slate-300 text-slate-700" : "bg-slate-800 text-white"}`;
    $("work-shops").className = `text-xs px-3 py-2 rounded-xl font-medium ${shop ? "bg-slate-800 text-white" : "bg-white border border-slate-300 text-slate-700"}`;
  }
  if ($("add-sponsor-title")) $("add-sponsor-title").textContent = shop ? "Add shop sponsor" : "Add site sponsor";
  if ($("category-editor-title")) $("category-editor-title").textContent = "Site categories";
  if ($("site-form-title")) $("site-form-title").textContent = shop ? "Public shop page" : "Add / modify historic site";
  if ($("site-id-label")) $("site-id-label").textContent = shop ? "Shop ID (permanent)" : "Site ID (permanent)";
  if ($("site-name-label")) $("site-name-label").textContent = shop ? "Shop name" : "Place name";
  if ($("site-year-label")) $("site-year-label").textContent = shop ? "Established" : "Build year";
  if ($("site-maps-label")) $("site-maps-label").textContent = shop ? "Address" : "Google Maps query";
  if ($("site-desc-label")) $("site-desc-label").textContent = shop ? "Description" : "History";
  if ($("save-site-button")) $("save-site-button").textContent = shop ? "Save shop and generate QR code" : "Save site and generate QR code";
  if ($("qr-section-title")) $("qr-section-title").textContent = shop ? "QR code for this shop" : "QR code for this site";
  if ($("siteId")) $("siteId").placeholder = shop ? "little-malop-books" : "moorabool-wool-exchange";
  if ($("delete-site")) $("delete-site").textContent = shop ? "Delete shop listing" : "Delete site";
  if ($("new-sponsor-email")) $("new-sponsor-email").required = !shop;
  if ($("sponsor-email")) $("sponsor-email").required = !shop;
  if ($("site-nav-wrap")) $("site-nav-wrap").classList.toggle("hidden", shop);
  fillCategorySelect($("siteCategory")?.value);
  renderCategoryEditor();
}

function validateSiteForm() {
  const id = $("siteId").value.trim();
  const shop = isShopOrg();
  if (!selectedOrgId) return { ok: false, message: "Choose a sponsor first." };
  if (!id) return { ok: false, message: shop ? "Enter a permanent shop id." : "Enter a permanent site id (for example old-mill).", fieldId: "siteId" };
  if (!/^[a-z0-9-]{1,80}$/.test(id)) {
    return { ok: false, message: "The id can only use lowercase letters, numbers, and hyphens.", fieldId: "siteId" };
  }
  if (!$("siteName").value.trim()) return { ok: false, message: "Enter the place name.", fieldId: "siteName" };
  if (!$("siteYear").value.trim()) {
    return { ok: false, message: shop ? "Enter the established year." : "Enter the build year (or an approximate year).", fieldId: "siteYear" };
  }
  if (!$("siteMaps").value.trim()) {
    return { ok: false, message: shop ? "Enter the address so visitors can open Navigate." : "Enter a Google Maps search or address so visitors can open Navigate.", fieldId: "siteMaps" };
  }
  if (!$("siteDesc").value.trim()) {
    return { ok: false, message: shop ? "Enter the description." : "Enter the site history text.", fieldId: "siteDesc" };
  }
  if (!$("siteCreated").value) return { ok: false, message: "Choose the listing created date.", fieldId: "siteCreated" };
  if (!activeSiteId && sites.some((site) => site.id === id)) {
    return { ok: false, message: "That id is already used. Pick another id.", fieldId: "siteId" };
  }
  if (shop && !activeSiteId && sitesForSelectedSponsor().length) {
    return { ok: false, message: "A shop sponsor can have only one listing." };
  }
  if (draftPhotos.length > MAX_PHOTOS) {
    return { ok: false, message: `A listing can have at most ${MAX_PHOTOS} photographs.` };
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
  return organisations.find((org) => organisationKey(org) === selectedOrgId || org.id === selectedOrgId) || null;
}

function sitesForSelectedSponsor() {
  const org = selectedOrg();
  const orgId = org?.id || selectedOrgId;
  if (!orgId) return [];
  return sites.filter((site) => site.organisationId === orgId);
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
  const shop = isShopOrg();
  if (shop && $("siteCityVisible")) $("siteCity").value = $("siteCityVisible").value;
  return {
    id: $("siteId").value.trim(),
    organisationId: selectedOrg()?.id || selectedOrgId,
    name: $("siteName").value.trim(),
    buildYear: yearText,
    yearStart: Number($("siteYearStart").value) || fromText || null,
    yearEnd: Number($("siteYearEnd").value) || fromText || null,
    circa: shop ? false : $("siteCirca").checked,
    createdAt: $("siteCreated").value,
    category: $("siteCategory").value.trim(),
    shopGroup: shop ? selectedShopGroup() : "",
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

function sortByExpiryChecked() {
  return Boolean($("sort-by-expiry")?.checked || $("sort-shop-by-expiry")?.checked);
}

function sortedOrganisations(kind = workMode) {
  const list = organisations.filter((org) => (kind === "shop" ? isShopRecord(org) : !isShopRecord(org)));
  const byName = (a, b) => sponsorDisplayName(a).localeCompare(sponsorDisplayName(b), undefined, { sensitivity: "base" });
  if (sortByExpiryChecked()) {
    list.sort((a, b) => {
      const aDate = publicUntilIso(a.subscribedAt) || "9999-99-99";
      const bDate = publicUntilIso(b.subscribedAt) || "9999-99-99";
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return byName(a, b);
    });
    return list;
  }
  return list.sort(byName);
}

function sponsorOptionLabel(org) {
  const until = publicUntilIso(org.subscribedAt);
  const untilText = until ? ` · public until ${formatDay(until)}` : "";
  return `${sponsorDisplayName(org)} · ${statusLabel(org)}${untilText}`;
}

function renderTotals() {
  const el = $("catalogue-totals");
  if (!el) return;
  const siteSponsors = organisations.filter((org) => organisationKind(org) === "site").length;
  const shopSponsors = organisations.filter((org) => organisationKind(org) === "shop").length;
  const historic = sites.filter((site) => organisationKind(findOrganisation(organisations, site.organisationId)) === "site").length;
  const shops = sites.length - historic;
  const photos = photoCount();
  el.textContent = `${siteSponsors} site sponsor${siteSponsors === 1 ? "" : "s"} · ${shopSponsors} shop sponsor${shopSponsors === 1 ? "" : "s"} · ${historic} site${historic === 1 ? "" : "s"} · ${shops} shop listing${shops === 1 ? "" : "s"} · ${photos} photograph${photos === 1 ? "" : "s"}`;
}

function fillSponsorSelect(selectId, kind) {
  const selector = $(selectId);
  if (!selector) return;
  syncingSelects = true;
  try {
    selector.replaceChildren();
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Choose a sponsor";
    selector.append(blank);
    sortedOrganisations(kind).forEach((org) => {
      const key = organisationKey(org);
      if (!key) return;
      const option = document.createElement("option");
      option.value = key;
      option.textContent = sponsorOptionLabel(org);
      selector.append(option);
    });
    const org = selectedOrg();
    const selectedKind = org ? (isShopRecord(org) ? "shop" : "site") : "";
    selector.value = org && selectedKind === kind ? organisationKey(org) : "";
  } finally {
    syncingSelects = false;
  }
}

function renderSponsorOptions() {
  fillSponsorSelect("sponsor-selector", "site");
  fillSponsorSelect("shop-sponsor-selector", "shop");
}

function renderSponsorPanel() {
  const org = selectedOrg();
  $("sponsor-panel").classList.toggle("hidden", !org);
  if (!org) {
    hideSitePanel();
    return;
  }
  $("sponsor-heading").textContent = `${org.number || "–"} · ${sponsorDisplayName(org)}`;
  $("sponsor-status-pill").textContent = statusLabel(org);
  if ($("sponsor-name")) $("sponsor-name").value = String(org.name || "").trim() || sponsorDisplayName(org);
  if ($("sponsor-contact-name")) $("sponsor-contact-name").value = org.contactName || "";
  if ($("sponsor-contact-email")) $("sponsor-contact-email").value = org.contactEmail || "";
  $("sponsor-email").value = org.email || "";
  loadSponsorLogin(org.id);
  $("sponsor-started").value = org.subscribedAt || "";
  setShopGroupRadios(shopGroupOf(org));
  applyWorkModeUi();
  const mine = sitesForSelectedSponsor();
  const publicCount = mine.filter((site) => isListed(site, org)).length;
  const photos = photoCount(mine);
  const until = publicUntilIso(org.subscribedAt);
  const listingWord = isShopOrg(org) ? "listing" : "site";
  $("sponsor-report").textContent = `${statusLabel(org)} · started ${formatDay(org.subscribedAt)} · public listing ends ${formatDay(until)} · ${mine.length} ${listingWord}${mine.length === 1 ? "" : "s"} · ${publicCount} on the public list · ${photos} photograph${photos === 1 ? "" : "s"}`;
  $("site-sponsor-label").textContent = sponsorDisplayName(org);
  const shop = isShopOrg(org);
  if ($("site-nav-wrap")) $("site-nav-wrap").classList.toggle("hidden", shop);
  if ($("site-selector-wrap")) $("site-selector-wrap").classList.toggle("hidden", shop);
  if ($("new-site")) $("new-site").classList.toggle("hidden", shop);
  if ($("new-site")) $("new-site").textContent = shop ? "+ Add this shop" : "+ Next new site";
  renderSelector();
}

function uniqueListingId(preferred) {
  let id = slugify(preferred) || "shop";
  if (!sites.some((site) => site.id === id)) return id;
  let n = 2;
  while (sites.some((site) => site.id === `${id}-${n}`)) n += 1;
  return `${id}-${n}`;
}

function openBlankListingEditor(org) {
  fillForm(null);
  if ($("siteName")) $("siteName").value = org?.name || "";
  if (isShopOrg(org)) {
    if ($("siteId")) $("siteId").value = uniqueListingId(org.id || org.name);
    setListingIdLocked(true);
  } else {
    setListingIdLocked(false);
  }
  $("site-sponsor-label").textContent = org?.name || "";
  generateQR($("siteId")?.value.trim() || "");
  showSitePanel();
}

function openSponsorListingEditor(org, { keepSite = false } = {}) {
  if (!org) return;
  const mine = sitesForSelectedSponsor();
  if (isShopOrg(org)) {
    if (mine.length) loadSite(mine[0].id);
    else openBlankListingEditor(org);
    return;
  }
  if (mine.length === 0) {
    openBlankListingEditor(org);
    return;
  }
  if (keepSite && mine.some((site) => site.id === activeSiteId)) {
    loadSite(activeSiteId);
    return;
  }
  if (mine.length === 1) {
    loadSite(mine[0].id);
    return;
  }
  hideSitePanel();
}

function selectSponsor(id, { keepSite = false } = {}) {
  selectedOrgId = organisations.some((org) => organisationKey(org) === id || org.id === id) ? id : "";
  const org = selectedOrg();
  if (org) workMode = organisationKind(org);
  renderSponsorOptions();
  renderSponsorPanel();
  if (!org) return;
  openSponsorListingEditor(org, { keepSite });
}

function hideSitePanel() {
  $("site-panel").classList.add("hidden");
  activeSiteId = "";
  syncingSelects = true;
  if ($("site-selector")) $("site-selector").value = "";
  syncingSelects = false;
  fillForm(null);
  clearQr();
}

function showSitePanel() {
  $("site-panel").classList.remove("hidden");
}

function renderSelector() {
  const selector = $("site-selector");
  const current = selector.value;
  syncingSelects = true;
  try {
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
  } finally {
    syncingSelects = false;
  }
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
    empty.textContent = isShopOrg() ? "No photographs on this listing yet. Add them for the public gallery." : "No photographs on this site yet.";
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
    caption.placeholder = isShopOrg() ? "Caption shown with the picture" : "Caption";
    caption.className = "w-full border rounded-xl p-2 text-sm";
    caption.addEventListener("input", () => {
      draftPhotos[index].caption = caption.value;
    });

    const kind = document.createElement("select");
    kind.className = "border rounded-xl p-2 text-sm bg-white";
    for (const value of ["current", "historical"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "historical" ? (isShopOrg() ? "Shop front" : "Historical") : "Current";
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
    remove.textContent = isShopOrg() ? "Remove from listing" : "Remove from site";
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

function wrapCanvasLines(ctx, text, maxWidth) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    if (ctx.measureText(word).width <= maxWidth) {
      line = word;
      continue;
    }
    let piece = "";
    for (const letter of word) {
      const trial = piece + letter;
      if (ctx.measureText(trial).width <= maxWidth) piece = trial;
      else {
        if (piece) lines.push(piece);
        piece = letter;
      }
    }
    line = piece;
  }
  if (line) lines.push(line);
  return lines;
}

function drawQrArtwork(target, qrCanvas, title) {
  const qrSize = 520;
  const pad = 44;
  const border = 8;
  const brand = "TouristQR";
  const brandSize = 34;
  const titleSize = 32;
  const titleLine = 40;
  const gap = 22;
  const ink = "#0f172a";
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `700 ${titleSize}px "Segoe UI", Arial, sans-serif`;
  const lines = wrapCanvasLines(measure, title, qrSize);
  const width = qrSize + pad * 2;
  const height = pad + qrSize + gap + brandSize + 12 + lines.length * titleLine + pad;
  target.width = width;
  target.height = height;
  const ctx = target.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = ink;
  ctx.lineWidth = border;
  ctx.strokeRect(border / 2 + 10, border / 2 + 10, width - border - 20, height - border - 20);
  ctx.drawImage(qrCanvas, pad, pad, qrSize, qrSize);
  ctx.fillStyle = ink;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  let y = pad + qrSize + gap;
  ctx.font = `700 ${brandSize}px "Segoe UI", Arial, sans-serif`;
  ctx.fillText(brand, width / 2, y);
  y += brandSize + 12;
  ctx.font = `700 ${titleSize}px "Segoe UI", Arial, sans-serif`;
  for (const line of lines) {
    ctx.fillText(line, width / 2, y);
    y += titleLine;
  }
}

function clearQr() {
  const canvas = $("qr-canvas");
  canvas.width = 220;
  canvas.height = 220;
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  $("qr-target-url").textContent = "Enter a site id to show its QR code.";
  $("download-qr").removeAttribute("href");
}

function setListingIdLocked(locked) {
  const input = $("siteId");
  if (!input) return;
  input.readOnly = Boolean(locked);
}

function fillForm(site) {
  activeSiteId = site?.id || "";
  $("siteId").value = site?.id || "";
  setListingIdLocked(Boolean(site) || (isShopOrg() && Boolean(site?.id)));
  $("siteName").value = site?.name || "";
  $("siteYear").value = site?.buildYear || "";
  $("siteCirca").checked = Boolean(site?.circa);
  fillCategorySelect(site?.category || (isShopOrg() ? "Shops" : ""));
  $("siteSuburb").value = site?.suburb || "";
  $("siteMapArea").value = site?.mapArea || "";
  $("siteMaps").value = site?.mapsQuery || "";
  $("siteDesc").value = site?.description || "";
  $("siteCountry").value = site?.country || "Australia";
  $("siteState").value = site?.state || "Victoria";
  $("siteCity").value = site?.city || "Geelong";
  if ($("siteCityVisible")) $("siteCityVisible").value = site?.city || "Geelong";
  $("siteYearStart").value = site?.yearStart || "";
  $("siteYearEnd").value = site?.yearEnd || "";
  $("siteCreated").value = site?.createdAt || todayISO();
  $("siteFacts").value = (site?.facts || []).join("\n");
  $("siteReading").value = site?.furtherReading || "";
  if ($("siteReadingShop")) $("siteReadingShop").value = site?.furtherReading || "";
  $("siteSources").value = (site?.sources || []).join("\n");
  setShopGroupRadios(shopGroupOf(selectedOrg(), site));
  draftPhotos = photosInOrder(site?.photos || []).map((photo) => ({ ...photo }));
  $("site-sponsor-label").textContent = selectedOrg()?.name || "";
  renderPhotoRows();
  refreshComputed();
  $("delete-site").classList.toggle("hidden", !site || (isShopOrg() && !isAdmin()));
  if (site) generateQR(site.id);
}

function loadSite(id) {
  const site = sitesForSelectedSponsor().find((item) => item.id === id);
  if (!site) return;
  syncingSelects = true;
  $("site-selector").value = id;
  syncingSelects = false;
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
    setStatus(`Replaced ${saved.code} ${where}. Click ${isShopOrg() ? "Save shop" : "Save site"} to keep it on this record.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function formPayload() {
  const site = draftSite();
  const shop = isShopOrg();
  if (shop && $("siteCityVisible")) $("siteCity").value = $("siteCityVisible").value;
  return {
    ...site,
    organisationId: selectedOrg()?.id || selectedOrgId,
    country: $("siteCountry").value.trim() || "Australia",
    state: $("siteState").value.trim() || "Victoria",
    city: $("siteCity").value.trim(),
    suburb: $("siteSuburb").value.trim(),
    mapArea: shop ? "" : $("siteMapArea").value.trim(),
    mapsQuery: $("siteMaps").value.trim(),
    description: $("siteDesc").value.trim(),
    facts: shop ? [] : $("siteFacts").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    furtherReading: shop ? ($("siteReadingShop")?.value.trim() || "") : $("siteReading").value.trim(),
    sources: shop ? [] : $("siteSources").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
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
  if (selectedOrgId && organisations.some((org) => organisationKey(org) === selectedOrgId || org.id === selectedOrgId)) {
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
  const title = $("siteName").value.trim() || id;
  $("qr-target-url").textContent = target;
  const qrSource = document.createElement("canvas");
  new QRious({
    element: qrSource,
    value: target,
    size: 520,
    background: "#ffffff",
    foreground: "#0f172a",
  });
  drawQrArtwork($("qr-canvas"), qrSource, title);
  $("download-qr").href = $("qr-canvas").toDataURL("image/png");
  $("download-qr").download = `${id}-qr-code.png`;
  if (scroll) $("qr-section").scrollIntoView({ block: "nearest" });
}

$("sponsor-selector")?.addEventListener("change", () => {
  if (syncingSelects) return;
  selectSponsor($("sponsor-selector").value);
});

$("shop-sponsor-selector")?.addEventListener("change", () => {
  if (syncingSelects) return;
  selectSponsor($("shop-sponsor-selector").value);
});

document.querySelectorAll(".expiry-sort").forEach((box) => {
  box.addEventListener("change", () => {
    document.querySelectorAll(".expiry-sort").forEach((other) => {
      other.checked = box.checked;
    });
    renderSponsorOptions();
  });
});

$("work-sites")?.addEventListener("click", () => setWorkMode("site"));
$("work-shops")?.addEventListener("click", () => setWorkMode("shop"));
$("add-category")?.addEventListener("click", () => addCategory());
$("category-pick")?.addEventListener("change", syncCategoryEditorFields);
$("rename-category")?.addEventListener("click", () => {
  renameCategory($("category-pick")?.value, $("category-rename-name")?.value);
});
$("delete-category")?.addEventListener("click", () => {
  removeCategory($("category-pick")?.value);
});
$("new-category-name")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addCategory();
  }
});

$("site-selector").addEventListener("change", () => {
  if (syncingSelects) return;
  if ($("site-selector").value) loadSite($("site-selector").value);
  else hideSitePanel();
});

$("new-site").addEventListener("click", () => {
  if (!selectedOrgId) {
    setStatus("Choose a sponsor first.", "error");
    return;
  }
  if (isShopOrg() && sitesForSelectedSponsor().length) {
    setStatus("A shop sponsor can have only one listing.", "error");
    return;
  }
  syncingSelects = true;
  $("site-selector").value = "";
  syncingSelects = false;
  fillForm(null);
  clearQr();
  showSitePanel();
  setStatus(isShopOrg() ? "New shop. Enter an id and a name, and its QR code will appear below." : "New site. Enter an id and a name, and its QR code will appear below.");
});

$("siteId").addEventListener("input", () => {
  if ($("siteId").readOnly) return;
  generateQR($("siteId").value.trim());
});

$("siteName").addEventListener("input", () => {
  const id = $("siteId").value.trim();
  if (id) generateQR(id);
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
  if (draftPhotos.length >= MAX_PHOTOS) {
    setStatus(`A listing can have at most ${MAX_PHOTOS} photographs.`, "error");
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
    setStatus(`Added ${saved.code} to this ${isShopOrg() ? "listing" : "site"} (${where}). Click ${isShopOrg() ? "Save shop" : "Save site"} when you are finished editing.`, "success");
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
  if (isShopOrg()) {
    const org = selectedOrg();
    if (org) org.shopGroup = payload.shopGroup;
  }
  const next = activeSiteId
    ? sites.map((site) => (site.id === activeSiteId ? payload : site))
    : [...sites, payload];
  generateQR(payload.id, { scroll: true });
  setStatus(isShopOrg() ? "Saving shop…" : "Saving site…", "info");
  activeSiteId = payload.id;
  syncingSelects = true;
  $("site-selector").value = payload.id;
  syncingSelects = false;
  setListingIdLocked(true);
  try {
    await saveSites(next);
    if (isShopOrg()) await saveOrganisations();
    setStatus(isShopOrg()
      ? "Shop saved on the server. The QR code below is ready to download."
      : "Site saved on the server. The QR code below is ready to download.", "success");
    $("qr-section").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (error) {
    try {
      persistSitesLocally(
        next,
        `${isShopOrg() ? "Shop" : "Site"} saved in this browser. ${error.message} Use View live site on this device to check it. When the server is running, save again to publish for everyone.`,
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
    catalogueSettings = {
      heritageCategories: uniqueCategoryNames(body.heritageCategories, ["Civic", "Industrial", "Recreation", "Transport"]),
      shopCategories: uniqueCategoryNames(body.shopCategories, ["Restaurants", "Shops"]),
    };
  } catch {
    sponsorNotice = "";
  }
  renderNotice();
  applyWorkModeUi();
}

async function saveCategoryLists() {
  const response = await api("api/settings", {
    method: "PUT",
    body: JSON.stringify({
      sponsorNotice,
      heritageCategories: catalogueSettings.heritageCategories,
      shopCategories: catalogueSettings.shopCategories,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The category list could not be saved.");
  catalogueSettings = {
    heritageCategories: uniqueCategoryNames(body.heritageCategories, catalogueSettings.heritageCategories),
    shopCategories: uniqueCategoryNames(body.shopCategories, catalogueSettings.shopCategories),
  };
}

function categoryListKey() {
  return "heritageCategories";
}

function isHeritageListing(site) {
  return organisationKind(findOrganisation(organisations, site.organisationId)) !== "shop";
}

function syncCategoryEditorFields() {
  const name = $("category-pick")?.value || "";
  if ($("category-rename-name")) $("category-rename-name").value = name;
  if ($("delete-category")) $("delete-category").disabled = !name || name === UNCATEGORISED;
}

function renderCategoryEditor() {
  const select = $("category-pick");
  if (!select) return;
  const names = categoriesForKind("site", catalogueSettings);
  const previous = select.value;
  select.replaceChildren();
  names.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  });
  select.value = names.includes(previous) ? previous : (names[0] || "");
  syncCategoryEditorFields();
}

async function renameCategory(from, to) {
  const nextName = String(to || "").trim();
  if (!nextName || nextName === from) return;
  const key = categoryListKey();
  if (catalogueSettings[key].some((name) => name.toLowerCase() === nextName.toLowerCase() && name !== from)) {
    setStatus("That category is already in the list.", "error");
    return;
  }
  catalogueSettings[key] = uniqueCategoryNames(catalogueSettings[key].map((name) => (name === from ? nextName : name)));
  sites = sites.map((site) => (isHeritageListing(site) && site.category === from ? { ...site, category: nextName } : site));
  try {
    await saveCategoryLists();
    await saveSites(sites);
    if (workMode !== "shop") fillCategorySelect(nextName);
    renderCategoryEditor();
    if ($("category-pick")) $("category-pick").value = nextName;
    syncCategoryEditorFields();
    setStatus(`Renamed ${from} to ${nextName}. Historic sites that used it were updated.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function removeCategory(name) {
  if (name === UNCATEGORISED) return;
  if (!window.confirm(`Delete ${name}? Historic sites in that category become Uncategorised.`)) return;
  const key = categoryListKey();
  catalogueSettings[key] = uniqueCategoryNames(catalogueSettings[key].filter((item) => item !== name).concat(UNCATEGORISED));
  sites = sites.map((site) => (isHeritageListing(site) && site.category === name ? { ...site, category: UNCATEGORISED } : site));
  try {
    await saveCategoryLists();
    await saveSites(sites);
    if (workMode !== "shop") fillCategorySelect(UNCATEGORISED);
    renderCategoryEditor();
    if ($("category-pick")) $("category-pick").value = UNCATEGORISED;
    syncCategoryEditorFields();
    setStatus(`${name} was removed. Those historic sites are now Uncategorised.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function addCategory() {
  const name = $("new-category-name").value.trim();
  if (!name) return;
  const key = categoryListKey();
  if (catalogueSettings[key].some((item) => item.toLowerCase() === name.toLowerCase())) {
    setStatus("That category is already in the list.", "error");
    return;
  }
  catalogueSettings[key] = uniqueCategoryNames([...catalogueSettings[key], name]);
  try {
    await saveCategoryLists();
    $("new-category-name").value = "";
    if (workMode !== "shop") fillCategorySelect(name);
    renderCategoryEditor();
    if ($("category-pick")) $("category-pick").value = name;
    syncCategoryEditorFields();
    setStatus(`${name} was added to the list.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function setWorkMode(mode) {
  workMode = mode === "shop" ? "shop" : "site";
  applyWorkModeUi();
}

let loginLoadToken = 0;

function clearSponsorLoginFields() {
  if ($("sponsor-login-password")) $("sponsor-login-password").value = "";
  if ($("sponsor-login-name")) $("sponsor-login-name").value = "";
}

async function loadSponsorLogin(organisationId) {
  const token = ++loginLoadToken;
  clearSponsorLoginFields();
  hasSponsorLogin = false;
  if (!organisationId) return;
  try {
    const response = await api(`api/users?organisationId=${encodeURIComponent(organisationId)}`);
    const body = await response.json().catch(() => ({}));
    if (token !== loginLoadToken) return;
    hasSponsorLogin = Boolean(body.username);
  } catch {
    if (token !== loginLoadToken) return;
    hasSponsorLogin = false;
  }
}

function loginNameOk(value) {
  return /^[a-z0-9._-]{3,40}$/.test(String(value || "").trim().toLowerCase());
}

async function saveSponsorLogin(username = "", password = "") {
  username = String(username || "").trim().toLowerCase();
  password = String(password || "");
  if (!username && !password) return;
  if (username && !loginNameOk(username)) {
    throw new Error("A login name uses 3–40 letters, numbers, dots, hyphens, or underscores.");
  }
  if (password && password.length < 8) throw new Error("A new password needs at least 8 characters.");
  if (!hasSponsorLogin && (!username || !password)) {
    throw new Error("A new login needs both a login name and a password.");
  }
  const response = await api("api/users", {
    method: "PUT",
    body: JSON.stringify({ organisationId: selectedOrgId, username, password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The login could not be saved.");
  hasSponsorLogin = true;
  clearSponsorLoginFields();
  if (username && currentUser?.organisationId === selectedOrgId) {
    currentUser.username = body.username || username;
    applyRoleUi();
  }
}

$("sponsor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const org = selectedOrg();
  if (!org) return;
  const name = ($("sponsor-name")?.value || "").trim();
  if (!name) {
    setStatus("Enter the business name shown on the public page.", "error");
    $("sponsor-name").focus();
    return;
  }
  const email = isShopOrg(org) ? (org.email || "") : $("sponsor-email").value.trim();
  if (!isShopOrg(org) && !email) {
    setStatus("Enter a public contact email address.", "error");
    $("sponsor-email").focus();
    return;
  }
  const loginName = ($("sponsor-login-name")?.value || "").trim().toLowerCase();
  const loginPassword = $("sponsor-login-password")?.value || "";
  if (loginName && !loginNameOk(loginName)) {
    setStatus("A login name uses 3–40 letters, numbers, dots, hyphens, or underscores.", "error");
    $("sponsor-login-name")?.focus();
    return;
  }
  if (loginPassword && loginPassword.length < 8) {
    setStatus("A new password needs at least 8 characters.", "error");
    $("sponsor-login-password")?.focus();
    return;
  }
  if (!hasSponsorLogin && (loginName || loginPassword) && (!loginName || !loginPassword)) {
    setStatus("A new login needs both a login name and a password.", "error");
    (loginName ? $("sponsor-login-password") : $("sponsor-login-name"))?.focus();
    return;
  }
  org.name = name;
  org.email = email;
  org.contactName = ($("sponsor-contact-name")?.value || "").trim();
  org.contactEmail = ($("sponsor-contact-email")?.value || "").trim();
  if (isShopOrg(org)) org.shopGroup = selectedShopGroup();
  if (isAdmin()) org.subscribedAt = $("sponsor-started").value;
  try {
    await saveOrganisations();
    if (loginName || loginPassword) {
      await saveSponsorLogin(loginName, loginPassword);
      setStatus("Sponsor saved. Login details were updated.", "success");
    }
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
  const email = workMode === "shop" ? "" : $("new-sponsor-email").value.trim();
  const contactName = ($("new-sponsor-contact-name")?.value || "").trim();
  const contactEmail = ($("new-sponsor-contact-email")?.value || "").trim();
  const username = $("new-sponsor-username").value.trim();
  const password = $("new-sponsor-password").value;
  const id = slugify(name);
  if (!id) {
    setStatus("Enter the business name shown on the public page.", "error");
    return;
  }
  if (organisations.some((org) => org.id === id)) {
    setStatus("That sponsor is already in the list.", "error");
    selectSponsor(id);
    return;
  }
  const number = Math.max(0, ...organisations.map((org) => Number(org.number) || 0)) + 1;
  if (workMode !== "shop" && !email) {
    setStatus("Enter a public contact email address.", "error");
    return;
  }
  organisations.push({
    number,
    id,
    name,
    type: workMode === "shop" ? "Shop" : "Organisation",
    kind: workMode,
    ...(workMode === "shop" ? { shopGroup: "shops" } : {}),
    email,
    contactName,
    contactEmail,
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

$("delete-sponsor")?.addEventListener("click", async () => {
  if (!isAdmin()) return;
  const org = selectedOrg();
  if (!org) {
    setStatus("Choose a sponsor first.", "error");
    return;
  }
  const mine = sitesForSelectedSponsor();
  const listingWord = isShopOrg(org) ? "shop listing" : "site";
  const listingCount = `${mine.length} ${listingWord}${mine.length === 1 ? "" : "s"}`;
  if (!window.confirm(`Delete ${org.name}?\n\nThis removes the sponsor and their login.`)) return;
  const deleteListings = mine.length
    ? window.confirm(`Also delete ${listingCount} for ${org.name}?\n\nOK deletes the ${listingWord}${mine.length === 1 ? "" : "s"} and their public QR pages. Cancel keeps those records.\n\nPhotograph files stay in images so the numbers are not reused.`)
    : false;
  try {
    const response = await api("api/delete-sponsor", {
      method: "POST",
      body: JSON.stringify({ organisationId: org.id, deleteListings }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "The sponsor could not be deleted.");
    organisations = body.organisations || organisations.filter((item) => item.id !== org.id);
    sites = body.sites || (deleteListings ? sites.filter((site) => site.organisationId !== org.id) : sites);
    selectedOrgId = "";
    activeSiteId = "";
    refreshAfterCatalogueChange();
    setStatus(deleteListings
      ? `${org.name} was deleted, including their ${listingWord}${mine.length === 1 ? "" : "s"}. Photograph files were left in images.`
      : mine.length
        ? `${org.name} was deleted. Their ${listingWord}${mine.length === 1 ? " was" : "s were"} kept.`
        : `${org.name} was deleted.`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

$("delete-site").addEventListener("click", async () => {
  if (!activeSiteId) return;
  const site = sites.find((item) => item.id === activeSiteId);
  const shop = isShopOrg();
  if (!window.confirm(`Delete ${site?.name || (shop ? "this shop" : "this site")}? Its photograph files stay in images so the numbers are not reused.`)) return;
  try {
    await saveSites(sites.filter((item) => item.id !== activeSiteId));
    if (!shop) hideSitePanel();
    setStatus(shop ? "Shop listing deleted from the catalogue." : "Site deleted from the catalogue.");
  } catch (error) {
    sites = sites.filter((item) => item.id !== activeSiteId);
    keepLocalCopy();
    if (!shop) hideSitePanel();
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
  workMode = isAdmin() ? "site" : organisationKind(organisations[0]);
  applyWorkModeUi();
  renderTotals();
  renderSponsorOptions();
  if (isAdmin()) selectSponsor("");
  else {
    selectSponsor(currentUser.organisationId || organisations[0]?.id || "");
    if (!selectedOrg()) {
      setStatus("This login is not linked to a sponsor record. Ask the site admin to save the login on that sponsor.", "error");
    }
  }
  applyRoleUi();
  await loadSettings();
  if (!isAdmin() && selectedOrg()) openSponsorListingEditor(selectedOrg(), { keepSite: true });
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
