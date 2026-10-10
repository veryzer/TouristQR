// Printed QR codes use this address. It is the GitHub Pages site for now.
// When touristqr.com is connected, change this one value and generate the codes again.
// Codes that are already printed keep whatever address they were given.
export const publicBaseUrl = "https://veryzer.github.io/TouristQR/";

export function sitePublicUrl(siteId) {
  const base = publicBaseUrl.replace(/\/?$/, "/");
  return `${base}?site=${encodeURIComponent(siteId)}`;
}

export function appPath(pathname) {
  let path = pathname || "/";
  path = path.replace(/\/(?:admin|index)\.html$/, "/").replace(/\/admin\/?$/, "/");
  if (!path.endsWith("/")) path += "/";
  return path;
}

export function appRoot() {
  return new URL(appPath(window.location.pathname), window.location.origin);
}

export function assetUrl(file) {
  return new URL(file, appRoot()).href;
}

export function liveSiteUrl(siteId) {
  const url = new URL("index.html", appRoot());
  if (siteId) url.searchParams.set("site", siteId);
  return url.href;
}
