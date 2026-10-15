import { assetUrl, genericPublicUrl, liveSiteUrl, sitePublicUrl } from "./config.js?v=admin19";
import { prepareLogoFile, preparePhotoFile } from "./photo-file.js?v=admin31";
import {
  addMonths,
  categoriesForKind,
  comparePhotoCodes,
  decadeLabel,
  extraMonthsOf,
  findOrganisation,
  formatPhotoCode,
  genericLabelsForSponsor,
  isListed,
  listingIdFromPlaceName,
  MAX_PHOTOS,
  normalizePublicHttpUrl,
  nextGenericCode,
  nextPhotoCode,
  nextUnusedGenericCodes,
  organisationKind,
  parseGenericCode,
  parseISODate,
  parsePhotoCode,
  shopGroupOf,
  subscriptionState,
  UNCATEGORISED,
  uniqueCategoryNames,
} from "./model.js?v=admin33";
import { clearLocal, LOCAL_ORGS, LOCAL_SITES, writeLocal } from "./storage.js?v=admin19";

const $ = (id) => document.getElementById(id);

function on(id, event, handler) {
  const el = $(id);
  if (!el) return;
  el.addEventListener(event, handler);
}

function isJsonResponse(response) {
  return String(response.headers.get("content-type") || "").includes("json");
}

let organisations = [];
let sites = [];
let draftPhotos = [];

const saveBtnState = {
  sponsor: { dirty: false, saved: false },
  site: { dirty: false, saved: false },
};

function siteSaveLabel() {
  if (isShopOrg()) return "Save shop";
  if (isExhibitOrg()) return "Save exhibit";
  return "Save site";
}

function applySaveButtonState(buttonId, state, defaultLabel) {
  const btn = $(buttonId);
  if (!btn) return;
  btn.classList.remove("save-btn-dirty", "save-btn-saved");
  if (state.dirty) {
    btn.classList.add("save-btn-dirty");
    btn.textContent = defaultLabel;
    return;
  }
  if (state.saved) {
    btn.classList.add("save-btn-saved");
    btn.textContent = "Saved";
    return;
  }
  btn.textContent = defaultLabel;
}

function markSponsorDirty() {
  saveBtnState.sponsor.dirty = true;
  saveBtnState.sponsor.saved = false;
  applySaveButtonState("save-sponsor", saveBtnState.sponsor, "Save sponsor");
  paintStatus($("sponsor-save-status"), "", "info");
}

function markSponsorSaved() {
  saveBtnState.sponsor.dirty = false;
  saveBtnState.sponsor.saved = true;
  applySaveButtonState("save-sponsor", saveBtnState.sponsor, "Save sponsor");
}

function resetSponsorSaveButton() {
  saveBtnState.sponsor = { dirty: false, saved: false };
  applySaveButtonState("save-sponsor", saveBtnState.sponsor, "Save sponsor");
  paintStatus($("sponsor-save-status"), "", "info");
}

function markSiteDirty() {
  saveBtnState.site.dirty = true;
  saveBtnState.site.saved = false;
  applySaveButtonState("save-site-button", saveBtnState.site, siteSaveLabel());
  paintStatus($("site-save-status"), "", "info");
}

function markSiteSaved() {
  saveBtnState.site.dirty = false;
  saveBtnState.site.saved = true;
  applySaveButtonState("save-site-button", saveBtnState.site, siteSaveLabel());
}

function resetSiteSaveButton() {
  saveBtnState.site = { dirty: false, saved: false };
  applySaveButtonState("save-site-button", saveBtnState.site, siteSaveLabel());
  paintStatus($("site-save-status"), "", "info");
}

function initSaveButtonHints() {
  $("sponsor-form")?.addEventListener("input", markSponsorDirty);
  $("sponsor-form")?.addEventListener("change", markSponsorDirty);
  $("site-form")?.addEventListener("input", markSiteDirty);
  $("site-form")?.addEventListener("change", markSiteDirty);
}
let activeSiteId = "";
let selectedOrgId = "";
let currentUser = null;
let usePhpApi = false;
let sponsorNotice = "";
let workMode = "site";
let catalogueSettings = { heritageCategories: [], shopCategories: [], exhibitCategories: [] };
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
  if (native.status !== 404 && isJsonResponse(native)) return native;
  usePhpApi = true;
  return fetch(apiUrl("api/session"), { credentials: "include" });
}

function setLoginStatus(message, type = "error") {
  const el = $("login-status");
  if (!el) return;
  el.classList.remove("hidden", "bg-red-50", "text-red-800", "border-red-200", "bg-amber-50", "text-amber-900", "border-amber-200");
  el.textContent = message || "";
  if (!message) {
    el.classList.add("hidden");
    return;
  }
  if (type === "error") el.classList.add("bg-red-50", "text-red-800", "border-red-200");
  else el.classList.add("bg-amber-50", "text-amber-900", "border-amber-200");
}

on("login-form", "submit", async (event) => {
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
    if ($("login-password")) $("login-password").value = "";
    await enterApp(body.user);
  } catch {
    setLoginStatus("Sign in could not reach the TouristQR server. Try again on a Wi‑Fi connection, or open touristqr.com/admin.html.");
  }
});

function showApp(signedIn) {
  $("login-screen")?.classList.toggle("hidden", signedIn);
  $("app-screen")?.classList.toggle("hidden", !signedIn);
}

function applyRoleUi() {
  const admin = isAdmin();
  document.querySelectorAll(".admin-only").forEach((el) => el.classList.toggle("hidden", !admin));
  document.querySelectorAll(".sponsor-id-note").forEach((el) => el.classList.toggle("hidden", admin));
  if ($("session-label")) {
    $("session-label").textContent = admin
      ? `Signed in as ${currentUser.username} · site admin`
      : `Signed in as ${currentUser.username} · ${selectedOrg()?.name || organisations[0]?.name || "sponsor"}`;
  }
  if ($("sponsor-started")) $("sponsor-started").disabled = !admin;
  renderNotice();
}

const STATUS_CLASSES = [
  "hidden", "border", "bg-red-50", "text-red-800", "border-red-200",
  "bg-green-50", "text-green-800", "border-green-200",
  "bg-amber-50", "text-amber-900", "border-amber-200", "text-slate-600",
];

