import {
  ORGANIZATION_PAGES,
  PLATFORM_PAGES,
} from "./admin-route-state.js";

const PLATFORM_PAGE_SET = new Set(PLATFORM_PAGES);
const ORGANIZATION_PAGE_SET = new Set(ORGANIZATION_PAGES);

export function adminRouteScopeKey(route) {
  if (!route || typeof route !== "object") return null;
  if (
    route.area === "platform"
    && route.organizationId === null
    && PLATFORM_PAGE_SET.has(route.page)
  ) {
    return `platform:${route.page}`;
  }
  const organizationId = typeof route.organizationId === "string"
    ? route.organizationId.trim()
    : "";
  if (
    route.area === "organization"
    && organizationId
    && ORGANIZATION_PAGE_SET.has(route.page)
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
