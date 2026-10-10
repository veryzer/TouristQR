import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  comparePhotoCodes,
  decadeLabel,
  findOrganisation,
  isListed,
  nextPhotoCode,
  parsePhotoCode,
  searchSites,
  subscriptionState,
} from "../js/model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = new Date(2026, 9, 10);
const sites = JSON.parse(fs.readFileSync(path.join(root, "data", "sites.json"), "utf8"));
const organisations = JSON.parse(fs.readFileSync(path.join(root, "data", "organisations.json"), "utf8"));

test("sample sponsors on 10 October 2026", () => {
  const state = Object.fromEntries(organisations.map((org) => [org.id, subscriptionState(org.subscribedAt, now)]));
  assert.deepEqual(state, {
    "city-of-greater-geelong": "active",
    "geelong-historical-society": "active",
    "south-barwon-historical-society": "grace",
    "barwon-waterfront-trust": "lapsed",
  });
});

test("archived sponsors leave the public list and stay on their address", () => {
  const listed = searchSites(sites, organisations, { field: "text", query: "" }, now).map((site) => site.id);
  assert.deepEqual(listed, [
    "moorabool-wool-exchange",
    "eastern-park-fernery",
    "newtown-signalmans-cottage",
    "rippleside-bathing-pavilion",
    "ormond-salt-store",
    "belmont-horse-tram-shed",
  ]);
  const kiosk = sites.find((site) => site.id === "western-beach-kiosk");
  assert.equal(isListed(kiosk, findOrganisation(organisations, kiosk.organisationId), now), false);
  assert.equal(searchSites(sites, organisations, { field: "text", query: "western beach" }, now).length, 0);
});

test("search uses suburb, decade, and map area", () => {
  const names = (field, query) => searchSites(sites, organisations, { field, query }, now).map((site) => site.name);
  assert.deepEqual(names("suburb", "Belmont"), ["Belmont Horse Tram Shed"]);
  assert.deepEqual(names("decade", "1880s"), ["Eastern Park Fernery", "Newtown Signalman's Cottage"]);
  assert.deepEqual(names("mapArea", "Waterfront"), ["Rippleside Bathing Pavilion"]);
  assert.deepEqual(names("category", "Transport"), ["Newtown Signalman's Cottage", "Belmont Horse Tram Shed"]);
  assert.equal(decadeLabel(sites.find((site) => site.id === "ormond-salt-store")), "1850s");
});

test("every photograph is sponsor number, hyphen, reference, and the file exists", () => {
  const seen = new Set();
  for (const site of sites) {
    const org = findOrganisation(organisations, site.organisationId);
    for (const photo of site.photos) {
      const parsed = parsePhotoCode(photo.code);
      assert.ok(parsed, photo.code);
      assert.equal(parsed.sponsorNumber, org.number);
      assert.equal(photo.url, `images/${photo.code}.jpg`);
      assert.equal(seen.has(photo.code), false);
      seen.add(photo.code);
      const file = path.join(root, "images", `${photo.code}.jpg`);
      const bytes = fs.readFileSync(file);
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
    }
  }
  const ordered = [...seen].sort(comparePhotoCodes);
  assert.deepEqual(ordered.slice(0, 3), ["1-001", "1-002", "1-003"]);
  assert.equal(ordered.at(-1), "4-008");
  assert.equal(nextPhotoCode(1, ordered), "1-009");
  assert.equal(nextPhotoCode(2, ordered), "2-009");
});
