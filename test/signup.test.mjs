import assert from "node:assert/strict";
import test from "node:test";
import { buildSignupRecords, findReferrer, listingKindFromType } from "../js/signup-records.js";

const organisations = [
  { number: 1, id: "city-of-greater-geelong", name: "City of Greater Geelong", kind: "site", email: "a@example.com", subscribedAt: "2026-03-01", extraMonths: 0 },
];
const sites = [{ id: "moorabool-wool-exchange", organisationId: "city-of-greater-geelong", photos: [] }];
const users = [{ username: "pastor", role: "site-admin" }];

test("signup type maps site shop and restaurant", () => {
  assert.equal(listingKindFromType("site").kind, "site");
  assert.equal(listingKindFromType("shop").shopGroup, "shops");
  assert.equal(listingKindFromType("restaurant").shopGroup, "restaurants");
});

test("signup creates a shop login listing and generic QR", () => {
  const built = buildSignupRecords({
    body: {
      type: "shop",
      businessName: "Corner Books",
      contactName: "Alex Wright",
      contactEmail: "alex@example.com",
      username: "cornerbooks",
      password: "password1",
      genericCode: "https://touristqr.com/Generic0001",
    },
    organisations,
    sites,
    users,
    now: new Date(2026, 9, 13),
  });
  assert.equal(built.generic.label, "Generic0001");
  assert.equal(built.site.id, "generic0001");
  assert.equal(built.organisation.kind, "shop");
  assert.equal(built.organisation.shopGroup, "shops");
  assert.equal(built.username, "cornerbooks");
  assert.match(built.email.text, /Login name: cornerbooks/);
  assert.match(built.email.text, /Your backups/);
  assert.match(built.email.text, /Download my data/);
  assert.match(built.email.text, /1 extra month/);
  assert.equal(built.publicUrl, "https://touristqr.com/Generic0001");
});

test("signup refuses a generic code that is already used", () => {
  assert.throws(() => buildSignupRecords({
    body: {
      type: "site",
      businessName: "New Hall",
      contactName: "Pat",
      contactEmail: "pat@example.com",
      username: "newhall",
      password: "password1",
      publicEmail: "hall@example.com",
      genericCode: "Generic0001",
    },
    organisations,
    sites: [...sites, { id: "generic0001", organisationId: "x", photos: [] }],
    users,
  }), /already used/);
});

test("a known referrer receives an extra month", () => {
  const built = buildSignupRecords({
    body: {
      type: "restaurant",
      businessName: "Pakington Kitchen Two",
      contactName: "Sam",
      contactEmail: "sam@example.com",
      username: "pak2",
      password: "password1",
      referredBy: "city-of-greater-geelong",
    },
    organisations,
    sites,
    users,
  });
  const referrer = built.organisations.find((org) => org.id === "city-of-greater-geelong");
  assert.equal(referrer.extraMonths, 1);
  assert.equal(built.organisation.referredBy, "city-of-greater-geelong");
});

test("findReferrer matches a login name or generic code", () => {
  const moreUsers = [...users, { username: "geelong", role: "sponsor", organisationId: "city-of-greater-geelong" }];
  assert.equal(findReferrer(organisations, sites, moreUsers, "geelong").id, "city-of-greater-geelong");
});
