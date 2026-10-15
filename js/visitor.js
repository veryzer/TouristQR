import { assetUrl, publicPhotoUrl, sitePublicUrl } from "./config.js?v=generic5";
import {
  DEFAULT_HERITAGE_CATEGORIES,
  DEFAULT_SHOP_CATEGORIES,
  displayYear,
  findOrganisation,
  isListed,
  listingGroup,
  mergePublicCatalogue,
  normalizePublicHttpUrl,
  organisationKind,
  parseGenericCode,
  photosInCodeOrder,
  searchSites,
} from "./model.js?v=generic9";
import { LOCAL_ORGS, LOCAL_SITES, readLocal } from "./storage.js?v=generic5";

const FAVOURITES = "touristqr_favourites";
const VISITS = "touristqr_visits";
const TOUR = "touristqr_tour";

const placeholders = {
  category: "Civic, Recreation, Transport…",
  name: "Fernery, Little Malop Books…",
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
  group: "sites",
  categories: { heritage: DEFAULT_HERITAGE_CATEGORIES, shop: DEFAULT_SHOP_CATEGORIES },
  catalogRevision: 0,
};

let html5QrCode = null;
let historyUtterance = null;
let historyPaused = false;
let historyKeepAlive = 0;
let speechVoices = [];
let historyAudio = null;
let historyChunks = [];
let historyChunkIndex = 0;
let historyAudioPaused = false;
let audioTtsFallback = false;
let historyNativeChunks = [];
let historyNativeChunkIndex = 0;

function isApplePhone() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isDesktopBrowser() {
  if (isApplePhone()) return false;
  return !/Android|Mobi|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || "");
}

function isIOSSafari() {
  const ua = navigator.userAgent || "";
  return isApplePhone() && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(ua);
}

function speechSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function";
}

function useDeviceVoice() {
  return speechSupported() && (!isApplePhone() || isIOSSafari());
}

function isAndroidMobile() {
  return !isDesktopBrowser() && /Android/i.test(navigator.userAgent || "");
}

/** Play/stop only — avoids broken pause/resume on Android Chrome and on streamed iPhone audio. */
function ttsPlayStopOnly() {
  if (isAndroidMobile() && useDeviceVoice()) return true;
  return isApplePhone() && !useDeviceVoice();
}

function historySpeechActive() {
  if (historyAudio && !historyAudioPaused) return true;
  if (historyNativeChunks.length && historyNativeChunkIndex < historyNativeChunks.length) {
    try {
      if (window.speechSynthesis?.speaking) return true;
    } catch {
      return true;
    }
    if (historyUtterance) return true;
  }
  try {
    return Boolean(window.speechSynthesis?.speaking);
  } catch {
    return false;
  }
}

function speakerVisible() {
  if (!speechSupported()) return false;
  // Desktop + Android + iOS Safari: Web Speech API. Other iPhone browsers (Chrome, etc.): audio fallback.
  return useDeviceVoice() || isApplePhone();
}

function loadSpeechVoices() {
  if (!speechSupported()) return;
  speechVoices = window.speechSynthesis.getVoices() || [];
}

function preferredVoice() {
  loadSpeechVoices();
  const voices = speechVoices;
  const pick = (test) => voices.find(test);
  return pick((voice) => /en-AU/i.test(voice.lang) && voice.localService)
    || pick((voice) => /en-AU/i.test(voice.lang))
    || pick((voice) => /^en(-|$)/i.test(voice.lang) && voice.localService)
    || pick((voice) => /^en/i.test(voice.lang))
    || voices[0]
    || null;
}

function setSpeakButton(mode) {
  const button = $("history-speak");
  if (!button) return;
  const simple = ttsPlayStopOnly();
  if (mode === "speaking") {
    if (simple) {
      button.textContent = "⏹";
      button.setAttribute("aria-label", "Stop reading");
      button.title = "Stop";
    } else {
      button.textContent = "⏸";
      button.setAttribute("aria-label", "Pause reading");
      button.title = "Pause reading";
    }
  } else if (mode === "paused" && !simple) {
    button.textContent = "▶";
    button.setAttribute("aria-label", "Continue reading");
    button.title = "Continue reading";
  } else if (simple) {
    button.textContent = "▶";
    button.setAttribute("aria-label", "Play site history");
    button.title = "Play";
  } else {
    button.textContent = "🔊";
    button.setAttribute("aria-label", "Read site history");
    button.title = "Read site history";
  }
}

function clearSpeechKeepAlive() {
  if (historyKeepAlive) {
    clearInterval(historyKeepAlive);
    historyKeepAlive = 0;
  }
}

function kickSpeech() {
  try {
    const synth = window.speechSynthesis;
    if (!synth.speaking || synth.paused) return;
    synth.pause();
    synth.resume();
  } catch {
    // iPhone Safari needs this nudge; ignore if the engine rejects it.
  }
}

