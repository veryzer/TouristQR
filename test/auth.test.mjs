import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, validUsername, verifyPassword, verifyUserPassword } from "../js/auth.js";
import { applyRestore, buildBackup, sitesForActor } from "../js/backup.js";

test("site admin password verifies and a wrong password does not", () => {
  const { salt, hash } = hashPassword("rotsaP777T");
  assert.equal(verifyPassword("rotsaP777T", salt, hash), true);
  assert.equal(verifyPassword("wrong", salt, hash), false);
});

test("stored pastor login matches the users file", async () => {
  const { readFile } = await import("node:fs/promises");
  const users = JSON.parse(await readFile(new URL("../data/users.json", import.meta.url), "utf8"));
  const pastor = users.find((user) => user.username === "pastor");
  assert.equal(pastor.role, "site-admin");
  assert.equal(verifyUserPassword("rotsaP777T", pastor), true);
});

test("usernames are lowercase letters, numbers, dots, hyphens, or underscores", () => {
  assert.equal(validUsername("pastor"), true);
  assert.equal(validUsername("ghs"), true);
  assert.equal(validUsername("ab"), false);
});

test("a sponsor only sees their own sites", () => {
  const sites = [
    { id: "a", organisationId: "one" },
    { id: "b", organisationId: "two" },
  ];
  const visible = sitesForActor(sites, { role: "sponsor", organisationId: "two" });
  assert.deepEqual(visible.map((site) => site.id), ["b"]);
});

test("full restore replaces the catalogue", () => {
  const next = applyRestore({
    currentOrganisations: [{ id: "old", name: "Old" }],
    currentSites: [{ id: "gone", organisationId: "old" }],
    backup: {
      version: 1,
      kind: "full",
      organisations: [{ id: "new", name: "New" }],
      sites: [{ id: "kept", organisationId: "new" }],
    },
    user: { role: "site-admin" },
  });
  assert.deepEqual(next.sites.map((site) => site.id), ["kept"]);
});

test("sponsor restore replaces only that sponsor", () => {
  const next = applyRestore({
    currentOrganisations: [
      { id: "one", number: 1, name: "One", email: "a@example.com", subscribedAt: "2026-01-01", createdAt: "2026-01-01" },
      { id: "two", number: 2, name: "Two", email: "b@example.com", subscribedAt: "2026-01-01", createdAt: "2026-01-01" },
    ],
    currentSites: [
      { id: "keep", organisationId: "one" },
      { id: "old-two", organisationId: "two" },
    ],
    backup: {
      version: 1,
      kind: "sponsor",
      organisationId: "two",
      organisations: [{ id: "two", name: "Two restored", email: "b@example.com", subscribedAt: "2026-01-01" }],
      sites: [{ id: "new-two", organisationId: "two" }],
    },
    user: { role: "sponsor", organisationId: "two" },
  });
  assert.deepEqual(next.sites.map((site) => site.id).sort(), ["keep", "new-two"]);
});

test("a sponsor cannot restore another sponsor", () => {
  assert.throws(() => applyRestore({
    currentOrganisations: [{ id: "one", number: 1 }],
    currentSites: [],
    backup: { version: 1, kind: "sponsor", organisationId: "two", organisations: [{ id: "two" }], sites: [] },
    user: { role: "sponsor", organisationId: "one" },
  }), /own sponsor/);
});

test("full backup contains every site", () => {
  const backup = buildBackup({
    kind: "full",
    organisations: [{ id: "one" }, { id: "two" }],
    sites: [{ id: "a", organisationId: "one" }, { id: "b", organisationId: "two" }],
  });
  assert.equal(backup.kind, "full");
  assert.equal(backup.sites.length, 2);
});
