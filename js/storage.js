export const LOCAL_SITES = "touristqr_local_sites";
export const LOCAL_ORGS = "touristqr_local_orgs";

export function readLocal(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error("This browser has run out of room for saved photographs. Use fewer or smaller images, or save while the TouristQR server is running.");
  }
}

export function clearLocal(key) {
  localStorage.removeItem(key);
}