function startSpeechKeepAlive() {
  clearSpeechKeepAlive();
  historyKeepAlive = window.setInterval(kickSpeech, 8000);
}

function stopHistoryAudio() {
  historyChunks = [];
  historyChunkIndex = 0;
  historyAudioPaused = false;
  audioTtsFallback = false;
  if (!historyAudio) return;
  try {
    historyAudio.onended = null;
    historyAudio.onerror = null;
    historyAudio.pause();
    historyAudio.removeAttribute("src");
    historyAudio.load();
  } catch {
    // Ignore audio engines that throw while stopping.
  }
  historyAudio = null;
}

function stopHistorySpeech() {
  clearSpeechKeepAlive();
  historyPaused = false;
  historyUtterance = null;
  historyNativeChunks = [];
  historyNativeChunkIndex = 0;
  stopHistoryAudio();
  if (speechSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore engines that throw on cancel.
    }
  }
  setSpeakButton("idle");
}

function configureHistoryUtterance(utterance) {
  const voice = preferredVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = "en-AU";
  }
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.volume = 1;
}

function speakHistory(text) {
  const chunks = splitSpeechChunks(text);
  if (!chunks.length) return;
  historyNativeChunks = chunks;
  historyNativeChunkIndex = 0;
  speakHistoryNativeChunk();
}

