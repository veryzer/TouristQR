import { sitePublicUrl } from "./config.js";
import {
  displayYear,
  findOrganisation,
  isListed,
  photosInCodeOrder,
  searchSites,
} from "./model.js";

const FAVOURITES = "touristqr_favourites";
const VISITS = "touristqr_visits";
const TOUR = "touristqr_tour";

const placeholders = {
  category: "Civic, Recreation, Transport…",
  country: "Australia",
  state: "Victoria",
  city: "Geelong",
  suburb: "Belmont, Newtown, Rippleside…",
  mapArea: "Central, Waterfront, River…",
  decade: "1880s",
  text: "Wool, tram, pavilion…",
};

const state = {
  sites: [],
  organisations: [],
  results: [],
  index: 0,
  current: null,
  browsing: "results",
  gallery: [],
  photoIndex: 0,
  pointer: null,
};

let html5QrCode = null;

const $ = (id) => document.getElementById(id);

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "");
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function setNote(message) {
  $("footer-note").textContent = message || "";
}

function setModal(id, open) {
  const modal = $(id);
  modal.classList.toggle("hidden", !open);
  modal.classList.toggle("flex", open);
}

function setStackButton(button, icon, label) {
  button.replaceChildren();
  const glyph = document.createElement("span");
  glyph.className = "text-base";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = icon;
  button.append(glyph, document.createTextNode(label));
}

function sitesFromIds(ids) {
  return ids.map((id) => state.sites.find((site) => site.id === id)).filter(Boolean);
}

function rememberVisit(id) {
  const visits = readJson(VISITS, []).filter((item) => item && item.id !== id);
  visits.unshift({ id, at: new Date().toISOString() });
  writeJson(VISITS, visits.slice(0, 40));
}

function resultLabel(site) {
  const parts = [];
  const names = { saved: "Saved", visited: "Visited", tour: "Tour" };
  if (names[state.browsing]) parts.push(names[state.browsing]);
  const org = findOrganisation(state.organisations, site.organisationId);
  if (!isListed(site, org)) parts.push("Archived listing");
  const pos = state.results.findIndex((item) => item.id === site.id);
  if (pos >= 0) parts.push(`${pos + 1} of ${state.results.length}`);
  if (state.browsing === "tour" && pos >= 0 && state.results.length > 1) {
    const next = state.results[(pos + 1) % state.results.length];
    parts.push(`Next: ${next.name}`);
  }
  return parts.join(" · ");
}

function showModes(mode) {
  $("view-full").classList.toggle("hidden", mode !== "full");
  $("view-lapsed").classList.toggle("hidden", mode !== "lapsed");
  $("view-empty").classList.toggle("hidden", mode !== "empty");
  $("view-missing").classList.toggle("hidden", mode !== "missing");
  $("year-row").classList.toggle("hidden", mode === "empty" || mode === "missing");
  $("tour-toggle").classList.toggle("hidden", mode !== "full");
  const rich = mode === "full";
  $("maps-link").classList.toggle("pointer-events-none", !rich);
  $("maps-link").classList.toggle("opacity-40", !rich);
  if (rich) $("maps-link").removeAttribute("aria-disabled");
  else $("maps-link").setAttribute("aria-disabled", "true");
  $("save-btn").disabled = !rich;
  $("save-btn").classList.toggle("opacity-40", !rich);
  $("prev-site").disabled = state.results.length === 0;
  $("next-site").disabled = state.results.length === 0;
}

function setSponsor(org, site) {
  const badge = $("sponsor-badge");
  if (!org || !site) {
    badge.textContent = "TouristQR";
    badge.removeAttribute("href");
    return;
  }
  badge.textContent = `Sponsored by ${org.name}`;
  const body = `Comment about ${site.name}.\n${sitePublicUrl(site.id)}\n`;
  badge.href = `mailto:${org.email}?subject=${encodeURIComponent("TouristQR.com")}&body=${encodeURIComponent(body)}`;
}

