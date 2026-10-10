// Printed QR codes use this address. It is the GitHub Pages site for now.
// When touristqr.com is connected, change this one value and generate the codes again.
// Codes that are already printed keep whatever address they were given.
export const publicBaseUrl = "https://veryzer.github.io/TouristQR/";

export function sitePublicUrl(siteId) {
  const base = publicBaseUrl.replace(/\/?$/, "/");
  return `${base}?site=${encodeURIComponent(siteId)}`;
}
