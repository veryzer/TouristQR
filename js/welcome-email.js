import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addMonths, parseISODate } from "./model.js";
import { publicBaseUrl } from "./config.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const defaultWelcomeSignupTemplatePath = path.join(moduleDir, "..", "content", "welcome-signup-email.json");

let cachedTemplate = null;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDay(iso) {
  const date = parseISODate(iso);
  if (!date) return iso || "";
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function toIsoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function renderTemplate(template, vars, htmlEscape) {
  let out = String(template || "");
  for (const [key, value] of Object.entries(vars)) {
    const text = htmlEscape ? escapeHtml(value) : String(value ?? "");
    out = out.split(`{{${key}}}`).join(text);
  }
  return out;
}

export function loadWelcomeSignupTemplate(templatePath = defaultWelcomeSignupTemplatePath) {
  if (cachedTemplate && templatePath === defaultWelcomeSignupTemplatePath) {
    return cachedTemplate;
  }
  const raw = fs.readFileSync(templatePath, "utf8");
  const parsed = JSON.parse(raw);
  if (templatePath === defaultWelcomeSignupTemplatePath) {
    cachedTemplate = parsed;
  }
  return parsed;
}

export function welcomeEmailVars({
  contactName,
  businessName,
  listingKind,
  username,
  password,
  publicUrl,
  genericLabel,
  subscribedAt,
  extraMonths = 0,
  loginUrl,
}) {
  const first = String(contactName || "").trim() || "there";
  const business = String(businessName || "").trim() || "your listing";
  const kindWord = listingKind === "restaurant" ? "restaurant" : listingKind === "shop" ? "shop" : "site";
  const start = parseISODate(subscribedAt) || new Date();
  const publicUntil = addMonths(start, 12 + extraMonths);
  const graceUntil = addMonths(start, 13 + extraMonths);
  const adminUrl = loginUrl || `${publicBaseUrl.replace(/\/?$/, "/")}admin.html`;
  const extraMonthsSuffix = extraMonths
    ? ` This already includes ${extraMonths} extra month${extraMonths === 1 ? "" : "s"} from referrals.`
    : "";
  return {
    contactFirstName: first,
    businessName: business,
    kindWord,
    publicUrl: String(publicUrl || ""),
    adminUrl,
    username: String(username || ""),
    password: String(password || ""),
    subscribedAtFormatted: formatDay(toIsoDate(start)),
    publicUntilFormatted: formatDay(toIsoDate(publicUntil)),
    graceUntilFormatted: formatDay(toIsoDate(graceUntil)),
    extraMonthsSuffix,
    genericLabel: String(genericLabel || ""),
    publicBaseUrl,
  };
}

export function welcomeEmail(info, options = {}) {
  const templatePath = options.templatePath || defaultWelcomeSignupTemplatePath;
  const template = options.template || loadWelcomeSignupTemplate(templatePath);
  const vars = welcomeEmailVars(info);
  return {
    subject: renderTemplate(template.subject, vars, false),
    text: renderTemplate(template.text, vars, false),
    html: renderTemplate(template.html, vars, true),
  };
}

export function adminBackupCalloutsFromTemplate(template) {
  return {
    sponsor: String(template?.adminSponsorBackupCallout || "").trim(),
    catalogue: String(template?.adminCatalogueBackupCallout || "").trim(),
  };
}
