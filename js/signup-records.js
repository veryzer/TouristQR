import { extraMonthsOf, genericListingTaken, MAX_PHOTOS, nextGenericCode, nextPhotoCode, normalizePublicHttpUrl, parseGenericCode } from "./model.js";
import { extFromDataUrl } from "./photo-file.js";
import { genericPublicUrl, publicBaseUrl } from "./config.js";
import { normaliseUsername, validUsername } from "./auth.js";
import { welcomeEmail } from "./welcome-email.js";

export { welcomeEmail };

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function todayISO(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function listingKindFromType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (value === "shop" || value === "shops") return { kind: "shop", shopGroup: "shops", type: "Shop", category: "Shops" };
  if (value === "restaurant" || value === "restaurants") return { kind: "shop", shopGroup: "restaurants", type: "Restaurant", category: "Restaurants" };
  if (value === "site" || value === "sites") return { kind: "site", shopGroup: "", type: "Organisation", category: "Uncategorised" };
  return null;
}

export function findReferrer(organisations, sites, users, query) {
  const raw = String(query || "").trim();
  if (!raw) return null;
  const generic = parseGenericCode(raw);
  if (generic) {
    const byListing = (sites || []).find((site) => site.id === generic.listingId);
    if (byListing) return (organisations || []).find((org) => org.id === byListing.organisationId) || null;
    return (organisations || []).find((org) => org.referralCode === generic.label || org.id === generic.listingId) || null;
  }
  const login = normaliseUsername(raw);
  const user = (users || []).find((item) => item.username === login);
  if (user?.organisationId) {
    return (organisations || []).find((org) => org.id === user.organisationId) || null;
  }
  const key = raw.toLowerCase();
  const matches = (organisations || []).filter((org) => org.id === raw || String(org.name || "").toLowerCase() === key);
  return matches.length === 1 ? matches[0] : null;
}

function uniqueOrgId(preferred, organisations, listingId) {
  const base = slugify(preferred) || listingId;
  if (!(organisations || []).some((org) => org.id === base)) return base;
  return listingId;
}

