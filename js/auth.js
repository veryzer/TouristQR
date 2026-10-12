import { pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const PBKDF2_ITERATIONS = 120000;

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = pbkdf2Sync(String(password), salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256").toString("hex");
  return { salt, hash, algo: "pbkdf2", iterations: PBKDF2_ITERATIONS };
}

function hashedBuffer(password, salt, hash, algo, iterations) {
  if (algo === "scrypt") {
    return scryptSync(String(password), salt, KEY_LENGTH);
  }
  return pbkdf2Sync(String(password), salt, Number(iterations) || PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

export function verifyPassword(password, salt, hash, algo = "pbkdf2", iterations) {
  if (!salt || !hash) return false;
  const actual = hashedBuffer(password, salt, hash, algo, iterations);
  const expected = Buffer.from(String(hash), "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function verifyUserPassword(password, user) {
  return verifyPassword(password, user?.salt, user?.hash, user?.algo, user?.iterations);
}

export function publicUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    role: user.role,
    organisationId: user.organisationId || null,
  };
}

export function isSiteAdmin(user) {
  return user?.role === "site-admin";
}

export function sponsorOrganisationId(user) {
  if (user?.role !== "sponsor") return null;
  return user.organisationId || null;
}

export function normaliseUsername(value) {
  return String(value || "").trim().toLowerCase();
}

export function validUsername(value) {
  return /^[a-z0-9._-]{3,40}$/.test(normaliseUsername(value));
}