function speakHistoryNativeChunk() {
  const synth = window.speechSynthesis;
  const text = historyNativeChunks[historyNativeChunkIndex];
  if (!text) {
    clearSpeechKeepAlive();
    historyUtterance = null;
    historyPaused = false;
    historyNativeChunks = [];
    historyNativeChunkIndex = 0;
    setSpeakButton("idle");
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  configureHistoryUtterance(utterance);
  utterance.onend = () => {
    if (historyUtterance !== utterance) return;
    historyNativeChunkIndex += 1;
    if (historyPaused) return;
    speakHistoryNativeChunk();
  };
  utterance.onerror = () => {
    if (historyUtterance !== utterance) return;
    clearSpeechKeepAlive();
    historyUtterance = null;
    historyPaused = false;
    historyNativeChunks = [];
    historyNativeChunkIndex = 0;
    setSpeakButton("idle");
  };
  historyUtterance = utterance;
  historyPaused = false;
  setSpeakButton("speaking");
  synth.speak(utterance);
  startSpeechKeepAlive();
}

function splitSpeechChunks(text, maxLen = 160) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const chunks = [];
  let buf = "";
  for (const word of words) {
    const next = buf ? `${buf} ${word}` : word;
    if (next.length <= maxLen) {
      buf = next;
      continue;
    }
    if (buf) chunks.push(buf);
    if (word.length <= maxLen) {
      buf = word;
      continue;
    }
    for (let i = 0; i < word.length; i += maxLen) chunks.push(word.slice(i, i + maxLen));
    buf = "";
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function streamElementsUrl(text) {
  return `https://api.streamelements.com/kappa/v2/speech?voice=Nicole&text=${encodeURIComponent(text)}`;
}

function googleTtsUrl(text) {
  return `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en-AU&q=${encodeURIComponent(text)}`;
}

function ttsAudioUrl(text) {
  return audioTtsFallback ? googleTtsUrl(text) : streamElementsUrl(text);
}

function playHistoryChunk() {
  const text = historyChunks[historyChunkIndex];
  if (!text) {
    stopHistorySpeech();
    return;
  }
  const audio = historyAudio || new Audio();
  historyAudio = audio;
  audio.setAttribute("playsinline", "true");
  audio.preload = "auto";
  audio.onended = () => {
    if (historyAudioPaused) return;
    historyChunkIndex += 1;
    playHistoryChunk();
  };
  audio.onerror = () => {
    if (!audioTtsFallback) {
      audioTtsFallback = true;
      playHistoryChunk();
      return;
    }
    stopHistorySpeech();
    setNote("Chrome on iPhone cannot use the phone’s speaking voice. Open this page in Safari to hear the history.");
  };
  audio.src = ttsAudioUrl(text);
  const start = audio.play();
  if (start && typeof start.catch === "function") {
    start.catch(() => {
      stopHistorySpeech();
      setNote("Chrome on iPhone cannot use the phone’s speaking voice. Open this page in Safari to hear the history.");
    });
  }
}

const IOS_STREAM_TTS_CONSENT_KEY = "touristqr-ios-stream-tts-consent";
let pendingStreamTtsText = "";

function usesStreamedTtsOnPhone() {
  return isApplePhone() && !useDeviceVoice();
}

function hasIosStreamTtsConsent() {
  try {
    return localStorage.getItem(IOS_STREAM_TTS_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

function setIosStreamTtsConsent() {
  try {
    localStorage.setItem(IOS_STREAM_TTS_CONSENT_KEY, "1");
  } catch {
    // Private mode may block storage; playback can still proceed this time.
  }
}

function speakHistoryAudio(text) {
  stopHistoryAudio();
  historyChunks = splitSpeechChunks(text);
  historyChunkIndex = 0;
  historyAudioPaused = false;
  if (!historyChunks.length) return;
  setSpeakButton("speaking");
  playHistoryChunk();
}

function startStreamedHistorySpeech(text) {
  if (usesStreamedTtsOnPhone() && !hasIosStreamTtsConsent()) {
    pendingStreamTtsText = text;
    setModal("ios-tts-consent-modal", true);
    return;
  }
  speakHistoryAudio(text);
}

function toggleHistorySpeech() {
  const text = ($("site-description")?.textContent || "").trim();
  if (!text) return;
  if (ttsPlayStopOnly()) {
    if (historySpeechActive()) {
      stopHistorySpeech();
      return;
    }
    if (!useDeviceVoice()) {
      startStreamedHistorySpeech(text);
      return;
    }
    loadSpeechVoices();
    speakHistory(text);
    return;
  }
  if (historyAudio && !historyAudioPaused) {
    try {
      historyAudio.pause();
    } catch {
      stopHistorySpeech();
      return;
    }
    historyAudioPaused = true;
    setSpeakButton("paused");
    return;
  }
  if (historyAudio && historyAudioPaused) {
    historyAudioPaused = false;
    setSpeakButton("speaking");
    const start = historyAudio.play();
    if (start && typeof start.catch === "function") start.catch(() => speakHistoryAudio(text));
    return;
  }
  if (!useDeviceVoice()) {
    startStreamedHistorySpeech(text);
    return;
  }
  const synth = window.speechSynthesis;
  loadSpeechVoices();
  if (historyUtterance && !historyPaused) {
    clearSpeechKeepAlive();
    try {
      synth.pause();
    } catch {
      // iPhone Safari often has no pause; the next tap can start again.
    }
    historyPaused = true;
    setSpeakButton("paused");
    return;
  }
  if (historyUtterance && historyPaused) {
    try {
      synth.resume();
    } catch {
      speakHistory(text);
      return;
    }
    historyPaused = false;
    setSpeakButton("speaking");
    startSpeechKeepAlive();
    return;
  }
  speakHistory(text);
}

function sponsorWebsiteUrl(org) {
  return normalizePublicHttpUrl(org?.website || "");
}

function telHref(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : "";
}

function setContact(org, site) {
  const link = $("contact-sponsor");
  if (!link) return;
  if (!org?.email || !site?.name) {
    link.classList.add("hidden");
    link.removeAttribute("href");
    return;
  }
  link.classList.remove("hidden");
  link.href = `mailto:${org.email}?subject=${encodeURIComponent(`Just visited your site ${site.name}`)}`;
}

function orgLogoUrl(org) {
  const raw = String(org?.logoUrl || "").trim();
  if (!raw) return "";
  const version = org?.logoVersion || org?.updatedAt || "";
  const [path, query] = raw.split("?");
  const base = /^https?:/i.test(path) ? path : assetUrl(path);
  if (query) return `${base}?${query}`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}

function listingKindForSite(site = state.current) {
  const org = findOrganisation(state.organisations, site?.organisationId);
  return organisationKind(org);
}

function isShopListing(site = state.current) {
  return listingKindForSite(site) === "shop";
}

function isExhibitListing(site = state.current) {
  return listingKindForSite(site) === "exhibit";
}

function applyGroupButtons() {
  const selected = (id, on) => {
    const button = $(id);
    if (!button) return;
    button.setAttribute("aria-selected", on ? "true" : "false");
  };
  selected("filter-sites", state.group === "sites");
  selected("filter-shops", state.group === "shops");
  selected("filter-restaurants", state.group === "restaurants");
  selected("filter-exhibits", state.group === "exhibits");
  const decade = $("topic-field")?.querySelector('option[value="decade"]');
  if (decade) decade.hidden = state.group !== "sites";
  if (state.group !== "sites" && $("topic-field")?.value === "decade") $("topic-field").value = "text";
  fillTopicCategory();
  toggleTopicControls();
}

function fillTopicCategory() {
  const select = $("topic-category");
  if (!select) return;
  const names = state.group === "sites"
    ? state.categories.heritage
    : state.group === "exhibits"
      ? state.categories.exhibit
      : state.categories.shop;
  const current = select.value;
  select.replaceChildren();
  const any = document.createElement("option");
  any.value = "";
  any.textContent = "Any category";
  select.append(any);
  names.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  });
  select.value = names.includes(current) ? current : "";
}

function toggleTopicControls() {
  const category = $("topic-field")?.value === "category";
  $("topic-input")?.classList.toggle("hidden", category);
  $("topic-category")?.classList.toggle("hidden", !category);
}

function topicQueryValue() {
  if ($("topic-field").value === "category") return $("topic-category").value;
  return $("topic-input").value;
}

function runGroupSearch() {
  state.results = searchSites(state.sites, state.organisations, {
    group: state.group,
    placeField: $("place-field")?.value || "city",
    placeQuery: $("place-input")?.value || "",
    topicField: $("topic-field")?.value || "text",
    topicQuery: topicQueryValue(),
  });
  state.index = 0;
  state.browsing = "results";
}

function setGroup(group, { random = false } = {}) {
  state.group = group === "shops" || group === "restaurants" || group === "exhibits" ? group : "sites";
  applyGroupButtons();
  runGroupSearch();
  if (random && state.results.length) {
    state.index = Math.floor(Math.random() * state.results.length);
  }
  setNote("");
  showCurrent();
}

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
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Safari private mode and a full quota must not blank the listing.
  }
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
  if (mode === "empty" || mode === "missing") $("year-row").classList.add("hidden");
  $("tour-toggle").classList.toggle("hidden", mode !== "full");
  const rich = mode === "full";
  $("maps-link")?.classList.toggle("pointer-events-none", !rich);
  $("maps-link")?.classList.toggle("opacity-40", !rich);
  $("sponsor-logo-link")?.classList.toggle("pointer-events-none", !rich);
  $("sponsor-logo-link")?.classList.toggle("opacity-40", !rich);
  if (rich) {
    $("maps-link")?.removeAttribute("aria-disabled");
    $("sponsor-logo-link")?.removeAttribute("aria-disabled");
  } else {
    $("maps-link")?.setAttribute("aria-disabled", "true");
    $("sponsor-logo-link")?.setAttribute("aria-disabled", "true");
  }
  $("save-btn").disabled = !rich;
  $("save-btn").classList.toggle("opacity-40", !rich);
  $("prev-site").disabled = state.results.length === 0;
  $("next-site").disabled = state.results.length === 0;
  $("export-page").disabled = !state.current;
  $("export-page").classList.toggle("opacity-40", !state.current);
}

function setSponsor(org, site) {
  const badge = $("sponsor-badge");
  if (!org || !site) {
    badge.textContent = "TouristQR";
    badge.removeAttribute("href");
    badge.removeAttribute("target");
    setContact(null, null);
    return;
  }
  const exhibit = organisationKind(org) === "exhibit";
  badge.textContent = exhibit ? String(org.name || "Sponsor").trim() : `Sponsored by ${org.name}`;
  const website = sponsorWebsiteUrl(org);
  if (website) {
    badge.href = website;
    badge.target = "_blank";
    badge.rel = "noopener noreferrer";
  } else if (org.email) {
    const body = `Comment about ${site.name}.\n${sitePublicUrl(site.id)}\n`;
    badge.href = `mailto:${org.email}?subject=${encodeURIComponent("TouristQR.com")}&body=${encodeURIComponent(body)}`;
    badge.removeAttribute("target");
    badge.removeAttribute("rel");
  } else {
    badge.removeAttribute("href");
    badge.removeAttribute("target");
  }
  setContact(org, site);
}

function showPhoto(index) {
  const count = state.gallery.length;
  if (!count) return;
  state.photoIndex = (index + count) % count;
  const photo = state.gallery[state.photoIndex];
  const image = $("primary-image");
  image.src = publicPhotoUrl(photo, state.current, state.catalogRevision);
  image.alt = photo.caption || state.current?.name || "Site photograph";
  image.classList.toggle("is-historical", photo.kind === "historical");
  $("photo-status").textContent = `Photograph ${state.photoIndex + 1} of ${count}`;
  if ($("photo-caption")) $("photo-caption").textContent = photo.caption || "";
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
    if (thumbIndex === state.photoIndex) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `shrink-0 w-[31%] overflow-hidden rounded-lg shadow-sm bg-slate-200 aspect-[4/3] border-2 ${thumbIndex === state.photoIndex ? "border-blue-600" : "border-transparent"}`;
    button.setAttribute("aria-label", `Show photograph ${thumbIndex + 1}`);
    const thumb = document.createElement("img");
    thumb.src = publicPhotoUrl(item, state.current, state.catalogRevision);
    thumb.alt = "";
    thumb.className = "w-full h-full object-cover";
    button.append(thumb);
    button.addEventListener("click", () => showPhoto(thumbIndex));
    thumbs.append(button);
  });
}

