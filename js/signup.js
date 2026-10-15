import { assetUrl, genericPublicUrl } from "./config.js?v=admin19";
import { MAX_PHOTOS, normalizePublicHttpUrl, parseGenericCode } from "./model.js?v=admin33";
import { preparePhotoFile } from "./photo-file.js?v=admin19";

const $ = (id) => document.getElementById(id);

let usePhpApi = false;
let listingType = "site";
let generic = null;
let photos = [];
let html5QrCode = null;
let saving = false;

function apiUrl(path) {
  if (!usePhpApi) return assetUrl(path);
  const stripped = path.replace(/^api\/?/, "");
  const qIndex = stripped.indexOf("?");
  const route = qIndex === -1 ? stripped : stripped.slice(0, qIndex);
  const extra = qIndex === -1 ? "" : stripped.slice(qIndex + 1);
  const params = new URLSearchParams(extra);
  params.set("r", route);
  return assetUrl(`api.php?${params}`);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof Blob) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(apiUrl(path), { credentials: "include", ...options, headers });
}

async function detectApi() {
  const native = await fetch(assetUrl("api/session"), { credentials: "include" });
  const type = String(native.headers.get("content-type") || "");
  if (native.status !== 404 && type.includes("json")) return native;
  usePhpApi = true;
  return fetch(apiUrl("api/session"), { credentials: "include" });
}

function setStatus(message, type = "info") {
  const el = $("status");
  el.className = type;
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

function applyType() {
  $("type-site").setAttribute("aria-pressed", String(listingType === "site"));
  $("type-shop").setAttribute("aria-pressed", String(listingType === "shop"));
  $("type-restaurant").setAttribute("aria-pressed", String(listingType === "restaurant"));
  $("public-email-wrap").classList.toggle("hidden", listingType !== "site");
  $("public-email").required = listingType === "site";
}

function qrLabel() {
  if (generic) return `${generic.label} — ${genericPublicUrl(generic.label)}`;
  return "Scan a printed Generic QR, or skip and we will email one.";
}

function setGeneric(parsed) {
  generic = parsed;
  $("qr-status").textContent = qrLabel();
}

async function loadQrLibrary() {
  if (typeof Html5Qrcode === "function") return;
  const src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("scanner"));
    document.head.appendChild(script);
  });
}

async function startScan() {
  try {
    await loadQrLibrary();
  } catch {
    setStatus("The camera scanner could not be loaded. Skip scan and we will email the QR code.", "info");
    return;
  }
  $("reader").classList.remove("hidden");
  $("stop-scan").classList.remove("hidden");
  html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 220, height: 220 } },
    (value) => {
      const parsed = parseGenericCode(value);
      stopScan();
      if (!parsed) {
        setStatus("That QR is not a TouristQR Generic code.", "err");
        return;
      }
      setGeneric(parsed);
      setStatus(`${parsed.label} ready to bind to this listing.`, "ok");
    },
    () => {}
  ).catch(() => {
    setStatus("Camera unavailable. Skip scan and we will email the QR code.", "info");
    stopScan();
  });
}

function stopScan() {
  $("reader").classList.add("hidden");
  $("stop-scan").classList.add("hidden");
  if (!html5QrCode) return;
  const scanner = html5QrCode;
  html5QrCode = null;
  scanner.stop().catch(() => {});
}

function renderPhotos() {
  const wrap = $("photo-list");
  wrap.replaceChildren();
  for (const photo of photos) {
    const img = document.createElement("img");
    img.src = photo.preview;
    img.alt = "";
    wrap.append(img);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read that photograph."));
    reader.readAsDataURL(blob);
  });
}

async function addPhotoFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    if (photos.length >= MAX_PHOTOS) {
      setStatus("A listing can have at most 20 photographs.", "info");
      break;
    }
    try {
      const prepared = await preparePhotoFile(file);
      const dataUrl = await blobToDataUrl(prepared.blob);
      photos.push({ dataUrl, ext: prepared.ext, preview: dataUrl, kind: "current" });
    } catch (error) {
      setStatus(error.message, "err");
    }
  }
  renderPhotos();
}

