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
  localStorage.setItem(key, JSON.stringify(value));
}

export function clearLocal(key) {
  localStorage.removeItem(key);
}