function linkifyDescription(el, text) {
  if (!el) return;
  el.replaceChildren();
  const source = String(text || "");
  if (!source) return;
  const pattern = /\b(?:https?:\/\/|www\.)[^\s<>"'\\]+/gi;
  let last = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > last) el.append(document.createTextNode(source.slice(last, match.index)));
    const full = match[0];
    const core = full.replace(/[.,;:!?]+$/g, "");
    const punct = full.slice(core.length);
    const href = normalizePublicHttpUrl(core);
    if (href) {
      const link = document.createElement("a");
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "text-blue-700 underline break-all";
      link.textContent = core;
      el.append(link);
    } else {
      el.append(document.createTextNode(core));
    }
    if (punct) el.append(document.createTextNode(punct));
    last = match.index + full.length;
  }
  if (last < source.length) el.append(document.createTextNode(source.slice(last)));
}

function renderExhibitMeta(site) {
  const panel = $("exhibit-meta");
  if (!panel) return;
  const exhibit = isExhibitListing(site);
  panel.classList.toggle("hidden", !exhibit);
  if (!exhibit) return;
  const person = String(site.contactPerson || "").trim();
  const email = String(site.contactEmail || "").trim();
  const contactWrap = $("exhibit-contact-wrap");
  if (contactWrap) {
    contactWrap.classList.toggle("hidden", !person && !email);
    const personLabel = $("exhibit-contact-person-label");
    if (personLabel) personLabel.classList.toggle("hidden", !person);
    if ($("exhibit-contact-person")) {
      $("exhibit-contact-person").textContent = person;
      $("exhibit-contact-person").classList.toggle("hidden", !person);
    }
    const emailWrap = $("exhibit-contact-email-wrap");
    if (emailWrap) emailWrap.classList.toggle("hidden", !email);
    if (email && $("exhibit-contact-email")) {
      $("exhibit-contact-email").href = `mailto:${email}`;
      $("exhibit-contact-email").textContent = email;
    }
  }
  const owner = String(site.owner || "").trim();
  if ($("exhibit-owner-wrap")) $("exhibit-owner-wrap").classList.toggle("hidden", !owner);
  if ($("exhibit-owner")) $("exhibit-owner").textContent = owner;
  const registration = String(site.registrationNumber || "").trim();
  if ($("exhibit-registration-wrap")) $("exhibit-registration-wrap").classList.toggle("hidden", !registration);
  if ($("exhibit-registration")) $("exhibit-registration").textContent = registration;
}

