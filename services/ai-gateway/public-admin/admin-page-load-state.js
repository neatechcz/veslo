const PLATFORM_PAGES = new Set([
  "overview",
  "organizations",
  "ai-infrastructure",
  "ai-usage",
  "ai-alerts",
  "platform-users",
  "audit",
]);

const ORGANIZATION_PAGES = new Set([
  "overview",
  "members",
  "domains-invites",
  "billing",
  "ai-access",
  "audit",
]);

export function adminRouteScopeKey(route) {
  if (!route || typeof route !== "object") return null;
  if (
    route.area === "platform"
    && route.organizationId === null
    && PLATFORM_PAGES.has(route.page)
  ) {
    return `platform:${route.page}`;
  }
  const organizationId = typeof route.organizationId === "string"
    ? route.organizationId.trim()
    : "";
  if (
    route.area === "organization"
    && organizationId
    && ORGANIZATION_PAGES.has(route.page)
  ) {
    return `organization:${organizationId}:${route.page}`;
  }
  return null;
}

export function createAdminPageLoadState() {
  return {
    status: "idle",
    key: null,
    generation: 0,
    error: "",
  };
}

export function beginAdminPageLoad(state, route) {
  state.generation += 1;
  const key = adminRouteScopeKey(route);
  state.key = key;
  state.status = key ? "loading" : "idle";
  state.error = "";
  return key ? { key, generation: state.generation } : null;
}

export function isAdminPageLoadCurrent(state, request) {
  return Boolean(
    state
    && request
    && state.key === request.key
    && state.generation === request.generation,
  );
}

export function completeAdminPageLoad(state, request, empty) {
  if (!isAdminPageLoadCurrent(state, request) || state.status !== "loading") {
    return false;
  }
  state.status = empty ? "empty" : "ready";
  state.error = "";
  return true;
}

export function failAdminPageLoad(state, request, error) {
  if (!isAdminPageLoadCurrent(state, request) || state.status !== "loading") {
    return false;
  }
  if (error && typeof error === "object" && error.name === "AbortError") {
    state.status = "idle";
    state.error = "";
    return true;
  }
  state.status = "error";
  state.error = "Unable to load data.";
  return true;
}
