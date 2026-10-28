import { assetUrl, publicPhotoUrl, sitePublicUrl } from "./config.js";

const DEFAULT_OG_IMAGE = "images/touristqr-social.jpg";
const DEFAULT_ICON = "images/touristqr-icon.jpg";

const DEFAULTS = {
  title: "TouristQR — Heritage sites, shops & exhibits in Geelong",
  description:
    "Scan QR codes at historic places, local shops, restaurants, and exhibits. Search the public catalogue, save favourites, and build a tour on your phone.",
  siteName: "TouristQR",
  ogImage: DEFAULT_OG_IMAGE,
  icon: DEFAULT_ICON,
};

function el(id) {
  return document.getElementById(id);
}

function readDefaults() {
  const node = el("seo-defaults");
  if (!node) return DEFAULTS;
  return {
    title: node.dataset.title || DEFAULTS.title,
    description: node.dataset.description || DEFAULTS.description,
    siteName: node.dataset.siteName || DEFAULTS.siteName,
    ogImage: node.dataset.ogImage || DEFAULTS.ogImage,
    icon: node.dataset.icon || DEFAULTS.icon,
  };
}

function absoluteAssetUrl(relativePath) {
  const raw = String(relativePath || "").trim();
  if (!raw) return "";
  if (/^https?:/i.test(raw)) return raw;
  return assetUrl(raw.replace(/^\//, ""));
}

function defaultSocialImageUrl() {
  return absoluteAssetUrl(readDefaults().ogImage);
}

function setSocialPreviewImage(imageUrl) {
  const url = imageUrl || defaultSocialImageUrl();
  if (!url) return;
  setMetaByProperty("og:image", url);
  setMetaByName("twitter:card", "summary_large_image");
  setMetaByName("twitter:image", url);
}

export function applySiteIcons() {
  const iconUrl = absoluteAssetUrl(readDefaults().icon);
  if (!iconUrl) return;
  for (const rel of ["icon", "apple-touch-icon"]) {
    let link = document.querySelector(`link[rel="${rel}"]`);
    if (!link) {
      link = document.createElement("link");
      link.rel = rel;
      document.head.appendChild(link);
    }
    link.href = iconUrl;
    link.type = "image/jpeg";
  }
}

function setMetaByName(name, content) {
  if (!content) return;
  let tag = document.querySelector(`meta[name="${name}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute("name", name);
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

function setMetaByProperty(property, content) {
  if (!content) return;
  let tag = document.querySelector(`meta[property="${property}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute("property", property);
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", content);
}

function setCanonical(href) {
  let link = el("canonical-link");
  if (!link) {
    link = document.createElement("link");
    link.id = "canonical-link";
    link.rel = "canonical";
    document.head.appendChild(link);
  }
  link.href = href;
}

function plainText(value, max = 300) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function schemaTypeForSite(site, orgKind) {
  if (orgKind === "shop") return "Store";
  if (orgKind === "exhibit") return "Product";
  return "TouristAttraction";
}

function removeJsonLd() {
  document.querySelectorAll("script[data-touristqr-seo]").forEach((node) => node.remove());
}

function injectJsonLd(data) {
  removeJsonLd();
  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.setAttribute("data-touristqr-seo", "1");
  script.textContent = JSON.stringify(data);
  document.head.appendChild(script);
}

export function applyHomeSeo() {
  const defaults = readDefaults();
  const canonical = `${window.location.origin}${window.location.pathname.replace(/\/index\.html$/i, "/").replace(/\/?$/, "/")}`;
  document.title = defaults.title;
  setMetaByName("description", defaults.description);
  setMetaByProperty("og:title", defaults.title);
  setMetaByProperty("og:description", defaults.description);
  setMetaByProperty("og:type", "website");
  setMetaByProperty("og:url", canonical);
  setMetaByProperty("og:site_name", defaults.siteName);
  setSocialPreviewImage(defaultSocialImageUrl());
  setMetaByName("twitter:title", defaults.title);
  setMetaByName("twitter:description", defaults.description);
  setCanonical(canonical);
  const socialImage = defaultSocialImageUrl();
  injectJsonLd({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: defaults.siteName,
    description: defaults.description,
    url: canonical,
    inLanguage: "en-AU",
    image: socialImage || undefined,
  });
}

export function applyListingSeo(site, org, catalogRevision = 0) {
  if (!site) {
    applyHomeSeo();
    return;
  }
  const defaults = readDefaults();
  const url = sitePublicUrl(site.id);
  const title = `${site.name} · ${defaults.siteName}`;
  const description = plainText(
    site.description
      || [site.name, site.city, site.suburb, site.category, site.buildYear].filter(Boolean).join(" — "),
    300,
  );
  const photos = site.photos || [];
  const listingImage = photos[0] ? publicPhotoUrl(photos[0], site, catalogRevision) : "";
  const image = listingImage || defaultSocialImageUrl();
  const orgKind = org?.kind || "site";

  document.title = title;
  setMetaByName("description", description);
  setMetaByProperty("og:title", site.name);
  setMetaByProperty("og:description", description);
  setMetaByProperty("og:type", "article");
  setMetaByProperty("og:url", url);
  setMetaByProperty("og:site_name", defaults.siteName);
  setSocialPreviewImage(image);
  setMetaByName("twitter:title", site.name);
  setMetaByName("twitter:description", description);
  setCanonical(url);

  const address = {
    "@type": "PostalAddress",
    addressLocality: site.city || site.suburb || undefined,
    addressRegion: site.state || undefined,
    addressCountry: site.country || "Australia",
  };
  const payload = {
    "@context": "https://schema.org",
    "@type": schemaTypeForSite(site, orgKind),
    name: site.name,
    description,
    url,
    image: image || undefined,
    address: Object.values(address).some((v) => v && v !== "PostalAddress") ? address : undefined,
  };
  if (site.mapsQuery) {
    payload.hasMap = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(site.mapsQuery)}`;
  }
  injectJsonLd(payload);
}