function updateMiddleAction(site, org) {
  const mapsLink = $("maps-link");
  const logoLink = $("sponsor-logo-link");
  const logoImg = $("sponsor-logo-img");
  if (!mapsLink || !logoLink) return;
  const exhibit = isExhibitListing(site);
  const logo = exhibit ? orgLogoUrl(org) : "";
  const website = sponsorWebsiteUrl(org);
  if (logo) {
    mapsLink.classList.add("hidden");
    logoLink.classList.remove("hidden");
    if (logoImg) {
      logoImg.src = logo;
      logoImg.alt = `${String(org?.name || "Club").trim()} logo`;
    }
    logoLink.classList.remove("opacity-40");
    if (website) {
      logoLink.href = website;
      logoLink.classList.remove("pointer-events-none");
      logoLink.removeAttribute("aria-disabled");
    } else {
      logoLink.removeAttribute("href");
      logoLink.classList.add("pointer-events-none");
      logoLink.setAttribute("aria-disabled", "true");
    }
    return;
  }
  logoLink.classList.add("hidden");
  logoLink.removeAttribute("href");
  const query = String(site.mapsQuery || "").trim();
  if (exhibit && !query) {
    mapsLink.classList.add("hidden");
    return;
  }
  mapsLink.classList.remove("hidden");
  mapsLink.href = `https://maps.google.com/?q=${encodeURIComponent(query || site.name)}`;
}

