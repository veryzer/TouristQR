import assert from "node:assert/strict";
import test from "node:test";
import { appPath } from "../js/config.js";
import {
  formatPhotoCode,
  mergeById,
  nextPhotoCode,
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

test("admin addresses stay inside the GitHub project", () => {
  assert.equal(appPath("/TouristQR/admin"), "/TouristQR/");
  assert.equal(appPath("/TouristQR/admin/"), "/TouristQR/");
  assert.equal(appPath("/TouristQR/admin.html"), "/TouristQR/");
  assert.equal(appPath("/TouristQR/index.html"), "/TouristQR/");
  assert.equal(appPath("/"), "/");
});

test("local records merge onto the published catalogue", () => {
  const merged = mergeById([{ id: "a", name: "Published" }], [{ id: "a", name: "Edited" }, { id: "b", name: "New" }]);
  assert.deepEqual(merged, [{ id: "a", name: "Edited" }, { id: "b", name: "New" }]);
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