function showPhoto(index) {
  const count = state.gallery.length;
  if (!count) return;
  state.photoIndex = (index + count) % count;
  const photo = state.gallery[state.photoIndex];
  const image = $("primary-image");
  image.src = photo.url;
  image.alt = photo.caption || state.current?.name || "Site photograph";
  image.classList.toggle("is-historical", photo.kind === "historical");
  $("photo-code").textContent = photo.code;
  $("photo-status").textContent = `Photograph ${photo.code}, ${state.photoIndex + 1} of ${count}`;
  $("photo-prev").classList.toggle("hidden", count < 2);
  $("photo-next").classList.toggle("hidden", count < 2);

  const dots = $("photo-dots");
  dots.replaceChildren();
  state.gallery.forEach((_, dotIndex) => {
    const dot = document.createElement("span");
    dot.className = `w-1.5 h-1.5 rounded-full ${dotIndex === state.photoIndex ? "bg-white" : "bg-white/50"}`;
    dots.append(dot);
  });

  const thumbs = $("thumbnails-container");
  thumbs.replaceChildren();
  state.gallery.forEach((item, thumbIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `shrink-0 w-[31%] overflow-hidden rounded-lg shadow-sm bg-slate-200 aspect-[4/3] border-2 ${thumbIndex === state.photoIndex ? "border-blue-600" : "border-transparent"}`;
    button.setAttribute("aria-label", `Show photograph ${item.code}`);
    const thumb = document.createElement("img");
    thumb.src = item.url;
    thumb.alt = "";
    thumb.className = "w-full h-full object-cover";
    button.append(thumb);
    button.addEventListener("click", () => showPhoto(thumbIndex));
    thumbs.append(button);
  });
}

function renderFull(site) {
  state.gallery = photosInCodeOrder(site.photos);
  state.photoIndex = 0;
  $("site-description").textContent = site.description || "";
  $("maps-link").href = `https://maps.google.com/?q=${encodeURIComponent(site.mapsQuery || site.name)}`;
  const saved = readJson(FAVOURITES, []).includes(site.id);
  setStackButton($("save-btn"), saved ? "✅" : "⭐", saved ? "Saved" : "Save");
  const onTour = readJson(TOUR, []).includes(site.id);
  $("tour-toggle").textContent = onTour ? "Remove from tour" : "Add to tour";

  const historical = state.gallery.find((photo) => photo.kind === "historical") || null;
  $("oldest-section").classList.toggle("hidden", !historical);
  if (historical) {
    $("oldest-img").src = historical.url;
    $("oldest-img").alt = historical.caption || "Oldest known photograph";
    $("oldest-code").textContent = historical.code;
    $("oldest-caption").textContent = historical.caption ? ` ${historical.caption}` : "";
  }
  if (state.gallery.length) showPhoto(0);
}

function openSite(site) {
  state.current = site;
  const org = findOrganisation(state.organisations, site.organisationId);
  const listed = isListed(site, org);
  const address = new URL(window.location.href);
  address.searchParams.set("site", site.id);
  history.replaceState(null, "", `${address.pathname}${address.search}`);
  document.title = `${site.name} · TouristQR`;
  $("place-name").textContent = site.name;
  $("build-year").textContent = displayYear(site);
  $("result-label").textContent = resultLabel(site);
  setSponsor(org, site);
  rememberVisit(site.id);
  if (!listed) {
    showModes("lapsed");
    return;
  }
  showModes("full");
  renderFull(site);
}

function showCurrent() {
  if (!state.results.length) {
    state.current = null;
    document.title = "TouristQR";
    $("place-name").textContent = state.browsing === "results" ? "No matches" : "Nothing saved here";
    $("build-year").textContent = "";
    $("result-label").textContent = "";
    setSponsor(null, null);
    showModes(state.browsing === "results" ? "empty" : "empty");
    $("view-empty").querySelector("p").textContent = state.browsing === "results"
      ? "Nothing public matches that search. Try a suburb, a decade such as 1880s, or part of a name."
      : "Nothing is stored on this phone for that list yet.";
    return;
  }
  openSite(state.results[state.index]);
}

function navigate(direction) {
  if (!state.results.length) return;
  const pos = state.results.findIndex((item) => item.id === state.current?.id);
  state.index = pos === -1
    ? (direction > 0 ? 0 : state.results.length - 1)
    : (pos + direction + state.results.length) % state.results.length;
  showCurrent();
}

function useList(ids, browsing) {
  state.results = sitesFromIds(ids);
  state.index = 0;
  state.browsing = browsing;
  showCurrent();
}

function toggleId(key, id) {
  const ids = readJson(key, []);
  const next = ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
  writeJson(key, next);
  return next.includes(id);
}

function emailSites(list, intro) {
  if (!list.length) {
    setNote(intro);
    return;
  }
  const body = list.map((site) => `${site.name}\n${sitePublicUrl(site.id)}`).join("\n\n");
  window.location.href = `mailto:?subject=${encodeURIComponent("TouristQR.com")}&body=${encodeURIComponent(body)}`;
}

function openZoom(src, alt) {
  if (!src) return;
  $("modal-image").src = src;
  $("modal-image").alt = alt || "Zoomed photograph";
  setModal("image-modal", true);
}

function startScanner() {
  if (typeof Html5Qrcode === "undefined") {
    setNote("The scanner could not be loaded.");
    return;
  }
  setModal("scanner-modal", true);
  html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    (value) => {
      stopScanner();
      window.location.href = value;
    },
    () => {}
  ).catch(() => {
    setNote("The camera is unavailable or permission was denied.");
    stopScanner();
  });
}

