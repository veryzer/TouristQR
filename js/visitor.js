import { assetUrl, publicPhotoUrl, sitePublicUrl } from "./config.js?v=generic5";
import { applyHomeSeo, applyListingSeo, applySiteIcons } from "./seo.js?v=generic31";
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
  shopGroupOf,
  parseGenericCode,
  photosInDisplayOrder,
  searchSites,
} from "./model.js?v=generic18";
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

function streamTtsUrl(text) {
  const params = new URLSearchParams({ text });
  return assetUrl(`api/tts?${params}`);
}

function ttsAudioUrl(text) {
  return streamTtsUrl(text);
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
    stopHistorySpeech();
    setNote("Could not play audio. Try Safari on this iPhone, or check your connection.");
  };
  audio.src = ttsAudioUrl(text);
  audio.load();
  const start = audio.play();
  if (start && typeof start.catch === "function") {
    start.catch(() => {
      stopHistorySpeech();
      setNote("Could not play audio. Try Safari on this iPhone, or check your connection.");
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

function publicSponsorWebsiteUrl(org, site) {
  const fromOrg = sponsorWebsiteUrl(org);
  if (fromOrg) return fromOrg;
  if (organisationKind(org) === "shop") {
    return normalizePublicHttpUrl(site?.furtherReading || "");
  }
  return normalizePublicHttpUrl(site?.furtherReading || "");
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

function isRestaurantListing(site = state.current) {
  const org = findOrganisation(state.organisations, site?.organisationId);
  return shopGroupOf(org, site) === "restaurants";
}

function featuredPhotoHeading(site) {
  if (isExhibitListing(site)) return "Advertising photo";
  if (isRestaurantListing(site)) return "Shop front";
  if (isShopListing(site)) return "Shop front";
  return "Oldest Known Photo";
}

function featuredPhotoAlt(site) {
  if (isExhibitListing(site)) return "Advertising photo";
  if (isShopListing(site)) return "Shop front";
  return "Oldest known photograph";
}

function featuredPhotoFromList(photos) {
  return (photos || []).find((photo) => photo?.kind === "historical") || null;
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
  applyListYourPlacePromo();
}

const DEFAULT_LIST_PROMO = {
  contactEmail: "info@touristqr.com",
  mailtoSubject: "TouristQR — list my place",
  mailtoLabel: "Email to get started",
  kicker: "For businesses & heritage groups",
  headlineDefault: "List your site, shop, restaurant, or exhibit",
  headlineSites: "List your historic site",
  headlineShops: "List your shop",
  headlineRestaurants: "List your restaurant",
  headlineExhibits: "List your exhibit",
  blurb: "Get a public page with QR code, photos, and history — visitors can search, scan, and save favourites on their phone.",
  ctaLabel: "How to list",
  modalTitle: "List on TouristQR",
  modalIntro: "TouristQR is the mobile guide people use when they scan a code or search the catalogue. Add your place so it appears alongside other listings.",
  modalBullets: [
    "Your own public page with photographs and wording",
    "A unique QR link for signs, menus, and displays",
    "Listed under Sites, Shops, Restaurants, or Exhibits",
    "Sponsor login to update photos and text anytime",
  ],
  modalFootnote: "Listing is set up with the TouristQR team. Tap below to send an email — include your business name, contact details, and whether you are a site, shop, restaurant, or exhibit.",
};

let listPromoConfig = { ...DEFAULT_LIST_PROMO };

function listPromoHeadlineForGroup(group) {
  const map = {
    sites: listPromoConfig.headlineSites,
    shops: listPromoConfig.headlineShops,
    restaurants: listPromoConfig.headlineRestaurants,
    exhibits: listPromoConfig.headlineExhibits,
  };
  return map[group] || listPromoConfig.headlineDefault;
}

function listKindWord(group) {
  if (group === "shops") return "shop";
  if (group === "restaurants") return "restaurant";
  if (group === "exhibits") return "exhibit";
  return "historic site";
}

function applyListYourPlacePromo() {
  const cfg = listPromoConfig;
  const kicker = $("list-your-place-kicker");
  if (kicker) kicker.textContent = cfg.kicker || "";
  const headline = $("list-your-place-headline");
  if (headline) headline.textContent = listPromoHeadlineForGroup(state.group);
  const blurb = $("list-your-place-blurb");
  if (blurb) blurb.textContent = cfg.blurb || "";
  const openBtn = $("list-your-place-open");
  if (openBtn) openBtn.textContent = cfg.ctaLabel || "How to list";
  const aboutBtn = $("about-list-open");
  if (aboutBtn) aboutBtn.textContent = cfg.headlineDefault || listPromoHeadlineForGroup(state.group);

  const title = $("list-your-place-title");
  if (title) title.textContent = cfg.modalTitle || "List on TouristQR";
  const intro = $("list-your-place-intro");
  if (intro) intro.textContent = cfg.modalIntro || "";
  const footnote = $("list-your-place-footnote");
  if (footnote) footnote.textContent = cfg.modalFootnote || "";
  const bullets = $("list-your-place-bullets");
  if (bullets) {
    bullets.replaceChildren();
    (Array.isArray(cfg.modalBullets) ? cfg.modalBullets : []).forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      bullets.append(li);
    });
  }
  const mail = $("list-your-place-mailto");
  const email = String(cfg.contactEmail || "").trim();
  if (mail) {
    if (email) {
      const subject = cfg.mailtoSubject || DEFAULT_LIST_PROMO.mailtoSubject;
      const kind = listKindWord(state.group);
      const body = `Hello,\n\nI would like to list my ${kind} on TouristQR.\n\nBusiness / place name:\nContact name:\nPhone:\n\nThank you.`;
      mail.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      mail.textContent = cfg.mailtoLabel || DEFAULT_LIST_PROMO.mailtoLabel;
      mail.classList.remove("hidden");
    } else {
      mail.classList.add("hidden");
    }
  }
}

async function loadListYourPlacePromo() {
  try {
    const response = await fetch(assetUrl("content/list-your-place-promo.json"), { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      listPromoConfig = { ...DEFAULT_LIST_PROMO, ...data };
    }
  } catch {
    listPromoConfig = { ...DEFAULT_LIST_PROMO };
  }
  applyListYourPlacePromo();
}

function openListYourPlaceModal() {
  applyListYourPlacePromo();
  setModal("list-your-place-modal", true);
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

function searchFormHasCriteria() {
  const placeQ = ($("place-input")?.value || "").trim();
  const topicQ = String(topicQueryValue() || "").trim();
  return Boolean(placeQ || topicQ);
}

function clearSearchForm() {
  if ($("place-input")) $("place-input").value = "";
  if ($("topic-input")) $("topic-input").value = "";
  if ($("topic-category")) $("topic-category").value = "";
}

function runSearchFromForm() {
  state.results = searchSites(state.sites, state.organisations, {
    group: state.group,
    placeField: $("place-field")?.value || "city",
    placeQuery: $("place-input")?.value || "",
    topicField: $("topic-field")?.value || "text",
    topicQuery: topicQueryValue(),
  });
  state.index = 0;
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
  applyListBrowsingButtons();
}

function setGroup(group, { random = false } = {}) {
  state.group = group === "shops" || group === "restaurants" || group === "exhibits" ? group : "sites";
  state.browsing = "results";
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

function applyListBrowsingButtons() {
  const listMode = state.browsing === "saved" || state.browsing === "visited" || state.browsing === "tour";
  const searchMode = state.browsing === "search";
  const navFiltered = listMode || searchMode;
  const searchBtn = $("search-submit-btn");
  searchBtn?.classList.toggle("search-exit-mode", listMode);
  searchBtn?.classList.toggle("search-exit-search", searchMode);
  if (searchBtn) {
    searchBtn.textContent = navFiltered ? "Show all" : "Search";
    searchBtn.setAttribute("aria-pressed", navFiltered ? "true" : "false");
  }
  const markListButton = (id, active) => {
    const btn = $(id);
    if (!btn) return;
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    btn.classList.toggle("list-filter-active", active);
  };
  markListButton("saved-btn", state.browsing === "saved");
  markListButton("visited-btn", state.browsing === "visited");
  markListButton("tour-btn", state.browsing === "tour");
  $("site-nav-cluster")?.classList.toggle("site-nav-filtered", navFiltered);
  const navLabel = $("site-nav-filtered-label");
  if (navLabel) {
    navLabel.classList.toggle("hidden", !navFiltered);
    navLabel.setAttribute("aria-hidden", navFiltered ? "false" : "true");
    if (searchMode) navLabel.textContent = "Search";
    else if (state.browsing === "saved") navLabel.textContent = "Saved";
    else if (state.browsing === "visited") navLabel.textContent = "Visited";
    else if (state.browsing === "tour") navLabel.textContent = "Tour";
    else navLabel.textContent = "Filtered";
  }
}

function resultLabel(site) {
  const parts = [];
  if (state.browsing === "saved") {
    const n = state.results.length;
    parts.push(`Saved places only · ${n} on this phone`);
  } else if (state.browsing === "visited") {
    parts.push(`Visited only · ${state.results.length}`);
  } else if (state.browsing === "tour") {
    const n = state.results.length;
    parts.push(`Tour only · ${n} stop${n === 1 ? "" : "s"}`);
  } else if (state.browsing === "search") {
    const n = state.results.length;
    parts.push(`Search matches · ${n} listing${n === 1 ? "" : "s"}`);
  }
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
}

function setSponsor(org, site) {
  const badge = $("sponsor-badge");
  if (!org || !site) {
    badge.textContent = "TouristQR";
    badge.removeAttribute("href");
    badge.removeAttribute("target");
    badge.removeAttribute("rel");
    setContact(null, null);
    return;
  }
  const name = String(org.name || "Sponsor").trim();
  const isShop = organisationKind(org) === "shop";
  badge.textContent = `Sponsored by ${name}`;
  badge.removeAttribute("rel");
  const website = publicSponsorWebsiteUrl(org, site);
  if (website) {
    badge.href = website;
    badge.target = "_blank";
    badge.rel = "noopener noreferrer";
  } else if (!isShop && org.email) {
    const body = `Comment about ${site.name}.\n${sitePublicUrl(site.id)}\n`;
    badge.href = `mailto:${org.email}?subject=${encodeURIComponent("TouristQR.com")}&body=${encodeURIComponent(body)}`;
    badge.removeAttribute("target");
  } else {
    badge.removeAttribute("href");
    badge.removeAttribute("target");
  }
  setContact(org, site);
}

const THUMB_TRACK_COPIES = 3;
let thumbTrackKey = "";
let suppressThumbPhotoSync = false;
let thumbCarouselUserScrolling = false;
let thumbScrollEndTimer = null;

function thumbTrackFingerprint() {
  const siteId = state.current?.id || "";
  const codes = state.gallery.map((photo) => photo.code || "").join("|");
  return `${siteId}:${codes}`;
}

function thumbSlotStride(container) {
  const slot = container.querySelector(".thumb-slot");
  if (!slot) return 0;
  const style = getComputedStyle(container);
  const gap = parseFloat(style.columnGap || style.gap) || 0;
  return slot.offsetWidth + gap;
}

function createThumbButton(item, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "thumb-slot shrink-0 overflow-hidden rounded-lg shadow-sm bg-slate-200 aspect-[4/3] border-2 border-transparent";
  button.dataset.index = String(index);
  button.setAttribute("aria-label", `Show photograph ${index + 1}`);
  const thumb = document.createElement("img");
  thumb.src = publicPhotoUrl(item, state.current, state.catalogRevision);
  thumb.alt = "";
  thumb.className = "w-full h-full object-cover";
  thumb.draggable = false;
  button.append(thumb);
  button.addEventListener("click", () => selectThumbnail(button));
  return button;
}

function selectThumbnail(button) {
  const index = Number(button.dataset.index);
  if (!Number.isFinite(index)) return;
  suppressThumbPhotoSync = true;
  showPhoto(index, { skipThumbScroll: true });
  scrollThumbSlotIntoView(button, true);
  window.setTimeout(() => {
    suppressThumbPhotoSync = false;
    normalizeInfiniteThumbScroll();
    updateThumbSelection();
  }, 450);
}

function rebuildThumbTrack() {
  const container = $("thumbnails-container");
  if (!container) return;
  const count = state.gallery.length;
  container.classList.toggle("hidden", count < 2);
  if (count < 2) {
    container.replaceChildren();
    thumbTrackKey = "";
    return;
  }
  const key = thumbTrackFingerprint();
  if (key === thumbTrackKey) return;
  thumbTrackKey = key;
  container.replaceChildren();
  for (let copy = 0; copy < THUMB_TRACK_COPIES; copy += 1) {
    state.gallery.forEach((item, index) => {
      container.append(createThumbButton(item, index));
    });
  }
}

function thumbSlotInMiddleCopy(index) {
  const count = state.gallery.length;
  if (count < 2) return null;
  const slots = $("thumbnails-container")?.querySelectorAll(".thumb-slot");
  return slots?.[count + index] || null;
}

function alignListingGalleryToPhotoIndex(index) {
  if (state.gallery.length < 2) return;
  scrollThumbToIndex(index, false, { middleCopy: true });
  normalizeInfiniteThumbScroll();
  updateThumbSelection();
}

function updateThumbSelection() {
  const container = $("thumbnails-container");
  if (!container) return;
  container.querySelectorAll(".thumb-slot").forEach((button) => {
    button.classList.remove("border-blue-600");
    button.classList.add("border-transparent");
    button.removeAttribute("aria-current");
  });
  const centered = centeredThumbSlot(container);
  if (!centered) return;
  centered.classList.remove("border-transparent");
  centered.classList.add("border-blue-600");
  centered.setAttribute("aria-current", "true");
}

function centeredThumbSlot(container) {
  const slots = container.querySelectorAll(".thumb-slot");
  if (!slots.length) return null;
  const containerRect = container.getBoundingClientRect();
  const viewportCenter = containerRect.left + containerRect.width / 2;
  let best = slots[0];
  let bestDistance = Infinity;
  slots.forEach((slot) => {
    const rect = slot.getBoundingClientRect();
    const slotCenter = rect.left + rect.width / 2;
    const distance = Math.abs(slotCenter - viewportCenter);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  });
  return best;
}

function scrollThumbSlotIntoView(slot, smooth) {
  const container = $("thumbnails-container");
  if (!slot || !container) return;
  const containerRect = container.getBoundingClientRect();
  const slotRect = slot.getBoundingClientRect();
  const slotCenter = slotRect.left - containerRect.left + container.scrollLeft + slotRect.width / 2;
  const maxLeft = Math.max(0, container.scrollWidth - container.clientWidth);
  const nextLeft = Math.min(maxLeft, Math.max(0, slotCenter - container.clientWidth / 2));
  if (smooth) {
    container.scrollTo({ left: nextLeft, behavior: "smooth" });
  } else {
    container.scrollLeft = nextLeft;
  }
}

function normalizeInfiniteThumbScroll() {
  const container = $("thumbnails-container");
  const count = state.gallery.length;
  if (count < 2) return;
  const slots = container.querySelectorAll(".thumb-slot");
  if (slots.length !== count * THUMB_TRACK_COPIES) return;
  const centered = centeredThumbSlot(container);
  if (!centered) return;
  const slotIndex = Array.prototype.indexOf.call(slots, centered);
  const copy = Math.floor(slotIndex / count);
  if (copy === 0 || copy === THUMB_TRACK_COPIES - 1) {
    const stride = thumbSlotStride(container);
    if (!stride) return;
    const offset = copy === 0 ? count * stride : -count * stride;
    container.scrollLeft += offset;
  }
}

function nearestThumbSlotForIndex(index) {
  const container = $("thumbnails-container");
  if (!container) return null;
  const slots = container.querySelectorAll(".thumb-slot");
  const candidates = [...slots].filter((slot) => Number(slot.dataset.index) === index);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const centered = centeredThumbSlot(container);
  if (!centered) return candidates[0];
  const centerX = centered.getBoundingClientRect().left + centered.getBoundingClientRect().width / 2;
  let best = candidates[0];
  let bestDistance = Infinity;
  candidates.forEach((slot) => {
    const rect = slot.getBoundingClientRect();
    const distance = Math.abs(rect.left + rect.width / 2 - centerX);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = slot;
    }
  });
  return best;
}

function scrollThumbToIndex(index, smooth, options = {}) {
  const count = state.gallery.length;
  if (count < 2) return;
  const target = options.middleCopy ? thumbSlotInMiddleCopy(index) : nearestThumbSlotForIndex(index);
  scrollThumbSlotIntoView(target, smooth);
}

function onThumbCarouselScrollEnd() {
  if (suppressThumbPhotoSync) return;
  const container = $("thumbnails-container");
  if (!container || state.gallery.length < 2) return;
  normalizeInfiniteThumbScroll();
  const centered = centeredThumbSlot(container);
  if (!centered) return;
  const index = Number(centered.dataset.index);
  if (!Number.isFinite(index)) return;
  const userScrolled = thumbCarouselUserScrolling;
  thumbCarouselUserScrolling = false;
  if (userScrolled && index !== state.photoIndex) {
    showPhoto(index, { skipThumbScroll: true });
    return;
  }
  updateThumbSelection();
}

function bindThumbCarousel() {
  const container = $("thumbnails-container");
  if (!container) return;
  const markUserThumbScroll = () => {
    thumbCarouselUserScrolling = true;
  };
  container.addEventListener("pointerdown", markUserThumbScroll);
  container.addEventListener("touchstart", markUserThumbScroll, { passive: true });
  const scheduleScrollEnd = () => {
    if (thumbScrollEndTimer) window.clearTimeout(thumbScrollEndTimer);
    thumbScrollEndTimer = window.setTimeout(() => {
      thumbScrollEndTimer = null;
      onThumbCarouselScrollEnd();
    }, 90);
  };
  container.addEventListener(
    "scroll",
    () => {
      if (!suppressThumbPhotoSync) updateThumbSelection();
      scheduleScrollEnd();
    },
    { passive: true },
  );
  container.addEventListener("scrollend", () => {
    if (thumbScrollEndTimer) {
      window.clearTimeout(thumbScrollEndTimer);
      thumbScrollEndTimer = null;
    }
    onThumbCarouselScrollEnd();
  });
  let thumbCarouselLayoutWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    const width = window.innerWidth;
    if (width === thumbCarouselLayoutWidth) return;
    thumbCarouselLayoutWidth = width;
    if (state.gallery.length < 2 || suppressThumbPhotoSync) return;
    scrollThumbToIndex(state.photoIndex, false);
  });
}

function showPhoto(index, options = {}) {
  const { skipThumbScroll = false, thumbScrollInstant = false } = options;
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

  if (!suppressThumbPhotoSync) updateThumbSelection();
  if (!skipThumbScroll && count >= 2) {
    suppressThumbPhotoSync = true;
    const alignThumbs = () => scrollThumbToIndex(state.photoIndex, !thumbScrollInstant, { middleCopy: true });
    if (thumbScrollInstant) {
      requestAnimationFrame(() => requestAnimationFrame(alignThumbs));
    } else {
      alignThumbs();
    }
    window.setTimeout(
      () => {
        suppressThumbPhotoSync = false;
      },
      thumbScrollInstant ? 50 : 450,
    );
  }
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

function updateExhibitSponsorAction(org, site) {
  const wrap = $("exhibit-sponsor-action");
  const link = $("exhibit-sponsor-link");
  if (!wrap || !link) return;
  const show = Boolean(org?.name && site && isExhibitListing(site));
  wrap.classList.toggle("hidden", !show);
  if (!show) return;
  const name = String(org.name || "Sponsor").trim();
  link.textContent = name;
  applySponsorPageLink(link, publicSponsorWebsiteUrl(org, site));
}

function applySponsorPageLink(link, website) {
  if (!link) return;
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
  state.gallery = photosInDisplayOrder(site.photos);
  linkifyDescription($("site-description"), site.description || "");
  const shop = isShopListing(site);
  const exhibit = isExhibitListing(site);
  if ($("history-heading")) {
    $("history-heading").textContent = shop ? "Description" : exhibit ? "Item history" : "Site History";
  }
  if ($("oldest-heading")) {
    $("oldest-heading").textContent = featuredPhotoHeading(site);
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
  updateExhibitSponsorAction(isExhibitListing(site) ? org : null, site);
  renderExhibitMeta(site);
  const saved = readJson(FAVOURITES, []).includes(site.id);
  setStackButton($("save-btn"), saved ? "✅" : "⭐", saved ? "Saved" : "Save");
  const onTour = readJson(TOUR, []).includes(site.id);
  $("tour-toggle").textContent = onTour ? "Remove from tour" : "Add to tour";

  const historical = featuredPhotoFromList(photosInDisplayOrder(site.photos));
  $("oldest-section").classList.toggle("hidden", !historical);
  if (historical) {
    $("oldest-img").src = publicPhotoUrl(historical, site, state.catalogRevision);
    $("oldest-img").alt = historical.caption || featuredPhotoAlt(site);
    $("oldest-caption").textContent = historical.caption || "";
  }
  rebuildThumbTrack();
  if (!state.gallery.length) return;
  suppressThumbPhotoSync = true;
  thumbCarouselUserScrolling = false;
  showPhoto(0, { skipThumbScroll: true });
  const settleGallery = () => alignListingGalleryToPhotoIndex(0);
  requestAnimationFrame(() => requestAnimationFrame(settleGallery));
  window.setTimeout(() => {
    settleGallery();
    suppressThumbPhotoSync = false;
  }, 320);
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
  applyListingSeo(site, org, state.catalogRevision);
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
    applyHomeSeo();
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

function resumeFullList(message = "Showing the full public list again.") {
  runGroupSearch();
  setNote(message);
  showCurrent();
}

function useList(ids, browsing) {
  if (state.browsing === browsing) {
    resumeFullList();
    return;
  }
  state.results = sitesFromIds(ids);
  state.index = 0;
  state.browsing = browsing;
  const hints = {
    saved: "Saved places only. Tap Saved again or Show all for the full list.",
    visited: "Visited only. Tap Visited again or Show all for the full list.",
    tour: "Your tour only. Tap Tour again or Show all for the full list.",
  };
  setNote(hints[browsing] || "");
  applyListBrowsingButtons();
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
    return false;
  }
  const body = list.map((site) => `${site.name}\n${sitePublicUrl(site.id)}`).join("\n\n");
  window.location.href = `mailto:?subject=${encodeURIComponent("TouristQR.com")}&body=${encodeURIComponent(body)}`;
  return true;
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
  let suppressPrimaryClick = false;
  frame.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    state.pointer = { x: event.clientX, y: event.clientY };
    if (typeof frame.setPointerCapture === "function") {
      try {
        frame.setPointerCapture(event.pointerId);
      } catch {
        // Ignore if capture is not allowed.
      }
    }
  });
  frame.addEventListener("pointerup", (event) => {
    if (typeof frame.releasePointerCapture === "function") {
      try {
        frame.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore if this pointer was not captured.
      }
    }
    if (!state.pointer || event.target.closest("button")) {
      state.pointer = null;
      return;
    }
    const dx = event.clientX - state.pointer.x;
    const dy = event.clientY - state.pointer.y;
    state.pointer = null;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      suppressPrimaryClick = true;
      showPhoto(state.photoIndex + (dx < 0 ? 1 : -1));
      window.setTimeout(() => {
        suppressPrimaryClick = false;
      }, 0);
    }
  });
  frame.addEventListener("pointercancel", () => {
    state.pointer = null;
  });
  frame.addEventListener("click", (event) => {
    if (event.target.closest("button") || suppressPrimaryClick) return;
    openZoom($("primary-image").src, $("primary-image").alt);
  });
}

const catalogueFetch = { cache: "no-store" };

async function loadSeoDefaults() {
  try {
    const response = await fetch(assetUrl("content/seo-defaults.json"), { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const node = $("seo-defaults");
    if (!node) return;
    if (data.defaultTitle) node.dataset.title = data.defaultTitle;
    if (data.defaultDescription) node.dataset.description = data.defaultDescription;
    if (data.siteName) node.dataset.siteName = data.siteName;
    if (data.ogImagePath) node.dataset.ogImage = data.ogImagePath;
    if (data.iconPath) node.dataset.icon = data.iconPath;
  } catch {
    // Inline defaults in index.html remain in use.
  }
}

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
  await loadListYourPlacePromo();
  try {
    await loadCatalogue();
    await loadSeoDefaults();
    applySiteIcons();
    applyHomeSeo();
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
        applyHomeSeo();
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

function exportSitesForSource(source) {
  if (source === "current") return state.current ? [state.current] : [];
  if (source === "saved") return sitesFromIds(readJson(FAVOURITES, []));
  if (source === "visited") return sitesFromIds(readJson(VISITS, []).map((item) => item.id));
  if (source === "tour") return sitesFromIds(readJson(TOUR, []));
  return [];
}

function exportSourceLabel(source) {
  if (source === "current") return "This one listing";
  if (source === "saved") return "Saved";
  if (source === "visited") return "Visited";
  if (source === "tour") return "Tour";
  return "Export";
}

function buildExportPayload(source) {
  const list = exportSitesForSource(source);
  if (!list.length) return null;
  const body = list.map((site) => `${site.name}\n${sitePublicUrl(site.id)}`).join("\n\n");
  const title = list.length === 1 ? list[0].name : `TouristQR ${exportSourceLabel(source)}`;
  const url = list.length === 1 ? sitePublicUrl(list[0].id) : "";
  return { title, body, url, count: list.length };
}

function selectedExportSource() {
  const checked = document.querySelector('input[name="export-source"]:checked');
  return checked?.value || "current";
}

function defaultExportSource() {
  if (exportSitesForSource("current").length) return "current";
  if (state.browsing === "saved" && exportSitesForSource("saved").length) return "saved";
  if (state.browsing === "visited" && exportSitesForSource("visited").length) return "visited";
  if (state.browsing === "tour" && exportSitesForSource("tour").length) return "tour";
  for (const source of ["saved", "visited", "tour"]) {
    if (exportSitesForSource(source).length) return source;
  }
  return "current";
}

function refreshExportModal() {
  const counts = {
    saved: exportSitesForSource("saved").length,
    visited: exportSitesForSource("visited").length,
    tour: exportSitesForSource("tour").length,
  };
  $("export-count-saved").textContent = counts.saved ? `(${counts.saved})` : "(empty)";
  $("export-count-visited").textContent = counts.visited ? `(${counts.visited})` : "(empty)";
  $("export-count-tour").textContent = counts.tour ? `(${counts.tour})` : "(empty)";
  document.querySelectorAll('input[name="export-source"]').forEach((input) => {
    const n = input.value === "current" ? exportSitesForSource("current").length : counts[input.value] || 0;
    input.disabled = n === 0;
    input.closest("label")?.classList.toggle("opacity-40", n === 0);
  });
  const source = selectedExportSource();
  const payload = buildExportPayload(source);
  const hasPayload = Boolean(payload);
  $("export-empty-hint")?.classList.toggle("hidden", hasPayload);
  $("export-body")?.classList.toggle("hidden", !hasPayload);
  $("export-actions")?.classList.toggle("opacity-40", !hasPayload);
  $("export-share")?.toggleAttribute("disabled", !hasPayload);
  $("export-copy")?.toggleAttribute("disabled", !hasPayload);
  $("export-messages")?.classList.toggle("pointer-events-none", !hasPayload);
  $("export-mail")?.classList.toggle("pointer-events-none", !hasPayload);
  if (!payload) {
    $("export-place").textContent = "";
    $("export-body").value = "";
    return;
  }
  $("export-place").textContent = payload.count === 1
    ? payload.title
    : `${exportSourceLabel(source)} · ${payload.count} place${payload.count === 1 ? "" : "s"}`;
  $("export-body").value = payload.body;
  const smsBody = payload.body;
  $("export-messages").href = `sms:&body=${encodeURIComponent(smsBody)}`;
  $("export-mail").href = `mailto:?subject=${encodeURIComponent("TouristQR.com")}&body=${encodeURIComponent(smsBody)}`;
  const desktop = isDesktopBrowser();
  $("export-share").classList.toggle("hidden", desktop);
  $("export-messages").classList.toggle("hidden", desktop);
}

const EXPORT_ACTION_IDS = ["export-share", "export-copy", "export-messages", "export-mail"];

function resetExportActionButtons() {
  EXPORT_ACTION_IDS.forEach((id) => $(id)?.classList.remove("export-action-used"));
}

function markExportActionUsed(id) {
  if ($(id)?.hasAttribute("disabled") || $(id)?.classList.contains("pointer-events-none")) return;
  $(id)?.classList.add("export-action-used");
}

function exportActionReady() {
  return Boolean(buildExportPayload(selectedExportSource()));
}

function configureExportModal() {
  resetExportActionButtons();
  const source = defaultExportSource();
  const radio = document.querySelector(`input[name="export-source"][value="${source}"]`);
  if (radio && !radio.disabled) radio.checked = true;
  else {
    const first = document.querySelector('input[name="export-source"]:not(:disabled)');
    if (first) first.checked = true;
  }
  refreshExportModal();
}

function openExportSheet() {
  configureExportModal();
  setModal("export-modal", true);
}

function closeExportSheet() {
  setModal("export-modal", false);
  resetExportActionButtons();
}

function copyExportBody({ markButton = true } = {}) {
  const text = $("export-body")?.value || "";
  if (!text) {
    setNote("Choose a list that has places on this phone.");
    return;
  }
  if (markButton) markExportActionUsed("export-copy");
  if (copyTextNow(text)) setNote("Copied. Paste it into a message or email.");
  else setNote("Select the text, copy it, then paste it to send.");
}

function shareExportSelection() {
  const payload = buildExportPayload(selectedExportSource());
  if (!payload) {
    setNote("Nothing to share in that list yet.");
    return;
  }
  if (typeof navigator.share !== "function") {
    markExportActionUsed("export-share");
    copyExportBody({ markButton: false });
    return;
  }
  const shareData = payload.url && isApplePhone()
    ? { url: payload.url }
    : { title: payload.title, text: payload.body, ...(payload.url ? { url: payload.url } : {}) };
  navigator.share(shareData)
    .then(() => markExportActionUsed("export-share"))
    .catch((error) => {
      if (error?.name === "AbortError") return;
      markExportActionUsed("export-share");
      copyExportBody({ markButton: false });
    });
}

function exportPage() {
  openExportSheet();
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
on("export-copy", "click", copyExportBody);
on("export-share", "click", shareExportSelection);
on("export-messages", "click", () => {
  if (exportActionReady()) markExportActionUsed("export-messages");
});
on("export-mail", "click", () => {
  if (exportActionReady()) markExportActionUsed("export-mail");
});
document.querySelectorAll('input[name="export-source"]').forEach((input) => {
  input.addEventListener("change", refreshExportModal);
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
on("about-list-open", "click", () => {
  setModal("about-modal", false);
  openListYourPlaceModal();
});
on("list-your-place-open", "click", openListYourPlaceModal);
on("list-your-place-close", "click", () => setModal("list-your-place-modal", false));
on("list-your-place-dismiss", "click", () => setModal("list-your-place-modal", false));
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
  const listMode = state.browsing === "saved" || state.browsing === "visited" || state.browsing === "tour";
  if (listMode || state.browsing === "search") {
    clearSearchForm();
    resumeFullList();
    applyListBrowsingButtons();
    $("place-name").scrollIntoView({ block: "start" });
    return;
  }
  if (!searchFormHasCriteria()) {
    runGroupSearch();
    setNote("");
    applyListBrowsingButtons();
    showCurrent();
    $("place-name").scrollIntoView({ block: "start" });
    return;
  }
  runSearchFromForm();
  state.browsing = "search";
  const n = state.results.length;
  setNote(
    n
      ? "Search filter on — arrows move only within matches. Pink · green Show all releases the full list."
      : "No matches for that search. Change the fields and tap Search, or Show all for the full list.",
  );
  applyListBrowsingButtons();
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
  bindThumbCarousel();
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