function loadQrious() {
  if (typeof QRious === "function") return Promise.resolve();
  const existing = document.querySelector("script[src*=\"qrious\"]");
  if (!existing) return Promise.resolve();
  return new Promise((resolve) => {
    existing.addEventListener("load", () => resolve(), { once: true });
    setTimeout(resolve, 800);
  });
}

function qrPngDataUrl(label) {
  const url = genericPublicUrl(label);
  if (!url || typeof QRious === "undefined") return "";
  const canvas = document.createElement("canvas");
  new QRious({
    element: canvas,
    value: url,
    size: 420,
    background: "#ffffff",
    foreground: "#0f172a",
  });
  return canvas.toDataURL("image/png");
}

function resetForm() {
  $("signup-form").reset();
  photos = [];
  generic = null;
  renderPhotos();
  setGeneric(null);
  applyType();
}

async function submitForm(event) {
  event.preventDefault();
  if (saving) return;
  saving = true;
  $("save").disabled = true;
  setStatus("Saving…", "info");
  try {
    await loadQrious();
    let bound = generic;
    if (!bound) {
      const metaResponse = await api("api/signup-meta");
      const meta = await metaResponse.json().catch(() => ({}));
      if (metaResponse.ok && meta.next?.label) bound = meta.next;
    }
    const websiteRaw = $("website").value.trim();
    if (websiteRaw && !normalizePublicHttpUrl(websiteRaw)) {
      throw new Error("Enter a website like example.com or https://example.com, or leave it blank.");
    }
    const payload = {
      type: listingType,
      businessName: $("business-name").value.trim(),
      contactName: $("contact-name").value.trim(),
      contactEmail: $("contact-email").value.trim(),
      username: $("login-name").value.trim(),
      password: $("login-password").value,
      publicEmail: listingType === "site" ? $("public-email").value.trim() : "",
      description: $("description").value.trim(),
      website: normalizePublicHttpUrl(websiteRaw),
      genericCode: bound?.label || "",
      referredBy: $("referred-by").value.trim(),
      qrPng: bound ? qrPngDataUrl(bound.label) : "",
      photos: photos.map((photo) => ({ dataUrl: photo.dataUrl, ext: photo.ext, kind: photo.kind })),
    };
    const response = await api("api/signup", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not save this signup.");
    const previewUrl = body.previewUrl || body.publicUrl || genericPublicUrl(body.generic?.label || body.listingId);
    if (previewUrl) window.open(previewUrl, "_blank", "noopener");
    const mail = body.emailSent
      ? `Welcome email sent to ${body.contactEmail}.`
      : (body.emailNote || "Saved. Welcome email sends on the live TouristQR host.");
    const extra = body.referralNote ? ` ${body.referralNote}` : "";
    resetForm();
    setStatus(`Saved ${body.businessName || "listing"}. Public page opened. ${mail}${extra}`, "ok");
  } catch (error) {
    setStatus(error.message, "err");
  } finally {
    saving = false;
    $("save").disabled = false;
  }
}

$("type-site").addEventListener("click", () => { listingType = "site"; applyType(); });
$("type-shop").addEventListener("click", () => { listingType = "shop"; applyType(); });
$("type-restaurant").addEventListener("click", () => { listingType = "restaurant"; applyType(); });
$("add-photo").addEventListener("click", () => $("photo-files").click());
$("photo-files").addEventListener("change", async (event) => {
  await addPhotoFiles(event.target.files || []);
  event.target.value = "";
});
$("scan-qr").addEventListener("click", startScan);
$("stop-scan").addEventListener("click", stopScan);
$("signup-form").addEventListener("submit", submitForm);

async function init() {
  applyType();
  try {
    const response = await detectApi();
    if (!response.ok) throw new Error("no-api");
    const body = await response.json();
    if (!body.user) {
      window.location.href = "admin.html";
      return;
    }
    if (body.user.role !== "site-admin") {
      window.location.href = "admin.html";
      return;
    }
  } catch {
    setStatus("Could not reach the server. Open this page after signing in as master admin.", "err");
  }
}

init();