function paintStatus(el, message, type = "info", { scroll = false } = {}) {
  if (!el) return;
  el.classList.remove(...STATUS_CLASSES);
  el.textContent = message || "";
  if (!message) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.classList.add("border");
  if (type === "error") el.classList.add("bg-red-50", "text-red-800", "border-red-200");
  else if (type === "success") el.classList.add("bg-green-50", "text-green-800", "border-green-200");
  else el.classList.add("bg-amber-50", "text-amber-900", "border-amber-200");
  if (scroll) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function setStatus(message, type = "info", { target = "admin-status", scroll = false } = {}) {
  const el = $(target);
  paintStatus(el, message, type, { scroll: scroll === true });
}

function setSponsorSaveStatus(message, type = "info") {
  setStatus(message, type, { target: "sponsor-save-status" });
}

function setSiteSaveStatus(message, type = "info") {
  setStatus(message, type, { target: "site-save-status" });
}

function setPhotoAddStatus(message, type = "info") {
  paintStatus($("photo-add-status"), message, type, { scroll: false });
}

function clearFieldErrors() {
  for (const id of ["siteId", "siteName", "siteDesc"]) {
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

function isExhibitOrg(org = selectedOrg()) {
  return organisationKind(org) === "exhibit";
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
  select.value = names.includes(current) || current
    ? current
    : (workMode === "shop" ? "Shops" : workMode === "exhibit" ? "Uncategorised" : "");
}

function applyWorkModeUi() {
  const shop = workMode === "shop";
  const exhibit = workMode === "exhibit";
  document.querySelectorAll(".heritage-only").forEach((el) => el.classList.toggle("hidden", shop || exhibit));
  document.querySelectorAll(".place-listing-only").forEach((el) => el.classList.toggle("hidden", shop));
  document.querySelectorAll(".exhibit-only").forEach((el) => el.classList.toggle("hidden", !exhibit));
  document.querySelectorAll(".shop-only").forEach((el) => el.classList.toggle("hidden", !shop));
  document.querySelectorAll(".site-sponsor-only").forEach((el) => el.classList.toggle("hidden", shop));
  if ($("sponsor-picker")) $("sponsor-picker").classList.toggle("hidden", workMode !== "site");
  if ($("exhibit-sponsor-picker")) $("exhibit-sponsor-picker").classList.toggle("hidden", workMode !== "exhibit");
  if ($("shop-sponsor-picker")) $("shop-sponsor-picker").classList.toggle("hidden", workMode !== "shop");
  document.querySelectorAll(".shop-sponsor-only").forEach((el) => el.classList.toggle("hidden", !shop));
  if ($("work-sites")) {
    $("work-sites").className = `text-xs px-3 py-2 rounded-xl font-medium ${workMode === "site" ? "bg-slate-800 text-white" : "bg-white border border-slate-300 text-slate-700"}`;
    $("work-shops").className = `text-xs px-3 py-2 rounded-xl font-medium ${workMode === "shop" ? "bg-slate-800 text-white" : "bg-white border border-slate-300 text-slate-700"}`;
    $("work-exhibits").className = `text-xs px-3 py-2 rounded-xl font-medium ${workMode === "exhibit" ? "bg-slate-800 text-white" : "bg-white border border-slate-300 text-slate-700"}`;
  }
  if ($("add-sponsor-title")) {
    $("add-sponsor-title").textContent = shop ? "Add shop sponsor" : exhibit ? "Add exhibit sponsor" : "Add site sponsor";
  }
  if ($("site-form-title")) {
    $("site-form-title").textContent = shop ? "Public shop page" : exhibit ? "Add / modify exhibit" : "Add / modify historic site";
  }
  if ($("site-id-label")) {
    $("site-id-label").textContent = shop ? "Shop ID (permanent)" : exhibit ? "Exhibit ID (permanent)" : "Site ID (permanent)";
  }
  if ($("site-name-label")) $("site-name-label").textContent = shop ? "Shop name" : exhibit ? "Item name" : "Place name";
  if ($("site-year-label")) {
    $("site-year-label").textContent = shop ? "Established (optional)" : exhibit ? "Year of manufacture (optional)" : "Build year (optional)";
  }
  if ($("site-maps-label")) {
    $("site-maps-label").textContent = shop ? "Address (optional)" : exhibit ? "Navigation / maps query (optional)" : "Google Maps query (optional)";
  }
  if ($("site-desc-label")) {
    $("site-desc-label").textContent = shop ? "Description (optional)" : exhibit ? "Item history" : "History";
  }
  applySaveButtonState("save-site-button", saveBtnState.site, siteSaveLabel());
  if ($("siteDesc")) $("siteDesc").required = !shop;
  if ($("qr-section-title")) {
    $("qr-section-title").textContent = shop ? "QR code for this shop" : exhibit ? "QR code for this exhibit" : "QR code for this site";
  }
  if ($("siteId")) $("siteId").placeholder = shop ? "little-malop-books" : "moorabool-wool-exchange";
  if ($("delete-site")) {
    $("delete-site").textContent = shop ? "Delete shop listing" : exhibit ? "Delete exhibit" : "Delete site";
  }
  if ($("category-editor-title")) {
    $("category-editor-title").textContent = shop ? "Shop categories" : exhibit ? "Exhibit categories" : "Site categories";
  }
  if ($("new-sponsor-email")) $("new-sponsor-email").required = !shop;
  if ($("sponsor-email")) $("sponsor-email").required = !shop;
  if ($("site-nav-wrap")) $("site-nav-wrap").classList.toggle("hidden", shop);
  fillCategorySelect($("siteCategory")?.value);
  renderCategoryEditor();
  applyExhibitSponsorLogoPanel();
}

function applyExhibitSponsorLogoPanel(org = selectedOrg()) {
  $("exhibit-sponsor-logo-panel")?.classList.toggle("hidden", !isExhibitOrg(org));
}

function validateSiteForm() {
  const shop = isShopOrg();
  if (!selectedOrgId) return { ok: false, message: "Choose a sponsor first." };
  if (isAdmin()) {
    const id = $("siteId").value.trim();
    if (!id) return { ok: false, message: shop ? "Enter a permanent shop id." : "Enter a permanent site id (for example old-mill).", fieldId: "siteId" };
    if (!/^[a-z0-9-]{1,80}$/.test(id)) {
      return { ok: false, message: "The id can only use lowercase letters, numbers, and hyphens.", fieldId: "siteId" };
    }
    if (!activeSiteId && sites.some((site) => site.id === id)) {
      return { ok: false, message: "That id is already used. Pick another id.", fieldId: "siteId" };
    }
  }
  if (!$("siteName").value.trim()) return { ok: false, message: shop ? "Enter the shop name." : "Enter the place name.", fieldId: "siteName" };
  if (!shop && !$("siteDesc").value.trim()) {
    return {
      ok: false,
      message: isExhibitOrg() ? "Enter the item history." : "Enter the site history text.",
      fieldId: "siteDesc",
    };
  }
  if (shop && !activeSiteId && sitesForSelectedSponsor().length) {
    return { ok: false, message: "A shop sponsor can have only one listing." };
  }
  if (draftPhotos.length > MAX_PHOTOS) {
    return { ok: false, message: `A listing can have at most ${MAX_PHOTOS} photographs.` };
  }
  if (shop) {
    const webRaw = ($("siteReadingShop")?.value || "").trim();
    if (webRaw && !normalizePublicHttpUrl(webRaw)) {
      return {
        ok: false,
        message: "Enter a website like example.com or https://example.com, or leave it blank.",
        fieldId: "siteReadingShop",
      };
    }
  }
  return { ok: true };
}

function normalizeWebsiteField(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  return normalizePublicHttpUrl(trimmed);
}

function applyWebsiteBlur(fieldId) {
  const el = $(fieldId);
  if (!el) return;
  const raw = el.value.trim();
  if (!raw) return;
  const normalized = normalizePublicHttpUrl(raw);
  if (normalized) el.value = normalized;
}

on("sponsor-website", "blur", () => applyWebsiteBlur("sponsor-website"));
on("siteReadingShop", "blur", () => applyWebsiteBlur("siteReadingShop"));

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

function publicUntilDate(subscribedAt, extraMonths = 0) {
  const start = parseISODate(subscribedAt);
  return start ? addMonths(start, 12 + extraMonths) : null;
}

function publicUntilIso(subscribedAt, extraMonths = 0) {
  const date = publicUntilDate(subscribedAt, extraMonths);
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
  const extra = extraMonthsOf(org);
  if (subscriptionState(org.subscribedAt, new Date(), extra) === "grace" || subscriptionState(site.createdAt, new Date(), extra) === "grace") {
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
    yearStart: Number($("siteYearStart")?.value) || fromText || null,
    yearEnd: Number($("siteYearEnd")?.value) || fromText || null,
    circa: shop ? false : $("siteCirca").checked,
    createdAt: $("siteCreated")?.value || todayISO(),
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
  const state = subscriptionState(org.subscribedAt, new Date(), extraMonthsOf(org));
  if (state === "lapsed") return "Archived";
  if (state === "grace") return "Grace month";
  return "Active";
}

function sortByExpiryChecked() {
  return Boolean($("sort-by-expiry")?.checked || $("sort-shop-by-expiry")?.checked || $("sort-exhibit-by-expiry")?.checked);
}

function sortedOrganisations(kind = workMode) {
  const list = organisations.filter((org) => organisationKind(org) === kind);
  const byName = (a, b) => sponsorDisplayName(a).localeCompare(sponsorDisplayName(b), undefined, { sensitivity: "base" });
  if (sortByExpiryChecked()) {
    list.sort((a, b) => {
      const aDate = publicUntilIso(a.subscribedAt, extraMonthsOf(a)) || "9999-99-99";
      const bDate = publicUntilIso(b.subscribedAt, extraMonthsOf(b)) || "9999-99-99";
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return byName(a, b);
    });
    return list;
  }
  return list.sort(byName);
}

function sponsorOptionLabel(org) {
  const until = publicUntilIso(org.subscribedAt, extraMonthsOf(org));
  const untilText = until ? ` · public until ${formatDay(until)}` : "";
  return `${sponsorDisplayName(org)} · ${statusLabel(org)}${untilText}`;
}

function renderTotals() {
  const el = $("catalogue-totals");
  if (!el) return;
  const siteSponsors = organisations.filter((org) => organisationKind(org) === "site").length;
  const shopSponsors = organisations.filter((org) => organisationKind(org) === "shop").length;
  const exhibitSponsors = organisations.filter((org) => organisationKind(org) === "exhibit").length;
  const historic = sites.filter((site) => organisationKind(findOrganisation(organisations, site.organisationId)) === "site").length;
  const exhibits = sites.filter((site) => organisationKind(findOrganisation(organisations, site.organisationId)) === "exhibit").length;
  const shops = sites.length - historic - exhibits;
  const photos = photoCount();
  el.textContent = `${siteSponsors} site sponsor${siteSponsors === 1 ? "" : "s"} · ${shopSponsors} shop sponsor${shopSponsors === 1 ? "" : "s"} · ${exhibitSponsors} exhibit sponsor${exhibitSponsors === 1 ? "" : "s"} · ${historic} site${historic === 1 ? "" : "s"} · ${shops} shop listing${shops === 1 ? "" : "s"} · ${exhibits} exhibit${exhibits === 1 ? "" : "s"} · ${photos} photograph${photos === 1 ? "" : "s"}`;
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
    const selectedKind = org ? organisationKind(org) : "";
    selector.value = org && selectedKind === kind ? organisationKey(org) : "";
  } finally {
    syncingSelects = false;
  }
}

function renderSponsorOptions() {
  fillSponsorSelect("sponsor-selector", "site");
  fillSponsorSelect("shop-sponsor-selector", "shop");
  fillSponsorSelect("exhibit-sponsor-selector", "exhibit");
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
  if ($("sponsor-website")) $("sponsor-website").value = org.website || "";
  loadSponsorLogin(org.id);
  $("sponsor-started").value = org.subscribedAt || "";
  setShopGroupRadios(shopGroupOf(org));
  applyWorkModeUi();
  applyExhibitSponsorLogoPanel(org);
  renderSponsorLogoPreview(org);
  const mine = sitesForSelectedSponsor();
  const publicCount = mine.filter((site) => isListed(site, org)).length;
  const photos = photoCount(mine);
  const until = publicUntilIso(org.subscribedAt, extraMonthsOf(org));
  const listingWord = isShopOrg(org) ? "listing" : isExhibitOrg(org) ? "exhibit" : "site";
  $("sponsor-report").textContent = `${statusLabel(org)} · started ${formatDay(org.subscribedAt)} · public listing ends ${formatDay(until)} · ${mine.length} ${listingWord}${mine.length === 1 ? "" : "s"} · ${publicCount} on the public list · ${photos} photograph${photos === 1 ? "" : "s"}`;
  resetSponsorSaveButton();
  $("site-sponsor-label").textContent = sponsorDisplayName(org);
  const shop = isShopOrg(org);
  if ($("site-nav-wrap")) $("site-nav-wrap").classList.toggle("hidden", shop);
  if ($("site-selector-wrap")) $("site-selector-wrap").classList.toggle("hidden", shop);
  if ($("new-site")) $("new-site").classList.toggle("hidden", shop);
  if ($("new-site")) {
    $("new-site").textContent = shop ? "+ Add this shop" : isExhibitOrg(org) ? "+ Next new exhibit" : "+ Next new site";
  }
  renderSelector();
}

function uniqueListingId(preferred, excludeId = "") {
  return listingIdFromPlaceName(preferred, sites.map((site) => site.id), {
    excludeId,
    fallback: isShopOrg() ? "shop" : isExhibitOrg() ? "exhibit" : "site",
  });
}

function ensureSiteIdBeforeSave() {
  if (isAdmin()) return;
  if (activeSiteId) {
    $("siteId").value = activeSiteId;
    return;
  }
  $("siteId").value = uniqueListingId($("siteName").value.trim());
}

function previewListingId() {
  if (isAdmin() && !activeSiteId && !$("siteId").readOnly) {
    return $("siteId").value.trim();
  }
  if (activeSiteId) return activeSiteId;
  const name = $("siteName").value.trim();
  if (!name) return "";
  return uniqueListingId(name);
}

function openBlankListingEditor(org) {
  fillForm(null);
  if ($("siteName")) $("siteName").value = org?.name || "";
  if (isAdmin() && isShopOrg(org)) {
    if ($("siteId")) $("siteId").value = uniqueListingId(org.id || org.name);
    setListingIdLocked(true);
  } else if (isAdmin()) {
    setListingIdLocked(false);
  } else {
    if ($("siteId")) $("siteId").value = "";
    setListingIdLocked(true);
  }
  $("site-sponsor-label").textContent = org?.name || "";
  generateQR(previewListingId());
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
  activeSiteId = "";
  syncingSelects = true;
  if ($("site-selector")) $("site-selector").value = "";
  syncingSelects = false;
  fillForm(null);
  clearQr();
  showSitePanel();
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
  const scrollY = window.scrollY;
  wrap.replaceChildren();
  if (!draftPhotos.length) {
    const empty = document.createElement("p");
    empty.className = "text-xs text-slate-500";
    empty.textContent = isShopOrg() ? "No photographs on this listing yet. Add them for the public gallery." : "No photographs on this site yet.";
    wrap.append(empty);
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
    return;
  }
  draftPhotos.forEach((photo, index) => {
    const row = document.createElement("div");
    row.className = "border border-slate-200 rounded-xl p-3 grid grid-cols-[72px_1fr] gap-3";
    const image = document.createElement("img");
    image.src = photoSrc(photo.preview || adminPhotoPreview(photo));
    image.alt = "";
    image.className = "w-[72px] h-[72px] object-cover rounded-lg bg-slate-200";
    const fields = document.createElement("div");
    fields.className = "space-y-2";
    const code = document.createElement("p");
    code.className = "font-mono text-sm font-semibold";
    code.textContent = photo.code;

    const caption = document.createElement("input");
    caption.value = photo.caption || "";
    caption.placeholder = "Caption (optional)";
    caption.className = "w-full border rounded-xl p-2 text-sm";
    caption.addEventListener("input", () => {
      draftPhotos[index].caption = caption.value;
      markSiteDirty();
    });

    const kind = document.createElement("select");
    kind.className = "border rounded-xl p-2 text-sm bg-white";
    for (const value of ["current", "historical"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "historical"
        ? (isShopOrg() ? "Shop front" : isExhibitOrg() ? "Advertising photo" : "Historical")
        : "Current";
      kind.append(option);
    }
    kind.value = photo.kind === "historical" ? "historical" : "current";
    kind.addEventListener("change", () => {
      draftPhotos[index].kind = kind.value;
      markSiteDirty();
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
    file.addEventListener("change", async (event) => {
      event.stopPropagation();
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
      markSiteDirty();
    });
    actions.append(replace, remove);
    fields.append(code, caption, kind, actions);
    row.append(image, fields);
    wrap.append(row);
  });
  requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

function cacheBustedImageRef(url, bust = Date.now()) {
  const raw = String(url || "").trim();
  if (!raw || /^(data:|blob:)/i.test(raw)) return raw;
  const [path, query] = raw.split("?");
  if (/^https?:/i.test(path)) {
    if (query) return raw;
    return `${path}?v=${bust}`;
  }
  return `${path}?v=${bust}`;
}

function adminPhotoPreview(photo, bust = Date.now()) {
  const url = String(photo?.url || "").trim();
  if (!url) return "";
  if (/^(data:|blob:)/i.test(url)) return photo?.preview || url;
  return cacheBustedImageRef(url, photo?.previewVersion || bust);
}

function photoSrc(url) {
  if (!url || /^(https?:|data:|blob:)/i.test(url)) return url || "";
  const [path, query] = String(url).split("?");
  const full = /^https?:/i.test(path) ? path : assetUrl(path);
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
  setListingIdLocked(Boolean(site) || !isAdmin() || (isShopOrg() && Boolean(site?.id)));
  $("siteName").value = site?.name || "";
  $("siteYear").value = site?.buildYear || "";
  $("siteCirca").checked = Boolean(site?.circa);
  fillCategorySelect(site?.category || (isShopOrg() ? "Shops" : isExhibitOrg() ? "Uncategorised" : ""));
  if ($("siteContactPerson")) $("siteContactPerson").value = site?.contactPerson || "";
  if ($("siteContactEmail")) $("siteContactEmail").value = site?.contactEmail || "";
  if ($("siteOwner")) $("siteOwner").value = site?.owner || "";
  if ($("siteRegistration")) $("siteRegistration").value = site?.registrationNumber || "";
  $("siteSuburb").value = site?.suburb || "";
  $("siteMapArea").value = site?.mapArea || "";
  $("siteMaps").value = site?.mapsQuery || "";
  $("siteDesc").value = site?.description || "";
  $("siteCountry").value = site?.country || "Australia";
  $("siteState").value = site?.state || "Victoria";
  $("siteCity").value = site?.city || "Geelong";
  if ($("siteCityVisible")) $("siteCityVisible").value = site?.city || "Geelong";
  if ($("siteYearStart")) $("siteYearStart").value = site?.yearStart || "";
  if ($("siteYearEnd")) $("siteYearEnd").value = site?.yearEnd || "";
  if ($("siteCreated")) $("siteCreated").value = site?.createdAt || todayISO();
  if ($("siteReadingShop")) $("siteReadingShop").value = site?.furtherReading || "";
  if ($("sitePhone")) $("sitePhone").value = site?.phone || "";
  setShopGroupRadios(shopGroupOf(selectedOrg(), site));
  const loadedAt = Date.now();
  draftPhotos = photosInOrder(site?.photos || []).map((photo) => ({
    ...photo,
    preview: adminPhotoPreview(photo, loadedAt),
    previewVersion: loadedAt,
  }));
  $("site-sponsor-label").textContent = selectedOrg()?.name || "";
  renderPhotoRows();
  refreshComputed();
  $("delete-site").classList.toggle("hidden", !site || (isShopOrg() && !isAdmin()));
  if (site) generateQR(site.id);
  resetSiteSaveButton();
  paintStatus($("photo-add-status"), "", "info");
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
  const prepared = await preparePhotoFile(file);
  const params = new URLSearchParams({ sponsor: String(org.number) });
  if (code) params.set("code", code);
  try {
    const response = await api(`api/media?${params}`, {
      method: "POST",
      headers: { "Content-Type": prepared.contentType },
      body: prepared.blob,
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.code) {
      const previewVersion = Date.now();
      return {
        ...body,
        url: body.url,
        preview: cacheBustedImageRef(body.url, previewVersion),
        previewVersion,
        mediaVersion: previewVersion,
        stored: "server",
      };
    }
  } catch {
    // If the upload API is not running, keep the photograph in this browser.
  }
  return savePhotoInBrowser(prepared.blob, org.number, code);
}

async function replacePhoto(index, file) {
  try {
    setPhotoAddStatus("Resizing photograph…", "info");
    const saved = await uploadPhoto(file, draftPhotos[index].code);
    const previewVersion = saved.previewVersion || Date.now();
    draftPhotos[index] = {
      ...draftPhotos[index],
      code: saved.code,
      url: saved.url,
      preview: saved.preview || cacheBustedImageRef(saved.url, previewVersion),
      previewVersion,
      mediaVersion: saved.mediaVersion || previewVersion,
    };
    renderPhotoRows();
    markSiteDirty();
    const where = saved.stored === "server" ? "on the server" : "in this browser";
    setPhotoAddStatus(`Replaced ${saved.code} ${where}. Save the ${isShopOrg() ? "shop" : "site"} when you are done.`, "success");
  } catch (error) {
    setPhotoAddStatus(error.message, "error");
  }
}

function formPayload() {
  const site = draftSite();
  const shop = isShopOrg();
  const existing = sites.find((item) => item.id === activeSiteId);
  if (shop && $("siteCityVisible")) $("siteCity").value = $("siteCityVisible").value;
  return {
    ...site,
    updatedAt: new Date().toISOString(),
    organisationId: selectedOrg()?.id || selectedOrgId,
    country: $("siteCountry")?.value.trim() || "Australia",
    state: $("siteState")?.value.trim() || "Victoria",
    city: $("siteCity")?.value.trim() || "",
    suburb: $("siteSuburb").value.trim(),
    mapArea: shop ? "" : $("siteMapArea").value.trim(),
    mapsQuery: $("siteMaps").value.trim(),
    contactPerson: isExhibitOrg() ? ($("siteContactPerson")?.value.trim() || "") : "",
    contactEmail: isExhibitOrg() ? ($("siteContactEmail")?.value.trim() || "") : "",
    owner: isExhibitOrg() ? ($("siteOwner")?.value.trim() || "") : "",
    registrationNumber: isExhibitOrg() ? ($("siteRegistration")?.value.trim() || "") : "",
    description: $("siteDesc").value.trim(),
    facts: shop ? [] : (existing?.facts || []),
    furtherReading: shop ? normalizeWebsiteField($("siteReadingShop")?.value) : (existing?.furtherReading || ""),
    phone: shop ? ($("sitePhone")?.value.trim() || "") : "",
    sources: shop ? [] : (existing?.sources || []),
    photos: draftPhotos.map((photo) => {
      const row = {
        code: photo.code,
        url: String(photo.url || "").split("?")[0].split("#")[0],
        caption: photo.caption || "",
        credit: photo.credit || "Demonstration photograph",
        kind: photo.kind === "historical" ? "historical" : "current",
      };
      const mediaVersion = photo.mediaVersion || photo.previewVersion;
      if (mediaVersion) row.mediaVersion = mediaVersion;
      return row;
    }),
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
}

function keepLocalCopy() {
  writeLocal(LOCAL_SITES, sites);
  writeLocal(LOCAL_ORGS, organisations);
}

function persistSitesLocally(nextSites, message) {
  sites = nextSites;
  keepLocalCopy();
  refreshAfterCatalogueChange();
  setSiteSaveStatus(message, "success");
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

$("exhibit-sponsor-selector")?.addEventListener("change", () => {
  if (syncingSelects) return;
  selectSponsor($("exhibit-sponsor-selector").value);
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
$("work-exhibits")?.addEventListener("click", () => setWorkMode("exhibit"));
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

on("site-selector", "change", () => {
  if (syncingSelects) return;
  if ($("site-selector").value) loadSite($("site-selector").value);
  else {
    activeSiteId = "";
    fillForm(null);
    clearQr();
    showSitePanel();
  }
});

on("new-site", "click", () => {
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
  setStatus(isShopOrg()
    ? (isAdmin() ? "New shop. Enter an id and a name, and its QR code will appear below." : "New shop. Enter the shop name and save; the public id is created from that name.")
    : (isAdmin() ? "New site. Enter an id and a name, and its QR code will appear below." : "New site. Enter the place name and save; the public id is created from that name."));
});

on("siteId", "input", () => {
  if ($("siteId").readOnly) return;
  generateQR($("siteId").value.trim());
});

on("siteName", "input", () => {
  const id = previewListingId();
  if (id) generateQR(id);
});

["siteYear", "siteYearStart", "siteCreated", "siteCirca"].forEach((id) => {
  $(id).addEventListener("input", refreshComputed);
  $(id).addEventListener("change", refreshComputed);
});

async function addPhotoFromFile(file) {
  if (!file) return;
  const org = selectedOrg();
  if (!org) {
    setPhotoAddStatus("Choose a sponsor before adding a photograph.", "error");
    return;
  }
  if (draftPhotos.length >= MAX_PHOTOS) {
    setPhotoAddStatus(`A listing can have at most ${MAX_PHOTOS} photographs.`, "error");
    return;
  }
  const reservedCode = nextPhotoCode(org.number, allPhotoCodes());
  draftPhotos.push({
    code: reservedCode,
    url: "",
    preview: "",
    caption: "",
    credit: "Demonstration photograph",
    kind: "current",
  });
  markSiteDirty();
  setPhotoAddStatus("Resizing photograph…", "info");
  try {
    const saved = await uploadPhoto(file, reservedCode);
    const previewVersion = saved.previewVersion || Date.now();
    const index = draftPhotos.findIndex((photo) => photo.code === reservedCode);
    if (index === -1) throw new Error("The photograph row could not be updated.");
    draftPhotos[index] = {
      code: saved.code,
      url: saved.url,
      preview: saved.preview || cacheBustedImageRef(saved.url, previewVersion),
      previewVersion,
      mediaVersion: saved.mediaVersion || previewVersion,
      caption: "",
      credit: "Demonstration photograph",
      kind: "current",
    };
    renderPhotoRows();
    const where = saved.stored === "server" ? "saved on the server" : "attached in this browser";
    setPhotoAddStatus(`Added ${saved.code} (${where}). Save when you are finished.`, "success");
  } catch (error) {
    draftPhotos = draftPhotos.filter((photo) => photo.code !== reservedCode);
    renderPhotoRows();
    throw error;
  }
}

function fileFromClipboardItem(item) {
  const type = item.types.find((entry) => /^image\//i.test(entry));
  if (!type) return null;
  return item.getType(type).then((blob) => {
    const ext = type === "image/jpeg" ? "jpg" : type.replace(/^image\//i, "").replace(/^jpeg$/i, "jpg");
    return new File([blob], `pasted-${Date.now()}.${ext}`, { type: blob.type || type });
  });
}

async function pastePhotoFromClipboard() {
  if (!navigator.clipboard?.read) {
    setPhotoAddStatus("Paste image is not available in this browser. Use Add photograph instead.", "error");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const file = await fileFromClipboardItem(item);
      if (!file) continue;
      await addPhotoFromFile(file);
      return;
    }
    setPhotoAddStatus("Nothing on the clipboard is a picture. Copy an image first (e.g. Win+Shift+S), then try again.", "error");
  } catch (error) {
    const denied = error?.name === "NotAllowedError";
    setPhotoAddStatus(denied
      ? "Clipboard access was blocked. Allow it when the browser asks, or use Add photograph."
      : (error.message || "Could not read the clipboard."), "error");
  }
}

on("add-photo", "change", async (event) => {
  event.stopPropagation();
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    await addPhotoFromFile(file);
  } catch (error) {
    setPhotoAddStatus(error.message, "error");
  }
});

on("paste-photo", "click", () => {
  pastePhotoFromClipboard().catch((error) => setPhotoAddStatus(error.message, "error"));
});

on("site-form", "submit", async (event) => {
  event.preventDefault();
  clearFieldErrors();
  ensureSiteIdBeforeSave();
  const check = validateSiteForm();
  if (!check.ok) {
    setSiteSaveStatus(check.message, "error");
    if (check.fieldId) markInvalid(check.fieldId);
    return;
  }
  const payload = formPayload();
  if (isShopOrg()) {
    if ($("siteReadingShop")) $("siteReadingShop").value = payload.furtherReading || "";
    const org = selectedOrg();
    if (org) org.shopGroup = payload.shopGroup;
  }
  const next = activeSiteId
    ? sites.map((site) => (site.id === activeSiteId ? payload : site))
    : [...sites, payload];
  generateQR(payload.id, { scroll: true });
  setSiteSaveStatus(isShopOrg() ? "Saving shop…" : "Saving site…", "info");
  activeSiteId = payload.id;
  syncingSelects = true;
  $("site-selector").value = payload.id;
  syncingSelects = false;
  setListingIdLocked(true);
  try {
    await saveSites(next);
    if (isShopOrg()) await saveOrganisations();
    markSiteSaved();
    setSiteSaveStatus(isShopOrg()
      ? "Shop saved on the server. The QR code below is ready to download."
      : "Site saved on the server. The QR code below is ready to download.", "success");
    $("qr-section").scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (error) {
    try {
      persistSitesLocally(
        next,
        `${isShopOrg() ? "Shop" : "Site"} saved in this browser. ${error.message} Use View live site on this device to check it. When the server is running, save again to publish for everyone.`,
      );
      markSiteSaved();
      $("qr-section").scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (storageError) {
      setSiteSaveStatus(storageError.message, "error");
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
      exhibitCategories: uniqueCategoryNames(body.exhibitCategories, ["Collectibles", "Industrial", "Transport", "Uncategorised"]),
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
      exhibitCategories: catalogueSettings.exhibitCategories,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The category list could not be saved.");
  catalogueSettings = {
    heritageCategories: uniqueCategoryNames(body.heritageCategories, catalogueSettings.heritageCategories),
    shopCategories: uniqueCategoryNames(body.shopCategories, catalogueSettings.shopCategories),
    exhibitCategories: uniqueCategoryNames(body.exhibitCategories, catalogueSettings.exhibitCategories),
  };
}

function categoryListKey() {
  if (workMode === "shop") return "shopCategories";
  if (workMode === "exhibit") return "exhibitCategories";
  return "heritageCategories";
}

function listingMatchesCategoryEditor(site) {
  return organisationKind(findOrganisation(organisations, site.organisationId)) === workMode;
}

function syncCategoryEditorFields() {
  const name = $("category-pick")?.value || "";
  if ($("category-rename-name")) $("category-rename-name").value = name;
  if ($("delete-category")) $("delete-category").disabled = !name || name === UNCATEGORISED;
}

function renderCategoryEditor() {
  const select = $("category-pick");
  if (!select) return;
  const names = categoriesForKind(workMode, catalogueSettings);
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
  sites = sites.map((site) => (listingMatchesCategoryEditor(site) && site.category === from ? { ...site, category: nextName } : site));
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
  sites = sites.map((site) => (listingMatchesCategoryEditor(site) && site.category === name ? { ...site, category: UNCATEGORISED } : site));
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
  workMode = mode === "shop" ? "shop" : mode === "exhibit" ? "exhibit" : "site";
  applyWorkModeUi();
  renderSponsorOptions();
  renderCategoryEditor();
  fillCategorySelect();
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

function sponsorLogoPreviewUrl(org) {
  const raw = String(org?.logoUrl || "").trim();
  if (!raw) return "";
  return cacheBustedImageRef(raw, org.logoVersion || Date.now());
}

function renderSponsorLogoPreview(org) {
  const img = $("sponsor-logo-preview");
  const wrap = $("sponsor-logo-preview-btn");
  const uploadLabel = $("sponsor-logo-upload-label");
  const removeBtn = $("remove-sponsor-logo");
  const status = $("sponsor-logo-status");
  if (!img) return;
  const name = org ? sponsorDisplayName(org) : "";
  const url = org ? sponsorLogoPreviewUrl(org) : "";
  wrap?.classList.toggle("hidden", !url);
  if (url) {
    img.src = url;
    img.alt = `${name} logo`;
  } else {
    img.removeAttribute("src");
    img.alt = "";
  }
  if (uploadLabel) uploadLabel.textContent = url ? "Replace logo" : "Upload logo";
  if (removeBtn) removeBtn.classList.toggle("hidden", !url);
  if (status) {
    status.textContent = url
      ? `Logo saved for ${name}. Tap the picture or Replace logo to change it.`
      : "";
  }
}

async function uploadSponsorLogo(file) {
  const org = selectedOrg();
  if (!org || !isExhibitOrg(org)) return;
  const prepared = await prepareLogoFile(file);
  const safeName = slugify(org.name || org.id || "sponsor");
  const namedFile = new File([prepared.blob], `${safeName}-club-logo.${prepared.ext}`, { type: prepared.contentType });
  const params = new URLSearchParams({ sponsor: String(org.number) });
  const response = await api(`api/org-logo?${params}`, {
    method: "POST",
    headers: { "Content-Type": prepared.contentType },
    body: namedFile,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The logo could not be saved.");
  org.logoUrl = body.logoUrl;
  org.logoVersion = body.logoVersion;
  renderSponsorLogoPreview(org);
}

async function removeSponsorLogo() {
  const org = selectedOrg();
  if (!org || !isExhibitOrg(org) || !org.logoUrl) return;
  const params = new URLSearchParams({ sponsor: String(org.number) });
  const response = await api(`api/org-logo?${params}`, { method: "DELETE" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The logo could not be removed.");
  delete org.logoUrl;
  delete org.logoVersion;
  renderSponsorLogoPreview(org);
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

on("sponsor-logo-preview-btn", "click", () => {
  $("sponsor-logo-file")?.click();
});

on("sponsor-logo-file", "change", async (event) => {
  event.stopPropagation();
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    if ($("sponsor-logo-status")) $("sponsor-logo-status").textContent = "Uploading logo…";
    await uploadSponsorLogo(file);
  } catch (error) {
    if ($("sponsor-logo-status")) $("sponsor-logo-status").textContent = error.message;
  }
});

on("paste-sponsor-logo", "click", () => {
  if (!navigator.clipboard?.read) {
    if ($("sponsor-logo-status")) $("sponsor-logo-status").textContent = "Paste is not available in this browser. Use Upload logo instead.";
    return;
  }
  navigator.clipboard.read().then(async (items) => {
    for (const item of items) {
      const type = item.types.find((entry) => /^image\//i.test(entry));
      if (!type) continue;
      const blob = await item.getType(type);
      const ext = type === "image/jpeg" ? "jpg" : type.replace(/^image\//i, "");
      const file = new File([blob], `pasted-logo.${ext}`, { type: blob.type || type });
      if ($("sponsor-logo-status")) $("sponsor-logo-status").textContent = "Uploading logo…";
      await uploadSponsorLogo(file);
      return;
    }
    if ($("sponsor-logo-status")) $("sponsor-logo-status").textContent = "Nothing on the clipboard is a picture.";
  }).catch((error) => {
    if ($("sponsor-logo-status")) $("sponsor-logo-status").textContent = error.message || "Could not read the clipboard.";
  });
});

on("remove-sponsor-logo", "click", () => {
  removeSponsorLogo().catch((error) => {
    if ($("sponsor-logo-status")) $("sponsor-logo-status").textContent = error.message;
  });
});

on("sponsor-form", "submit", async (event) => {
  event.preventDefault();
  const org = selectedOrg();
  if (!org) return;
  const name = ($("sponsor-name")?.value || "").trim();
  if (!name) {
    setSponsorSaveStatus("Enter the business name shown on the public page.", "error");
    $("sponsor-name").focus();
    return;
  }
  const contactName = ($("sponsor-contact-name")?.value || "").trim();
  if (!contactName) {
    setSponsorSaveStatus("Enter the contact name.", "error");
    $("sponsor-contact-name")?.focus();
    return;
  }
  const contactEmail = ($("sponsor-contact-email")?.value || "").trim();
  if (!contactEmail) {
    setSponsorSaveStatus("Enter the contact email address.", "error");
    $("sponsor-contact-email")?.focus();
    return;
  }
  const email = isShopOrg(org) ? (org.email || "") : $("sponsor-email").value.trim();
  if (!isShopOrg(org) && !email) {
    setSponsorSaveStatus("Enter a public contact email address.", "error");
    $("sponsor-email").focus();
    return;
  }
  const loginName = ($("sponsor-login-name")?.value || "").trim().toLowerCase();
  const loginPassword = $("sponsor-login-password")?.value || "";
  if (loginName && !loginNameOk(loginName)) {
    setSponsorSaveStatus("A login name uses 3–40 letters, numbers, dots, hyphens, or underscores.", "error");
    $("sponsor-login-name")?.focus();
    return;
  }
  if (loginPassword && loginPassword.length < 8) {
    setSponsorSaveStatus("A new password needs at least 8 characters.", "error");
    $("sponsor-login-password")?.focus();
    return;
  }
  if (!hasSponsorLogin && (loginName || loginPassword) && (!loginName || !loginPassword)) {
    setSponsorSaveStatus("A new login needs both a login name and a password.", "error");
    (loginName ? $("sponsor-login-password") : $("sponsor-login-name"))?.focus();
    return;
  }
  org.name = name;
  org.email = email;
  const websiteRaw = ($("sponsor-website")?.value || "").trim();
  if (websiteRaw && !normalizePublicHttpUrl(websiteRaw)) {
    setSponsorSaveStatus("Enter a website like example.com or https://example.com, or leave it blank.", "error");
    $("sponsor-website")?.focus();
    return;
  }
  org.website = normalizeWebsiteField(websiteRaw);
  if ($("sponsor-website")) $("sponsor-website").value = org.website;
  org.contactName = contactName;
  org.contactEmail = contactEmail;
  if (isShopOrg(org)) org.shopGroup = selectedShopGroup();
  if (isAdmin()) org.subscribedAt = $("sponsor-started").value || org.subscribedAt || todayISO();
  try {
    await saveOrganisations();
    if (loginName || loginPassword) {
      await saveSponsorLogin(loginName, loginPassword);
      setSponsorSaveStatus("Sponsor saved. Login details were updated.", "success");
    } else {
      setSponsorSaveStatus("Sponsor saved.", "success");
    }
    markSponsorSaved();
  } catch (error) {
    setSponsorSaveStatus(error.message, "error");
  }
});

on("notice-form", "submit", async (event) => {
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

on("new-sponsor", "submit", async (event) => {
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
    type: workMode === "shop" ? "Shop" : workMode === "exhibit" ? "Exhibit" : "Organisation",
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

on("backup-all", "click", async () => {
  try {
    await downloadScope("full");
    setStatus("Whole catalogue downloaded.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

on("backup-sponsor", "click", async () => {
  try {
    await downloadScope("sponsor");
    setStatus("Sponsor backup downloaded.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

on("restore-all-file", "change", async (event) => {
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

on("restore-sponsor-file", "change", async (event) => {
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


on("sign-out", "click", async () => {
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
  const genericLabels = genericLabelsForSponsor(sites, organisations, org.id);
  const genericNote = genericLabels.length
    ? `\n\nPrinted Generic codes (${genericLabels.join(", ")}) will be free to assign again.`
    : "";
  const listingNote = mine.length
    ? `\n\nThis also deletes their ${listingCount} (including public QR pages) and removes photograph files from images.`
    : "";
  if (!window.confirm(`Delete ${org.name}?${listingNote}${genericNote}\n\nThis removes the sponsor and their login.`)) return;
  try {
    const response = await api("api/delete-sponsor", {
      method: "POST",
      body: JSON.stringify({ organisationId: org.id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "The sponsor could not be deleted.");
    organisations = body.organisations || organisations.filter((item) => item.id !== org.id);
    sites = body.sites || sites.filter((site) => site.organisationId !== org.id);
    selectedOrgId = "";
    activeSiteId = "";
    refreshAfterCatalogueChange();
    const released = body.releasedGenerics?.length
      ? body.releasedGenerics
      : genericLabels;
    const genericStatus = released.length ? ` ${released.join(", ")} can be used again.` : "";
    setStatus(mine.length
      ? `${org.name} was deleted, including their ${listingWord}${mine.length === 1 ? "" : "s"}, photograph files, and login.${genericStatus}`
      : `${org.name} was deleted.${genericStatus}`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

on("delete-site", "click", async () => {
  if (!activeSiteId) return;
  const site = sites.find((item) => item.id === activeSiteId);
  const shop = isShopOrg();
  if (!window.confirm(`Delete ${site?.name || (shop ? "this shop" : "this site")}? Its photograph files stay in images so the numbers are not reused.`)) return;
  try {
    await saveSites(sites.filter((item) => item.id !== activeSiteId));
    setSiteSaveStatus(shop ? "Shop listing deleted from the catalogue." : "Site deleted from the catalogue.", "success");
  } catch (error) {
    sites = sites.filter((item) => item.id !== activeSiteId);
    keepLocalCopy();
    refreshAfterCatalogueChange();
    setSiteSaveStatus(error.message, "error");
  }
});

on("view-live", "click", () => {
  const id = $("site-selector").value || $("siteId").value.trim();
  if (!selectedOrgId) {
    setStatus("Choose a sponsor first.");
    return;
  }
  if (!id) {
    if (!isAdmin() && $("siteName").value.trim()) {
      ensureSiteIdBeforeSave();
      const generated = $("siteId").value.trim();
      if (generated) {
        window.open(liveSiteUrl(generated), "_blank", "noopener");
        return;
      }
    }
    setStatus("Choose a site, or enter a place name and save, to view it.");
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
  if (isAdmin()) prefillGenericStart();
  if (!isAdmin() && selectedOrg()) openSponsorListingEditor(selectedOrg(), { keepSite: true });
}

const GENERIC_SHEET_COUNT = 6;
const GENERIC_PAGE_SIZE = 6;

function loadQrious() {
  if (typeof QRious === "function") return Promise.resolve();
  const existing = document.querySelector("script[src*=\"qrious\"]");
  if (!existing) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("QR library"));
      document.head.appendChild(script);
    });
  }
  return new Promise((resolve) => {
    existing.addEventListener("load", () => resolve(), { once: true });
    setTimeout(resolve, 1200);
  });
}

function makeGenericQrCanvas(url) {
  const canvas = document.createElement("canvas");
  new QRious({
    element: canvas,
    value: url,
    size: 1024,
    level: "H",
    padding: 16,
    background: "#ffffff",
    foreground: "#000000",
  });
  return canvas;
}

function genericPrintCard(code) {
  const article = document.createElement("article");
  article.className = "generic-print-card";
  const url = genericPublicUrl(code.label);
  article.append(makeGenericQrCanvas(url));
  const brand = document.createElement("p");
  brand.className = "generic-print-brand";
  brand.textContent = "TouristQR";
  const scan = document.createElement("p");
  scan.className = "generic-print-scan";
  scan.textContent = "Scan me";
  const mark = document.createElement("p");
  mark.className = "generic-print-code";
  mark.textContent = `G-${code.digits}`;
  article.append(brand, scan, mark);
  return article;
}

function renderGenericSheet(codes) {
  const preview = $("generic-print-preview");
  const sheet = $("generic-print-sheet");
  if (!preview || !sheet) return;
  preview.replaceChildren();
  sheet.replaceChildren();
  for (const code of codes) preview.append(genericPrintCard(code));
  for (let i = 0; i < codes.length; i += GENERIC_PAGE_SIZE) {
    const page = document.createElement("div");
    page.className = "generic-print-page";
    for (const code of codes.slice(i, i + GENERIC_PAGE_SIZE)) {
      page.append(genericPrintCard(code));
    }
    sheet.append(page);
  }
}

function prefillGenericStart() {
  const input = $("generic-start");
  if (!input || input.dataset.touched === "1") return;
  const next = nextGenericCode(sites, organisations);
  input.value = String(next?.number || 1);
}

async function makeGenericPrintSheet() {
  const status = $("generic-qr-status");
  try {
    await loadQrious();
  } catch {
    if (status) status.textContent = "The QR library could not be loaded. Check the network and try again.";
    return false;
  }
  if (typeof QRious !== "function") {
    if (status) status.textContent = "The QR library could not be loaded. Check the network and try again.";
    return false;
  }
  const start = Number($("generic-start")?.value);
  const skip = Boolean($("generic-skip-used")?.checked);
  const batch = nextUnusedGenericCodes(sites, start, GENERIC_SHEET_COUNT, skip, organisations);
  if (!batch.codes.length) {
    if (status) status.textContent = "No Generic numbers available from that start.";
    return false;
  }
  renderGenericSheet(batch.codes);
  const first = batch.codes[0].label;
  const last = batch.codes[batch.codes.length - 1].label;
  const skipped = !batch.skipped.length
    ? ""
    : batch.skipped.length <= 8
      ? ` Skipped ${batch.skipped.map((n) => `G-${String(n).padStart(4, "0")}`).join(", ")} already used.`
      : ` Skipped ${batch.skipped.length} numbers already used.`;
  if (status) status.textContent = `${batch.codes.length} codes ready (${first}–${last}). Print uses 3 rows of 2 on A4.${skipped}`;
  return true;
}

on("generic-start", "input", () => {
  if ($("generic-start")) $("generic-start").dataset.touched = "1";
});
on("generic-make", "click", () => {
  makeGenericPrintSheet();
});
on("generic-print", "click", async () => {
  const sheet = $("generic-print-sheet");
  if (!sheet?.querySelector("canvas")) {
    const ok = await makeGenericPrintSheet();
    if (!ok) return;
  }
  window.print();
});

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

initSaveButtonHints();
init();
