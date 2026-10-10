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

export function searchSites(sites, organisations, { field = "text", query = "" } = {}, now = new Date()) {
  const listed = sites.filter((site) => isListed(site, findOrganisation(organisations, site.organisationId), now));
  const q = String(query || "").trim().toLowerCase();
  if (!q) return listed;
  return listed.filter((site) => {
    if (field === "decade") return matchesDecade(site, q);
    return fieldText(site, field).includes(q);
  });
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
