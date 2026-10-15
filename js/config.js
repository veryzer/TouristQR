// Printed QR codes use this public address.
// Codes that are already printed keep whatever address they were given.
export const publicBaseUrl = "https://touristqr.com/";

export function genericPublicUrl(codeOrId) {
  const match = /generic\s*0*(\d{1,6})/i.exec(String(codeOrId || ""));
  if (!match) return "";
  const digits = String(Number(match[1])).padStart(4, "0");
  const base = publicBaseUrl.replace(/\/?$/, "/");
  return `${base}Generic${digits}`;
}

export function sitePublicUrl(siteId) {
  const generic = genericPublicUrl(siteId);
  if (generic) return generic;
  const base = publicBaseUrl.replace(/\/?$/, "/");
  return `${base}?site=${encodeURIComponent(siteId)}`;
}

export function appPath(pathname) {
  let path = pathname || "/";
  path = path.replace(/\/(?:admin|signup|index)\.html$/, "/").replace(/\/admin\/?$/, "/");
  path = path.replace(/\/Generic\d+\/?$/i, "/");
  if (!path.endsWith("/")) path += "/";
  return path;
}

export function appRoot() {
  return new URL(appPath(window.location.pathname), window.location.origin);
}

export function assetUrl(file) {
  return new URL(file, appRoot()).href;
}

export function publicPhotoUrl(photo, site, catalogRevision = 0) {
  const raw = String(photo?.url || "").trim();
  if (!raw) return "";
  if (/^(data:|blob:)/i.test(raw)) return raw;
  let href = raw;
  if (!/^https?:/i.test(raw)) {
    href = assetUrl(raw.split("?")[0].split("#")[0]);
  } else {
    href = raw.split("#")[0];
  }
  const token = photo?.mediaVersion ?? site?.updatedAt ?? catalogRevision;
  const join = href.includes("?") ? "&" : "?";
  return `${href}${join}v=${encodeURIComponent(String(token))}`;
}

export function liveSiteUrl(siteId) {
  const url = new URL("index.html", appRoot());
  if (siteId) url.searchParams.set("site", siteId);
  return url.href;
}
