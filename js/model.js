export function parseISODate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function startOfLocalDay(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function addMonths(date, months) {
  const result = new Date(date.getFullYear(), date.getMonth(), 1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(date.getDate(), lastDay));
  return result;
}

// Active for 12 months, still public during the 13th month, then archived.
export function subscriptionState(startIso, now = new Date()) {
  const start = parseISODate(startIso);
  if (!start) return "lapsed";
  const today = startOfLocalDay(now);
  if (today >= addMonths(start, 13)) return "lapsed";
  if (today >= addMonths(start, 12)) return "grace";
  return "active";
}

export function mergeById(base, extra) {
  const map = new Map();
  const order = [];
  for (const item of base || []) {
    if (!item?.id || map.has(item.id)) continue;
    map.set(item.id, item);
    order.push(item.id);
  }
  for (const item of extra || []) {
    if (!item?.id) continue;
    if (!map.has(item.id)) order.push(item.id);
    map.set(item.id, { ...map.get(item.id), ...item });
  }
  return order.map((id) => map.get(id));
}

export function findOrganisation(organisations, id) {
  return organisations.find((org) => org.id === id) || null;
}

export function isListed(site, organisation, now = new Date()) {
  if (!site || !organisation) return false;
  if (subscriptionState(organisation.subscribedAt, now) === "lapsed") return false;
  if (subscriptionState(site.createdAt, now) === "lapsed") return false;
  return true;
}

export function displayYear(site) {
  const year = site?.buildYear || site?.yearStart || "";
  return site?.circa ? `c. ${year}` : String(year);
}

export function decadeOf(site) {
  const numeric = Number(site?.yearStart);
  const year = Number.isFinite(numeric) && numeric > 0
    ? numeric
    : Number(String(site?.buildYear || "").match(/\d{3,4}/)?.[0]);
  if (!Number.isFinite(year)) return null;
  return Math.floor(year / 10) * 10;
}

export function decadeLabel(site) {
  const decade = decadeOf(site);
  return decade == null ? "" : `${decade}s`;
}

export const MAX_PHOTOS = 20;
export const UNCATEGORISED = "Uncategorised";
export const DEFAULT_HERITAGE_CATEGORIES = ["Civic", "Industrial", "Recreation", "Transport"];
export const DEFAULT_SHOP_CATEGORIES = ["Restaurants", "Shops"];

export function organisationKind(org) {
  return org?.kind === "shop" ? "shop" : "site";
}

export function shopGroupOf(org, site) {
  if (organisationKind(org) !== "shop") return "";
  if (site?.shopGroup === "restaurants" || org?.shopGroup === "restaurants") return "restaurants";
  return "shops";
}

export function listingGroup(site, org) {
  return organisationKind(org) === "shop" ? shopGroupOf(org, site) : "sites";
}

export function uniqueCategoryNames(list, fallback = []) {
  const seen = new Set();
  const names = [];
  for (const item of list || []) {
    const name = String(item || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (!names.length) {
    for (const item of fallback) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(item);
    }
  }
  return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function categoriesForKind(kind, settings) {
  if (kind === "shop") return uniqueCategoryNames(settings?.shopCategories, DEFAULT_SHOP_CATEGORIES);
  return uniqueCategoryNames(settings?.heritageCategories, DEFAULT_HERITAGE_CATEGORIES);
}

export function renameSiteCategory(sites, from, to) {
  const nextName = String(to || "").trim() || UNCATEGORISED;
  return (sites || []).map((site) => (site.category === from ? { ...site, category: nextName } : site));
}

export function deleteSiteCategory(sites, name) {
  return (sites || []).map((site) => (site.category === name ? { ...site, category: UNCATEGORISED } : site));
}

function fieldText(site, field) {
  const values = {
    category: site.category,
    country: site.country,
    state: site.state,
    city: site.city,
    suburb: site.suburb,
    mapArea: site.mapArea,
    text: [site.name, site.description, site.suburb, site.category, site.mapArea, site.city, site.buildYear]
      .filter(Boolean)
      .join(" "),
  };
  return String(values[field] || "").toLowerCase();
}

function matchesDecade(site, query) {
  const decade = decadeOf(site);
  if (decade == null) return false;
  const digits = query.replace(/\D/g, "");
  if (digits.length < 3) return `${decade}s`.includes(query);
  return String(decade).startsWith(digits);
}

function matchesSearch(site, field, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  if (field === "decade") return matchesDecade(site, q);
  return fieldText(site, field).includes(q);
}

export function searchSites(sites, organisations, options = {}, now = new Date()) {
  const listed = sites.filter((site) => {
    const org = findOrganisation(organisations, site.organisationId);
    if (!isListed(site, org, now)) return false;
    if (options.group && listingGroup(site, org) !== options.group) return false;
    return true;
  });
  const filters = options.placeField || options.topicField || options.placeQuery || options.topicQuery
    ? [
      { field: options.placeField || "city", query: options.placeQuery || "" },
      { field: options.topicField || "text", query: options.topicQuery || "" },
    ]
    : [{ field: options.field || "text", query: options.query || "" }];
  return listed.filter((site) => filters.every((filter) => matchesSearch(site, filter.field, filter.query)));
}

export function formatPhotoCode(sponsorNumber, reference) {
  return `${Number(sponsorNumber)}-${String(Number(reference)).padStart(3, "0")}`;
}

export function parsePhotoCode(code) {
  const match = /^(\d+)-(\d{3})$/.exec(String(code || ""));
  if (!match) return null;
  return { sponsorNumber: Number(match[1]), reference: Number(match[2]) };
}

export function comparePhotoCodes(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function nextPhotoCode(sponsorNumber, existingCodes) {
  const sponsor = Number(sponsorNumber);
  let max = 0;
  for (const code of existingCodes) {
    const parsed = parsePhotoCode(code);
    if (parsed && parsed.sponsorNumber === sponsor) max = Math.max(max, parsed.reference);
  }
  return formatPhotoCode(sponsor, max + 1);
}

export function collectPhotoCodes(sites) {
  const codes = [];
  for (const site of sites) {
    for (const photo of site.photos || []) {
      if (photo.code) codes.push(photo.code);
    }
  }
  return codes;
}

export function photosInCodeOrder(photos) {
  return [...(photos || [])].sort((a, b) => comparePhotoCodes(a.code, b.code));
}