function stopScanner() {
  setModal("scanner-modal", false);
  if (!html5QrCode) return;
  const scanner = html5QrCode;
  html5QrCode = null;
  scanner.stop().catch(() => {});
}

function bindPhotoSwipe() {
  const frame = $("photo-frame");
  frame.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    state.pointer = { x: event.clientX, y: event.clientY };
  });
  frame.addEventListener("pointerup", (event) => {
    if (!state.pointer || event.target.closest("button")) {
      state.pointer = null;
      return;
    }
    const dx = event.clientX - state.pointer.x;
    const dy = event.clientY - state.pointer.y;
    state.pointer = null;
    if (Math.abs(dx) < 30 && Math.abs(dy) < 30) {
      openZoom($("primary-image").src, $("primary-image").alt);
      return;
    }
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) showPhoto(state.photoIndex + (dx < 0 ? 1 : -1));
  });
  frame.addEventListener("pointercancel", () => {
    state.pointer = null;
  });
}

async function init() {
  try {
    const [sites, organisations] = await Promise.all([
      fetch("data/sites.json").then((response) => response.json()),
      fetch("data/organisations.json").then((response) => response.json()),
    ]);
    state.sites = sites;
    state.organisations = organisations;
  } catch {
    $("place-name").textContent = "Sites unavailable";
    $("result-label").textContent = "Start the app with node server.mjs so the shared catalogue can load.";
    return;
  }

  state.results = searchSites(state.sites, state.organisations, { field: "text", query: "" });
  const requested = new URLSearchParams(window.location.search).get("site");
  if (requested) {
    const site = state.sites.find((item) => item.id === requested);
    if (!site) {
      $("place-name").textContent = "Site not found";
      $("result-label").textContent = "";
      showModes("missing");
      setSponsor(null, null);
    } else {
      const pos = state.results.findIndex((item) => item.id === site.id);
      if (pos >= 0) state.index = pos;
      openSite(site);
    }
  } else {
    showCurrent();
  }
}

$("prev-site").addEventListener("click", () => navigate(-1));
$("next-site").addEventListener("click", () => navigate(1));
$("photo-prev").addEventListener("click", () => showPhoto(state.photoIndex - 1));
$("photo-next").addEventListener("click", () => showPhoto(state.photoIndex + 1));
$("oldest-open").addEventListener("click", () => openZoom($("oldest-img").src, $("oldest-img").alt));
$("scan-btn").addEventListener("click", startScanner);
$("scanner-close").addEventListener("click", stopScanner);
$("about-open").addEventListener("click", () => setModal("about-modal", true));
$("about-close").addEventListener("click", () => setModal("about-modal", false));
$("about-dismiss").addEventListener("click", () => setModal("about-modal", false));
$("image-modal").addEventListener("click", () => setModal("image-modal", false));

$("save-btn").addEventListener("click", () => {
  if (!state.current || $("save-btn").disabled) return;
  const saved = toggleId(FAVOURITES, state.current.id);
  setStackButton($("save-btn"), saved ? "✅" : "⭐", saved ? "Saved" : "Save");
  setNote(saved ? "Saved on this phone." : "Removed from saved places.");
});

$("tour-toggle").addEventListener("click", () => {
  if (!state.current) return;
  const included = toggleId(TOUR, state.current.id);
  $("tour-toggle").textContent = included ? "Remove from tour" : "Add to tour";
  setNote(included ? "Added to the tour on this phone." : "Removed from the tour.");
  if (state.browsing === "tour") useList(readJson(TOUR, []), "tour");
});

$("saved-btn").addEventListener("click", () => useList(readJson(FAVOURITES, []), "saved"));
$("visited-btn").addEventListener("click", () => useList(readJson(VISITS, []).map((item) => item.id), "visited"));
$("tour-btn").addEventListener("click", () => useList(readJson(TOUR, []), "tour"));

$("email-saved").addEventListener("click", () => {
  emailSites(sitesFromIds(readJson(FAVOURITES, [])), "There are no saved places on this phone yet.");
});
$("email-tour").addEventListener("click", () => {
  emailSites(sitesFromIds(readJson(TOUR, [])), "There are no tour stops on this phone yet.");
});

$("search-field").addEventListener("change", () => {
  $("search-input").placeholder = placeholders[$("search-field").value] || "";
});

$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.results = searchSites(state.sites, state.organisations, {
    field: $("search-field").value,
    query: $("search-input").value,
  });
  state.index = 0;
  state.browsing = "results";
  setNote(state.results.length ? `${state.results.length} public ${state.results.length === 1 ? "site" : "sites"}.` : "");
  showCurrent();
  $("place-name").scrollIntoView({ block: "start" });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  setModal("about-modal", false);
  setModal("image-modal", false);
  stopScanner();
});

bindPhotoSwipe();
init();