export function buildSignupRecords({ body, organisations, sites, users, now = new Date() }) {
  const listing = listingKindFromType(body?.type);
  if (!listing) fail("Choose Site, Shop, or Restaurant.");
  const name = String(body?.businessName || body?.name || "").trim();
  if (!name) fail("Enter the business name.");
  const contactName = String(body?.contactName || "").trim().slice(0, 80);
  if (!contactName) fail("Enter the contact name.");
  const contactEmail = String(body?.contactEmail || "").trim().slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) fail("Enter the contact email address.");
  const username = normaliseUsername(body?.username || body?.loginName);
  if (!validUsername(username)) fail("A login name uses 3–40 letters, numbers, dots, hyphens, or underscores.");
  if ((users || []).some((item) => item.username === username)) fail("That login name is already used.");
  const password = String(body?.password || body?.loginPassword || "");
  if (password.length < 8) fail("Give the sponsor a password of at least 8 characters.");
  const publicEmail = listing.kind === "shop" ? "" : String(body?.publicEmail || body?.email || "").trim().slice(0, 120);
  if (listing.kind !== "shop" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(publicEmail)) {
    fail("Enter the public email address.");
  }
  const description = String(body?.description || "").trim();
  const websiteRaw = String(body?.website || body?.furtherReading || "").trim();
  const website = websiteRaw ? normalizePublicHttpUrl(websiteRaw) : "";
  if (websiteRaw && !website) fail("Enter a website like example.com or https://example.com, or leave it blank.");
  const photosIn = Array.isArray(body?.photos) ? body.photos : [];
  if (photosIn.length > MAX_PHOTOS) fail("A listing can have at most 20 photographs.");

  let generic = parseGenericCode(body?.genericCode || body?.listingId || "");
  if (generic) {
    if (genericListingTaken(sites, organisations, generic)) {
      fail(`That QR code (${generic.label}) is already used.`);
    }
  } else {
    generic = nextGenericCode(sites, organisations);
  }
  if (!generic) fail("Could not assign a listing QR code.");

  const subscribedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.subscribedAt || ""))
    ? String(body.subscribedAt)
    : todayISO(now);
  let number = 0;
  for (const org of organisations || []) number = Math.max(number, Number(org.number) || 0);
  number += 1;

  const listingId = generic.listingId;
  const organisationId = listing.kind === "shop"
    ? listingId
    : uniqueOrgId(name, organisations, listingId);
  if ((organisations || []).some((org) => org.id === organisationId)) fail("That listing is already in the catalogue.");
  if (genericListingTaken(sites, organisations, generic)) fail("That QR code is already used.");

  const referrer = findReferrer(organisations, sites, users, body?.referredBy);
  let referralNote = "";
  let nextOrganisations = [...(organisations || [])];
  if (String(body?.referredBy || "").trim() && !referrer) {
    referralNote = "Saved without a referral credit — that referrer was not found.";
  }
  if (referrer && referrer.id !== organisationId) {
    nextOrganisations = nextOrganisations.map((org) => (
      org.id === referrer.id ? { ...org, extraMonths: extraMonthsOf(org) + 1 } : org
    ));
  }

  const organisation = {
    number,
    id: organisationId,
    name,
    type: listing.type,
    kind: listing.kind,
    email: publicEmail,
    contactName,
    contactEmail,
    subscribedAt,
    createdAt: subscribedAt,
    referralCode: generic.label,
    extraMonths: 0,
    referredBy: referrer && referrer.id !== organisationId ? referrer.id : "",
  };
  if (listing.kind === "shop") organisation.shopGroup = listing.shopGroup;

  const existingCodes = [];
  for (const site of sites || []) {
    for (const photo of site.photos || []) {
      if (photo.code) existingCodes.push(photo.code);
    }
  }
  const photos = photosIn.map((photo) => {
    const code = nextPhotoCode(number, existingCodes);
    existingCodes.push(code);
    const dataUrl = photo?.dataUrl || photo?.jpeg || photo?.url || "";
    const ext = String(photo?.ext || extFromDataUrl(dataUrl) || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
    return {
      code,
      caption: String(photo?.caption || "").trim(),
      credit: String(photo?.credit || "").trim(),
      kind: photo?.kind === "historical" ? "historical" : "current",
      dataUrl,
      ext: ext === "jpeg" ? "jpg" : ext,
    };
  });

  const site = {
    id: listingId,
    organisationId,
    name,
    genericCode: generic.label,
    buildYear: "",
    yearStart: null,
    yearEnd: null,
    circa: false,
    category: listing.category,
    shopGroup: listing.shopGroup,
    country: "Australia",
    state: "Victoria",
    city: "Geelong",
    suburb: "",
    mapArea: "",
    mapsQuery: "",
    description,
    facts: [],
    furtherReading: website,
    sources: [],
    createdAt: subscribedAt,
    photos: photos.map((photo) => ({
      code: photo.code,
      url: `images/${photo.code}.${photo.ext}`,
      caption: photo.caption,
      credit: photo.credit,
      kind: photo.kind,
    })),
  };

  const publicUrl = genericPublicUrl(generic.label);
  const email = welcomeEmail({
    contactName,
    businessName: name,
    listingKind: listing.type === "Restaurant" ? "restaurant" : listing.kind === "shop" ? "shop" : "site",
    username,
    password,
    publicUrl,
    genericLabel: generic.label,
    subscribedAt,
    extraMonths: 0,
    loginUrl: `${publicBaseUrl.replace(/\/?$/, "/")}admin.html`,
  });

  return {
    organisations: [...nextOrganisations, organisation],
    sites: [...(sites || []), site],
    organisation,
    site,
    generic,
    publicUrl,
    username,
    password,
    contactEmail,
    photos,
    referrer: referrer && referrer.id !== organisationId ? referrer : null,
    referralNote,
    email,
  };
}
