import assert from "node:assert/strict";
import test from "node:test";
import { appPath, genericPublicUrl, publicPhotoUrl, sitePublicUrl } from "../js/config.js";
import {
  extraMonthsOf,
  formatPhotoCode,
  isListed,
  listingIdFromPlaceName,
  mergeById,
  normalizePublicHttpUrl,
  mergePublicCatalogue,
  genericListingTaken,
  nextGenericCode,
  nextPhotoCode,
  nextUnusedGenericCodes,
  parseGenericCode,
  parsePhotoCode,
  subscriptionState,
} from "../js/model.js";

const october = new Date(2026, 9, 10);

test("a subscription stays public through the grace month", () => {
  assert.equal(subscriptionState("2025-10-01", new Date(2026, 8, 30)), "active");
  assert.equal(subscriptionState("2025-10-01", new Date(2026, 9, 1)), "grace");
  assert.equal(subscriptionState("2025-10-01", october), "grace");
  assert.equal(subscriptionState("2025-10-01", new Date(2026, 9, 31)), "grace");
});

test("a subscription is archived after 13 months", () => {
  assert.equal(subscriptionState("2025-08-01", october), "lapsed");
  assert.equal(subscriptionState("2025-10-01", new Date(2026, 10, 1)), "lapsed");
});

test("a new subscription is active", () => {
  assert.equal(subscriptionState("2026-03-01", october), "active");
  assert.equal(subscriptionState("2026-06-01", october), "active");
});

test("admin addresses stay at the site root", () => {
  assert.equal(appPath("/admin"), "/");
  assert.equal(appPath("/admin/"), "/");
  assert.equal(appPath("/admin.html"), "/");
  assert.equal(appPath("/signup.html"), "/");
  assert.equal(appPath("/Generic0001"), "/");
  assert.equal(appPath("/index.html"), "/");
  assert.equal(appPath("/"), "/");
});

test("printed QR codes open touristqr.com", () => {
  assert.equal(sitePublicUrl("moorabool-wool-exchange"), "https://touristqr.com/?site=moorabool-wool-exchange");
  assert.equal(sitePublicUrl("generic0001"), "https://touristqr.com/Generic0001");
  assert.equal(genericPublicUrl("Generic0007"), "https://touristqr.com/Generic0007");
});

test("generic QR codes parse from printed URLs", () => {
  assert.equal(parseGenericCode("https://www.touristQR.com/Generic0001").listingId, "generic0001");
  assert.equal(parseGenericCode("generic0001").label, "Generic0001");
  assert.equal(nextGenericCode([{ id: "generic0002" }]).label, "Generic0003");
});

test("instant signup sheets skip generic numbers already used", () => {
  const batch = nextUnusedGenericCodes([{ id: "generic0001" }, { id: "generic0003" }], 1, 4, true);
  assert.deepEqual(batch.codes.map((item) => item.label), ["Generic0002", "Generic0004", "Generic0005", "Generic0006"]);
  assert.deepEqual(batch.skipped, [1, 3]);
  const keepUsed = nextUnusedGenericCodes([{ id: "generic0001" }], 1, 2, false);
  assert.equal(keepUsed.codes[0].label, "Generic0001");
});

test("generic listing use follows sites and sponsor referral codes", () => {
  const generic = parseGenericCode("Generic0007");
  const sites = [{ id: generic.listingId, organisationId: "shop-x", photos: [] }];
  const orgs = [{ id: "shop-x", referralCode: generic.label }];
  assert.equal(genericListingTaken(sites, orgs, generic), true);
  assert.equal(genericListingTaken([], orgs, generic), true);
  assert.equal(genericListingTaken([], [], generic), false);
  assert.equal(nextUnusedGenericCodes([], 7, 1, true, []).codes[0].label, "Generic0007");
});

test("referral months extend the public listing", () => {
  assert.equal(subscriptionState("2025-10-01", october, 1), "active");
  assert.equal(extraMonthsOf({ extraMonths: 2 }), 2);
  const org = { subscribedAt: "2025-08-01", extraMonths: 2 };
  const site = { createdAt: "2025-08-01" };
  assert.equal(isListed(site, org, october), true);
});

test("local records merge onto the published catalogue", () => {
  const merged = mergeById([{ id: "a", name: "Published" }], [{ id: "a", name: "Edited" }, { id: "b", name: "New" }]);
  assert.deepEqual(merged, [{ id: "a", name: "Edited" }, { id: "b", name: "New" }]);
});

test("public catalogue keeps server listings over stale local copies", () => {
  const merged = mergePublicCatalogue(
    [{ id: "a", name: "Published", description: "Live" }],
    [{ id: "a", name: "Stale phone draft" }, { id: "offline-only", name: "Draft" }],
  );
  assert.deepEqual(merged, [
    { id: "a", name: "Published", description: "Live" },
    { id: "offline-only", name: "Draft" },
  ]);
});

test("public photo URLs carry a cache-bust token", () => {
  const site = { updatedAt: "2026-10-15T12:00:00.000Z" };
  const photo = { url: "https://touristqr.com/images/1-001.jpg", mediaVersion: 1730000000123 };
  assert.match(publicPhotoUrl(photo, site), /v=1730000000123/);
  assert.match(publicPhotoUrl({ url: "https://touristqr.com/images/1-002.jpg" }, site), /v=2026-10-15/);
  assert.match(publicPhotoUrl({ url: "https://touristqr.com/images/1-003.jpg" }, null, 999001), /v=999001/);
});

test("listing ids slug place names and append 2 when taken", () => {
  assert.equal(listingIdFromPlaceName("Moorabool Wool Exchange!", []), "moorabool-wool-exchange");
  assert.equal(
    listingIdFromPlaceName("Moorabool Wool Exchange", ["moorabool-wool-exchange"]),
    "moorabool-wool-exchange2",
  );
  assert.equal(
    listingIdFromPlaceName("Moorabool Wool Exchange", ["moorabool-wool-exchange", "moorabool-wool-exchange2"]),
    "moorabool-wool-exchange3",
  );
});

test("photo codes sort by sponsor, then reference", () => {
  assert.equal(formatPhotoCode(1, 9), "1-009");
  assert.equal(parsePhotoCode("1-009").reference, 9);
  assert.equal(parsePhotoCode("1-9"), null);
  assert.equal(parsePhotoCode("10-009").sponsorNumber, 10);
  assert.equal(nextPhotoCode(1, ["1-001", "1-008", "2-004"]), "1-009");
  assert.equal(nextPhotoCode(4, ["4-001", "4-008"]), "4-009");
  assert.equal(nextPhotoCode(5, ["1-001"]), "5-001");
});

test("normalizePublicHttpUrl adds https like a browser", () => {
  assert.equal(normalizePublicHttpUrl(""), "");
  assert.equal(normalizePublicHttpUrl("  "), "");
  assert.equal(normalizePublicHttpUrl("example.com"), "https://example.com/");
  assert.equal(normalizePublicHttpUrl("www.club.org.au/page"), "https://www.club.org.au/page");
  assert.equal(normalizePublicHttpUrl("http://legacy.test/path"), "http://legacy.test/path");
  assert.equal(normalizePublicHttpUrl("//cdn.example.com/x"), "https://cdn.example.com/x");
  assert.equal(normalizePublicHttpUrl("not a url"), "");
});