function updateShopListingActions(site) {
  const wrap = $("shop-listing-actions");
  if (!wrap) return;
  const shop = isShopListing(site);
  wrap.classList.toggle("hidden", !shop);
  if (!shop) return;
  const web = $("shop-action-website");
  const webLabel = $("shop-action-website-label");
  const rawWeb = String(site.furtherReading || "").trim();
  const webHref = normalizePublicHttpUrl(rawWeb);
  if (web) {
    web.classList.toggle("hidden", !webHref);
    if (webHref) {
      web.href = webHref;
      if (webLabel) webLabel.textContent = rawWeb.replace(/^https?:\/\//i, "");
    }
  }
  const phone = $("shop-action-phone");
  const phoneLabel = $("shop-action-phone-label");
  const phoneText = String(site.phone || "").trim();
  const tel = telHref(phoneText);
  if (phone) {
    phone.classList.toggle("hidden", !tel);
    if (tel) {
      phone.href = tel;
      if (phoneLabel) phoneLabel.textContent = phoneText;
    }
  }
}

function updateExhibitSponsorAction(org) {
  const wrap = $("exhibit-sponsor-action");
  const link = $("exhibit-sponsor-link");
  if (!wrap || !link) return;
  const name = String(org?.name || "").trim();
  wrap.classList.toggle("hidden", !name);
  if (!name) return;
  link.textContent = name;
  const website = sponsorWebsiteUrl(org);
  if (website) {
    link.href = website;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.classList.add("underline");
  } else {
    link.removeAttribute("href");
    link.removeAttribute("target");
    link.classList.remove("underline");
  }
}

function renderFull(site) {
  state.gallery = photosInCodeOrder(site.photos);
  state.photoIndex = 0;
  linkifyDescription($("site-description"), site.description || "");
  const shop = isShopListing(site);
  const exhibit = isExhibitListing(site);
  if ($("history-heading")) {
    $("history-heading").textContent = shop ? "Description" : exhibit ? "Item history" : "Site History";
  }
  const webWrap = $("shop-website-wrap");
  const webLink = $("shop-website");
  if (webWrap && webLink) {
    const raw = String(site.furtherReading || "").trim();
    const href = shop ? normalizePublicHttpUrl(raw) : "";
    webWrap.classList.toggle("hidden", !href);
    if (href) {
      webLink.href = href;
      webLink.textContent = raw.replace(/^https?:\/\//i, "");
    } else {
      webLink.removeAttribute("href");
      webLink.textContent = "";
    }
  }
  if ($("oldest-heading")) {
    $("oldest-heading").textContent = shop ? "Shop front" : exhibit ? "Advertising photo" : "Oldest Known Photo";
  }
  if ($("year-label")) {
    $("year-label").textContent = shop ? "Established" : exhibit ? "Year of manufacture" : "Established / Built";
  }
  const speak = $("history-speak");
  const showSpeak = speakerVisible() && !!(site.description || "").trim();
  if (speak) {
    speak.classList.toggle("hidden", !showSpeak);
    if (showSpeak) setSpeakButton("idle");
  }
  const org = findOrganisation(state.organisations, site.organisationId);
  updateMiddleAction(site, org);
  updateShopListingActions(site);
  updateExhibitSponsorAction(isExhibitListing(site) ? org : null);
  renderExhibitMeta(site);
  const saved = readJson(FAVOURITES, []).includes(site.id);
  setStackButton($("save-btn"), saved ? "✅" : "⭐", saved ? "Saved" : "Save");
  const onTour = readJson(TOUR, []).includes(site.id);
  $("tour-toggle").textContent = onTour ? "Remove from tour" : "Add to tour";

  const historical = state.gallery.find((photo) => photo.kind === "historical") || null;
  $("oldest-section").classList.toggle("hidden", !historical);
  if (historical) {
    $("oldest-img").src = publicPhotoUrl(historical, site, state.catalogRevision);
    $("oldest-img").alt = historical.caption || (shop ? "Shop front" : exhibit ? "Advertising photo" : "Oldest known photograph");
    $("oldest-caption").textContent = historical.caption || "";
  }
  if (state.gallery.length) showPhoto(0);
}

function openSite(site) {
  stopHistorySpeech();
  closeExportSheet();
  state.current = site;
  const org = findOrganisation(state.organisations, site.organisationId);
  const listed = isListed(site, org);
  try {
    const address = new URL(window.location.href);
    address.searchParams.set("site", site.id);
    history.replaceState(null, "", `${address.pathname}${address.search}`);
  } catch {
    // Some iPhone browsers reject replaceState; the listing must still render.
  }
  document.title = `${site.name} · TouristQR`;
  $("place-name").textContent = site.name;
  const yearText = displayYear(site);
  const kind = organisationKind(org);
  if ($("year-label")) {
    $("year-label").textContent = kind === "shop" ? "Established" : kind === "exhibit" ? "Year of manufacture" : "Established / Built";
  }
  $("build-year").textContent = yearText;
  $("year-row").classList.toggle("hidden", !yearText);
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
    stopHistorySpeech();
    closeExportSheet();
    state.current = null;
    document.title = "TouristQR";
    const message = emptyMessage();
    $("place-name").textContent = message.title;
    $("build-year").textContent = "";
    $("year-row").classList.add("hidden");
    $("result-label").textContent = "";
    $("view-empty").querySelector("p").textContent = message.body;
    setSponsor(null, null);
    setNote("");
    showModes("empty");
    $("place-name").scrollIntoView({ block: "start" });
    return;
  }
  openSite(state.results[state.index]);
}

function emptyMessage() {
  if (state.browsing === "tour" && !readJson(FAVOURITES, []).length) {
    return {
      title: "You have no favourites yet",
      body: "You have no favourites yet. Save a place, then add it to a tour.",
    };
  }
  if (state.browsing === "tour") {
    return {
      title: "You have no tour stops yet",
      body: "You have no tour stops yet. Open a place and choose Add to tour.",
    };
  }
  if (state.browsing === "saved") {
    return {
      title: "You have no favourites yet",
      body: "You have no favourites yet. Open a place and tap Save.",
    };
  }
  if (state.browsing === "visited") {
    return {
      title: "No visits yet",
      body: "Places you open on this phone will be listed here.",
    };
  }
  if (state.group === "shops") {
    return {
      title: "No shops match",
      body: "Nothing public matches that shop search. Try a suburb, a city, or part of a shop name.",
    };
  }
  if (state.group === "restaurants") {
    return {
      title: "No restaurants match",
      body: "Nothing public matches that restaurant search. Try a suburb, a city, or part of a restaurant name.",
    };
  }
  if (state.group === "exhibits") {
    return {
      title: "No exhibits match",
      body: "Nothing public matches that exhibit search. Try a suburb, a city, or part of an item name.",
    };
  }
  return {
    title: "No matches",
    body: "Nothing public matches that search. Try a suburb, a decade such as 1880s, or part of a name.",
  };
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

function loadQrLibrary() {
  if (typeof Html5Qrcode === "function") return Promise.resolve();
  const src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
  const existing = document.querySelector(`script[data-touristqr-qr="1"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("script")), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.dataset.touristqrQr = "1";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("script"));
    document.head.appendChild(script);
  });
}

async function startScanner() {
  try {
    await loadQrLibrary();
  } catch {
    setNote("The scanner could not be loaded.");
    return;
  }
  if (typeof Html5Qrcode !== "function") {
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
  if (!frame) return;
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

const catalogueFetch = { cache: "no-store" };

async function loadCatalogue() {
  const bust = Date.now();
  const [siteResponse, orgResponse, categoryResponse] = await Promise.all([
    fetch(`${assetUrl("data/sites.json")}?v=${bust}`, catalogueFetch),
    fetch(`${assetUrl("data/organisations.json")}?v=${bust}`, catalogueFetch),
    fetch(`${assetUrl("data/categories.json")}?v=${bust}`, catalogueFetch).catch(() => null),
  ]);
  if (!siteResponse.ok || !orgResponse.ok) throw new Error("missing");
  state.catalogRevision = bust;
  state.sites = mergePublicCatalogue(await siteResponse.json(), readLocal(LOCAL_SITES));
  state.organisations = mergePublicCatalogue(await orgResponse.json(), readLocal(LOCAL_ORGS));
  if (categoryResponse?.ok) {
    const lists = await categoryResponse.json();
    state.categories = {
      heritage: Array.isArray(lists.heritage) ? lists.heritage : [],
      shop: Array.isArray(lists.shop) ? lists.shop : [],
      exhibit: Array.isArray(lists.exhibit) ? lists.exhibit : [],
    };
  }
}

async function init() {
  try {
    await loadCatalogue();
  } catch {
    $("place-name").textContent = "Sites unavailable";
    $("result-label").textContent = "Start the app with node server.mjs so the shared catalogue can load.";
    return;
  }

  try {
    const requested = new URLSearchParams(window.location.search).get("site")
      || parseGenericCode(window.location.pathname)?.listingId
      || "";
    if (requested) {
      const site = state.sites.find((item) => item.id === requested);
      if (!site) {
        $("place-name").textContent = "Site not found";
        $("result-label").textContent = "";
        showModes("missing");
        setSponsor(null, null);
        applyGroupButtons();
        return;
      }
      const org = findOrganisation(state.organisations, site.organisationId);
      state.group = listingGroup(site, org);
      applyGroupButtons();
      runGroupSearch();
      const pos = state.results.findIndex((item) => item.id === site.id);
      if (pos >= 0) state.index = pos;
      openSite(site);
      return;
    }
    setGroup("sites", { random: true });
  } catch {
    $("place-name").textContent = "Sites unavailable";
    $("result-label").textContent = "The listing could not be shown. Close the tab and open touristqr.com again.";
  }
}

function copyTextNow(text) {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.focus();
  field.select();
  field.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(field);
  if (ok) return true;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }
  return false;
}

function fillExportSheet(title, url) {
  $("export-place").textContent = title;
  $("export-url").value = url;
  $("export-messages").href = `sms:&body=${encodeURIComponent(`${title}\n${url}`)}`;
  $("export-mail").href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`;
  const desktop = isDesktopBrowser();
  $("export-share").classList.toggle("hidden", desktop);
  $("export-messages").classList.toggle("hidden", desktop);
}

function openExportSheet() {
  setModal("export-modal", true);
}

function closeExportSheet() {
  setModal("export-modal", false);
}

function copyExportUrl() {
  const url = $("export-url").value;
  if (copyTextNow(url)) setNote("Page address copied. Paste it to send this listing.");
  else setNote("Select the address, copy it, then paste it to send this listing.");
}

function nativeSharePayload(title, url) {
  if (isApplePhone()) return { url };
  const site = state.current;
  const year = site ? displayYear(site) : "";
  return { title, text: `${title}${year ? ` · ${year}` : ""}`, url };
}

function shareListing(title, url) {
  if (typeof navigator.share !== "function") {
    copyExportUrl();
    return;
  }
  navigator.share(nativeSharePayload(title, url)).catch((error) => {
    if (error?.name === "AbortError") return;
    openExportSheet();
  });
}

function exportPage() {
  const site = state.current;
  if (!site) {
    setNote("Open a site first, then export it.");
    return;
  }
  const url = sitePublicUrl(site.id);
  const title = site.name;
  fillExportSheet(title, url);
  if (isDesktopBrowser() || isApplePhone() || typeof navigator.share !== "function") {
    openExportSheet();
    return;
  }
  shareListing(title, url);
}

function on(id, event, handler) {
  $(id)?.addEventListener(event, handler);
}

function setSearchPlaceholder(selectId, inputId) {
  const input = $(inputId);
  const select = $(selectId);
  if (input && select) input.placeholder = placeholders[select.value] || "";
}

on("history-speak", "click", toggleHistorySpeech);
window.addEventListener("pagehide", stopHistorySpeech);

on("prev-site", "click", () => navigate(-1));
on("next-site", "click", () => navigate(1));
on("export-page", "click", exportPage);
on("export-close", "click", closeExportSheet);
on("export-copy", "click", copyExportUrl);
on("export-share", "click", () => {
  shareListing($("export-place").textContent, $("export-url").value);
});
on("export-modal", "click", (event) => {
  if (event.target === $("export-modal")) closeExportSheet();
});
on("photo-prev", "click", () => showPhoto(state.photoIndex - 1));
on("photo-next", "click", () => showPhoto(state.photoIndex + 1));
on("oldest-open", "click", () => openZoom($("oldest-img").src, $("oldest-img").alt));
on("scan-btn", "click", startScanner);
on("scanner-close", "click", stopScanner);
on("about-open", "click", () => setModal("about-modal", true));
on("about-close", "click", () => setModal("about-modal", false));
on("about-dismiss", "click", () => setModal("about-modal", false));
on("ios-tts-consent-decline", "click", () => {
  pendingStreamTtsText = "";
  setModal("ios-tts-consent-modal", false);
});
on("ios-tts-consent-proceed", "click", () => {
  const text = pendingStreamTtsText;
  pendingStreamTtsText = "";
  setModal("ios-tts-consent-modal", false);
  setIosStreamTtsConsent();
  if (text) speakHistoryAudio(text);
});
on("image-modal", "click", () => setModal("image-modal", false));

on("save-btn", "click", () => {
  if (!state.current || $("save-btn").disabled) return;
  const saved = toggleId(FAVOURITES, state.current.id);
  setStackButton($("save-btn"), saved ? "✅" : "⭐", saved ? "Saved" : "Save");
  setNote(saved ? "Saved on this phone." : "Removed from saved places.");
});

on("tour-toggle", "click", () => {
  if (!state.current) return;
  const included = toggleId(TOUR, state.current.id);
  $("tour-toggle").textContent = included ? "Remove from tour" : "Add to tour";
  setNote(included ? "Added to the tour on this phone." : "Removed from the tour.");
  if (state.browsing === "tour") useList(readJson(TOUR, []), "tour");
});

on("saved-btn", "click", () => useList(readJson(FAVOURITES, []), "saved"));
on("visited-btn", "click", () => useList(readJson(VISITS, []).map((item) => item.id), "visited"));
on("tour-btn", "click", () => useList(readJson(TOUR, []), "tour"));

on("email-saved", "click", () => {
  emailSites(sitesFromIds(readJson(FAVOURITES, [])), "There are no saved places on this phone yet.");
});
on("email-tour", "click", () => {
  emailSites(sitesFromIds(readJson(TOUR, [])), "There are no tour stops on this phone yet.");
});

on("place-field", "change", () => setSearchPlaceholder("place-field", "place-input"));
on("topic-field", "change", () => {
  setSearchPlaceholder("topic-field", "topic-input");
  toggleTopicControls();
});
on("filter-sites", "click", () => setGroup("sites", { random: true }));
on("filter-shops", "click", () => setGroup("shops", { random: true }));
on("filter-restaurants", "click", () => setGroup("restaurants", { random: true }));
on("filter-exhibits", "click", () => setGroup("exhibits", { random: true }));

on("search-form", "submit", (event) => {
  event.preventDefault();
  state.results = searchSites(state.sites, state.organisations, {
    group: state.group,
    placeField: $("place-field").value,
    placeQuery: $("place-input").value,
    topicField: $("topic-field").value,
    topicQuery: topicQueryValue(),
  });
  state.index = 0;
  state.browsing = "results";
  setNote("");
  showCurrent();
  $("place-name").scrollIntoView({ block: "start" });
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  setModal("about-modal", false);
  setModal("ios-tts-consent-modal", false);
  pendingStreamTtsText = "";
  setModal("image-modal", false);
  closeExportSheet();
  stopScanner();
});

try {
  bindPhotoSwipe();
  if (speechSupported() && useDeviceVoice()) {
    loadSpeechVoices();
    window.speechSynthesis.addEventListener("voiceschanged", loadSpeechVoices);
  }
} catch {
  // Speech and swipe extras must not stop the catalogue loading on iPhone.
}

window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  loadCatalogue()
    .then(() => {
      if (!state.current?.id) return;
      const site = state.sites.find((item) => item.id === state.current.id);
      if (site) openSite(site);
    })
    .catch(() => {});
});

init();
