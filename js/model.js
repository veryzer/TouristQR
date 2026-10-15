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

export function extraMonthsOf(org) {
  const n = Number(org?.extraMonths);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 120);
}

// Active for 12 months (+ referral months), still public during the following grace month, then archived.
export function subscriptionState(startIso, now = new Date(), extraMonths = 0) {
  const start = parseISODate(startIso);
  if (!start) return "lapsed";
  const extra = Number(extraMonths) > 0 ? Math.floor(Number(extraMonths)) : 0;
  const today = startOfLocalDay(now);
  if (today >= addMonths(start, 13 + extra)) return "lapsed";
  if (today >= addMonths(start, 12 + extra)) return "grace";
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

/** Public visitor catalogue: server wins; local entries are only offline-only listings. */
export function mergePublicCatalogue(serverItems, localItems) {
  const server = serverItems || [];
  const local = localItems || [];
  const onServer = new Set(server.map((item) => item?.id).filter(Boolean));
  const offlineOnly = local.filter((item) => item?.id && !onServer.has(item.id));
  return [...server, ...offlineOnly];
}

export function findOrganisation(organisations, id) {
  return organisations.find((org) => org.id === id) || null;
}

export function isListed(site, organisation, now = new Date()) {
  if (!site || !organisation) return false;
  const extra = extraMonthsOf(organisation);
  if (subscriptionState(organisation.subscribedAt, now, extra) === "lapsed") return false;
  if (subscriptionState(site.createdAt, now, extra) === "lapsed") return false;
  return true;
}

export function formatGenericCode(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1 || n > 999999) return null;
  const digits = String(n).padStart(4, "0");
  return { number: n, digits, label: `Generic${digits}`, listingId: `generic${digits}` };
}

export function parseGenericCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = /generic\s*0*(\d{1,6})/i.exec(raw);
  if (!match) return null;
  return formatGenericCode(Number(match[1]));
}

export function usedGenericNumbers(sites, organisations = []) {
  const nums = new Set();
  for (const site of sites || []) {
    const parsed = parseGenericCode(site.id) || parseGenericCode(site.genericCode);
    if (parsed) nums.add(parsed.number);
  }
  for (const org of organisations || []) {
    const parsed = parseGenericCode(org.referralCode) || parseGenericCode(org.id);
    if (parsed) nums.add(parsed.number);
  }
  return nums;
}

export function genericListingTaken(sites, organisations, generic) {
  if (!generic) return true;
  const listingId = generic.listingId;
  if ((sites || []).some((site) => site.id === listingId)) return true;
  if ((organisations || []).some((org) => org.id === listingId)) return true;
  if ((organisations || []).some((org) => parseGenericCode(org.referralCode)?.listingId === listingId)) return true;
  return false;
}

export function genericLabelsForSponsor(sites, organisations, organisationId) {
  const labels = new Set();
  const org = (organisations || []).find((item) => item.id === organisationId);
  for (const site of (sites || []).filter((item) => item.organisationId === organisationId)) {
    for (const raw of [site.id, site.genericCode]) {
      const parsed = parseGenericCode(raw);
      if (parsed) labels.add(parsed.label);
    }
  }
  for (const raw of [org?.id, org?.referralCode]) {
    const parsed = parseGenericCode(raw);
    if (parsed) labels.add(parsed.label);
  }
  return [...labels];
}

export function nextGenericCode(sites, organisations = []) {
  let max = 0;
  for (const n of usedGenericNumbers(sites, organisations)) max = Math.max(max, n);
  return formatGenericCode(max + 1);
}

export function nextUnusedGenericCodes(sites, start, count = 9, skipUsed = true, organisations = []) {
  const used = skipUsed ? usedGenericNumbers(sites, organisations) : new Set();
  const wanted = Math.max(1, Math.min(99, Number(count) || 9));
  let n = Math.floor(Number(start));
  if (!Number.isInteger(n) || n < 1) n = 1;
  const codes = [];
  const skipped = [];
  while (codes.length < wanted && n <= 999999) {
    if (used.has(n)) skipped.push(n);
    else codes.push(formatGenericCode(n));
    n += 1;
  }
  return { codes, skipped, next: n };
}

export function displayYear(site) {
  const year = String(site?.buildYear || "").trim();
  if (!year) return "";
  return site?.circa ? `c. ${year}` : year;
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
export const DEFAULT_EXHIBIT_CATEGORIES = ["Collectibles", "Industrial", "Transport", "Uncategorised"];

export function organisationKind(org) {
  const kind = String(org?.kind || "").trim().toLowerCase();
  if (kind === "shop") return "shop";
  if (kind === "exhibit") return "exhibit";
  return "site";
}

export function shopGroupOf(org, site) {
  if (organisationKind(org) !== "shop") return "";
  if (site?.shopGroup === "restaurants" || org?.shopGroup === "restaurants") return "restaurants";
  return "shops";
}

export function listingGroup(site, org) {
  const kind = organisationKind(org);
  if (kind === "shop") return shopGroupOf(org, site);
  if (kind === "exhibit") return "exhibits";
  return "sites";
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
  if (kind === "exhibit") return uniqueCategoryNames(settings?.exhibitCategories, DEFAULT_EXHIBIT_CATEGORIES);
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
    name: site.name,
    category: site.category,
    country: site.country,
    state: site.state,
    city: site.city,
    suburb: site.suburb,
    mapArea: site.mapArea,
    text: [site.name, site.description, site.suburb, site.category, site.mapArea, site.city, site.state, site.buildYear]
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
  if (fieldText(site, field).includes(q)) return true;
  if (field === "text" || field === "name") return false;
  return String(site.name || "").toLowerCase().includes(q);
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

export function slugifyListingId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Lowercase slug from a place name; if taken, append 2, 3, … (max 80 chars). */
export function listingIdFromPlaceName(name, usedIds, { excludeId = "", fallback = "site" } = {}) {
  const used = new Set((usedIds || []).filter((id) => id && id !== excludeId));
  const base = slugifyListingId(name) || fallback;
  if (!used.has(base)) return base;
  let n = 2;
  for (;;) {
    const suffix = String(n);
    const trimmed = base.slice(0, Math.max(1, 80 - suffix.length));
    const id = `${trimmed}${suffix}`;
    if (!used.has(id)) return id;
    n += 1;
  }
}

/** Turn partial URLs (example.com) into absolute https links for hrefs and storage. */
export function normalizePublicHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let candidate = raw;
  if (/^\/\//.test(candidate)) candidate = `https:${candidate}`;
  else if (!/^https?:\/\//i.test(candidate)) {
    if (/^(www\.|[a-z0-9-]+(\.[a-z0-9-]+)+)/i.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return "";
    }
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}
