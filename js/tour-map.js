export function formatGeolocationOrigin(lat, lng) {
  return `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
}

export function tourMapAddress(site) {
  return String(site?.mapsQuery || "").trim();
}

export function partitionTourStops(sites) {
  const mappable = [];
  const needsAddress = [];
  (sites || []).forEach((site) => {
    if (tourMapAddress(site)) mappable.push(site);
    else needsAddress.push(site);
  });
  return { mappable, needsAddress };
}

/** @param {string} origin @param {{ id: string, mapsQuery?: string }[]} mappableInTourOrder */
export function buildGoogleTourDirectionsUrl(origin, mappableInTourOrder) {
  const originText = String(origin || "").trim();
  if (!originText || !mappableInTourOrder?.length) return "";

  const addresses = mappableInTourOrder.map((site) => tourMapAddress(site)).filter(Boolean);
  if (!addresses.length) return "";

  if (addresses.length === 1) {
    const dest = addresses[0];
    if (originText === dest) {
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dest)}`;
    }
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originText)}&destination=${encodeURIComponent(dest)}`;
  }

  let destinationSite = mappableInTourOrder[mappableInTourOrder.length - 1];
  let destAddr = tourMapAddress(destinationSite);
  let middle = mappableInTourOrder.filter((site) => site.id !== destinationSite.id);
  middle = middle.filter((site) => tourMapAddress(site) !== originText);

  if (tourMapAddress(destinationSite) === originText) {
    destinationSite = middle[middle.length - 1] || destinationSite;
    destAddr = tourMapAddress(destinationSite);
    middle = mappableInTourOrder.filter((site) => site.id !== destinationSite.id);
    middle = middle.filter((site) => tourMapAddress(site) !== originText);
  }

  if (!destAddr) return "";

  if (!middle.length) {
    if (originText === destAddr) {
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(destAddr)}`;
    }
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originText)}&destination=${encodeURIComponent(destAddr)}`;
  }

  const waypointBody = `optimize:true|${middle.map((site) => tourMapAddress(site)).join("|")}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originText)}&destination=${encodeURIComponent(destAddr)}&waypoints=${encodeURIComponent(waypointBody)}`;
}
