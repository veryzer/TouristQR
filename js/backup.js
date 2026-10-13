import { isListed, subscriptionState } from "./model.js";

export function sitesForOrganisation(sites, organisationId) {
  return (sites || []).filter((site) => site.organisationId === organisationId);
}

export function organisationsForActor(organisations, user) {
  if (!user) return [];
  if (user.role === "site-admin") return [...organisations];
  return organisations.filter((org) => org.id === user.organisationId);
}

export function sitesForActor(sites, user) {
  if (!user) return [];
  if (user.role === "site-admin") return [...sites];
  return sitesForOrganisation(sites, user.organisationId);
}

export function buildBackup({ kind, organisationId, organisations, sites }) {
  const exportedAt = new Date().toISOString();
  if (kind === "sponsor") {
    const organisation = organisations.find((org) => org.id === organisationId);
    if (!organisation) {
      throw Object.assign(new Error("That sponsor is not in the catalogue."), { status: 400 });
    }
    return {
      version: 1,
      kind: "sponsor",
      organisationId,
      exportedAt,
      organisations: [organisation],
      sites: sitesForOrganisation(sites, organisationId),
    };
  }
  return {
    version: 1,
    kind: "full",
    exportedAt,
    organisations: [...organisations],
    sites: [...sites],
  };
}

export function applyRestore({ currentOrganisations, currentSites, backup, user }) {
  if (!backup || backup.version !== 1 || !Array.isArray(backup.organisations) || !Array.isArray(backup.sites)) {
    throw Object.assign(new Error("That file is not a TouristQR backup."), { status: 400 });
  }
  if (backup.kind === "full") {
    if (user?.role !== "site-admin") {
      throw Object.assign(new Error("Only the site admin can restore the whole catalogue."), { status: 403 });
    }
    return {
      organisations: backup.organisations,
      sites: backup.sites,
    };
  }
  if (backup.kind !== "sponsor") {
    throw Object.assign(new Error("That file is not a TouristQR backup."), { status: 400 });
  }
  const organisationId = backup.organisationId || backup.organisations[0]?.id;
  if (!organisationId) {
    throw Object.assign(new Error("That backup does not name a sponsor."), { status: 400 });
  }
  if (user?.role === "sponsor" && user.organisationId !== organisationId) {
    throw Object.assign(new Error("You can only restore your own sponsor."), { status: 403 });
  }
  const incomingOrg = backup.organisations.find((org) => org.id === organisationId) || backup.organisations[0];
  const current = currentOrganisations.find((org) => org.id === organisationId);
  if (!current && user?.role !== "site-admin") {
    throw Object.assign(new Error("That sponsor is not in the catalogue."), { status: 400 });
  }
  const restoredOrg = current
    ? {
        ...current,
        name: incomingOrg?.name || current.name,
        email: incomingOrg?.email || current.email,
        contactName: incomingOrg?.contactName ?? current.contactName ?? "",
        contactEmail: incomingOrg?.contactEmail ?? current.contactEmail ?? "",
        type: incomingOrg?.type || current.type,
        subscribedAt: incomingOrg?.subscribedAt || current.subscribedAt,
        createdAt: incomingOrg?.createdAt || current.createdAt,
        number: current.number,
        id: current.id,
      }
    : incomingOrg;
  const organisations = current
    ? currentOrganisations.map((org) => (org.id === organisationId ? restoredOrg : org))
    : [...currentOrganisations, restoredOrg];
  const incomingSites = backup.sites.filter((site) => site.organisationId === organisationId);
  const sites = [
    ...currentSites.filter((site) => site.organisationId !== organisationId),
    ...incomingSites,
  ];
  return { organisations, sites };
}

export function subscriptionReport(organisations, sites, now = new Date()) {
  return organisations.map((org) => {
    const orgSites = sitesForOrganisation(sites, org.id);
    const state = subscriptionState(org.subscribedAt, now);
    return {
      organisationId: org.id,
      number: org.number,
      name: org.name,
      email: org.email,
      subscribedAt: org.subscribedAt,
      state,
      siteCount: orgSites.length,
      publicCount: orgSites.filter((site) => isListed(site, org, now)).length,
    };
  });
}
