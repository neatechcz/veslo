export const PLATFORM_PAGES = Object.freeze([
  "overview",
  "organizations",
  "ai-infrastructure",
  "ai-usage",
  "ai-alerts",
  "platform-users",
  "audit",
]);

export const ORGANIZATION_PAGES = Object.freeze([
  "overview",
  "members",
  "domains-invites",
  "billing",
  "ai-access",
  "audit",
]);

const PLATFORM_PATHS = new Map([
  ["/admin", "overview"],
  ["/admin/organizations", "organizations"],
  ["/admin/ai-infrastructure", "ai-infrastructure"],
  ["/admin/ai-infrastructure/usage", "ai-usage"],
  ["/admin/ai-infrastructure/alerts", "ai-alerts"],
  ["/admin/platform-users", "platform-users"],
  ["/admin/audit", "audit"],
]);

const PLATFORM_PAGE_PATHS = new Map(
  Array.from(PLATFORM_PATHS, ([pathname, page]) => [page, pathname]),
);

export function parseAdminRoute(pathname) {
  if (typeof pathname !== "string") {
    return null;
  }
  const platformPage = PLATFORM_PATHS.get(pathname);
  if (platformPage) {
    return { area: "platform", page: platformPage, organizationId: null };
  }

  const match = pathname.match(/^\/admin\/organizations\/([^/]+)\/(overview|members|domains-invites|billing|ai-access|audit)$/);
  if (!match) {
    return null;
  }
  try {
    const organizationId = decodeURIComponent(match[1]).trim();
    if (!organizationId) {
      return null;
    }
    return { area: "organization", page: match[2], organizationId };
  } catch {
    return null;
  }
}

export function formatAdminRoute(route) {
  if (!route || typeof route !== "object") {
    return null;
  }
  if (route.area === "platform") {
    if (route.organizationId !== null && route.organizationId !== undefined) {
      return null;
    }
    return PLATFORM_PAGE_PATHS.get(route.page) ?? null;
  }
  if (route.area !== "organization" || !ORGANIZATION_PAGES.includes(route.page)) {
    return null;
  }
  const organizationId = typeof route.organizationId === "string" ? route.organizationId.trim() : "";
  if (!organizationId) {
    return null;
  }
  return `/admin/organizations/${encodeURIComponent(organizationId)}/${route.page}`;
}

export function organizationIdForRoute(route) {
  return route?.area === "organization" && typeof route.organizationId === "string"
    ? route.organizationId
    : null;
}

export function resolveAiAccessOrganizationId(route, user, selectedOrganizationId = "") {
  const routedOrganizationId = organizationIdForRoute(route);
  return route?.area === "organization" && route.page === "ai-access"
    ? routedOrganizationId
    : null;
}

export function toAdminDateTimeLocalValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const localClock = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localClock.toISOString().slice(0, 16);
}

export function fromAdminDateTimeLocalValue(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return null;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? normalized : date.toISOString();
}

export function toPlatformRoute(page) {
  return PLATFORM_PAGES.includes(page)
    ? { area: "platform", page, organizationId: null }
    : null;
}

export function switchOrganizationRoute(route, organizationId) {
  const id = typeof organizationId === "string" ? organizationId.trim() : "";
  if (!id) {
    return null;
  }
  return {
    area: "organization",
    page: route?.area === "organization" && ORGANIZATION_PAGES.includes(route.page) ? route.page : "overview",
    organizationId: id,
  };
}

export function routeDescriptorsEqual(left, right) {
  return left?.area === right?.area
    && left?.page === right?.page
    && left?.organizationId === right?.organizationId;
}

export function createAdminNavigationState(initialRoute) {
  return { route: initialRoute ? { ...initialRoute } : null };
}

export function navigateAdminRoute(state, route) {
  const pathname = formatAdminRoute(route);
  if (!pathname) {
    return null;
  }
  state.route = { ...route };
  return pathname;
}

export function planAdminHistoryUpdate(route, location, historyMode = "push") {
  const pathname = formatAdminRoute(route);
  if (!pathname) {
    return null;
  }
  const currentUrl = typeof location?.pathname === "string"
    ? `${location.pathname}${location.search || ""}${location.hash || ""}`
    : "";
  return {
    method: currentUrl === pathname ? null : historyMode === "replace" ? "replace" : "push",
    pathname,
  };
}

export function applyAdminPopState(state, pathname) {
  const route = parseAdminRoute(pathname);
  if (!route) {
    return false;
  }
  state.route = route;
  return true;
}

export function canAccessAdminRoute(route, access) {
  if (!route) {
    return false;
  }
  if (route.area === "platform") {
    return access?.platformAdmin === true;
  }
  if (route.area !== "organization" || !organizationIdForRoute(route)) {
    return false;
  }
  if (access?.platformAdmin === true) {
    return true;
  }
  return Array.isArray(access?.organizationIds) && access.organizationIds.includes(route.organizationId);
}

export function adminUserRoutePermissions(route, access) {
  const platformUsers = route?.area === "platform"
    && route.page === "platform-users"
    && access?.platformAdmin === true;
  const organizationRouteAllowed = route?.area === "organization"
    && canAccessAdminRoute(route, access);
  const managedAiAccess = Array.isArray(access?.capabilities)
    && access.capabilities.includes("managedAiUserAccess");
  return {
    createUser: platformUsers,
    editProfile: platformUsers,
    editMembership: platformUsers || (organizationRouteAllowed && route.page === "members"),
    editAiAccess: managedAiAccess && organizationRouteAllowed && route.page === "ai-access",
    setPlatformAdmin: platformUsers,
    disableUser: platformUsers,
    deleteUser: platformUsers,
  };
}

const USER_ACTION_PERMISSION = Object.freeze({
  "create-user": "createUser",
  "edit-user-profile": "editProfile",
  "edit-membership": "editMembership",
  "edit-ai-access": "editAiAccess",
  "set-platform-admin": "setPlatformAdmin",
  "disable-user": "disableUser",
  "delete-user": "deleteUser",
});

export function canPerformAdminRouteAction(route, access, action) {
  if (route?.area === "organization" && canAccessAdminRoute(route, access)) {
    if (action === "edit-organization-profile") return route.page === "overview";
    if (action === "manage-organization-billing") {
      return route.page === "billing" && (
        access?.platformAdmin === true
        || (Array.isArray(access?.organizationAdminIds) && access.organizationAdminIds.includes(route.organizationId))
      );
    }
    if (action === "manage-platform-billing") return route.page === "billing" && access?.platformAdmin === true;
    if (action === "manage-organization-domains" || action === "manage-organization-invites") {
      return route.page === "domains-invites";
    }
  }
  const permission = USER_ACTION_PERMISSION[action];
  return Boolean(permission && adminUserRoutePermissions(route, access)[permission]);
}

export function buildAdminUserUpdatePayload(route, access, payload) {
  if (!payload || typeof payload !== "object") return null;
  const permissions = adminUserRoutePermissions(route, access);
  if (permissions.editProfile && permissions.setPlatformAdmin && permissions.editMembership) {
    return {
      name: payload.name,
      platformAdmin: payload.platformAdmin,
      orgId: payload.orgId,
      orgRole: payload.orgRole,
    };
  }
  if (permissions.editMembership) {
    return {
      orgId: route.organizationId,
      orgRole: payload.orgRole,
    };
  }
  return null;
}

export function createAdminMutationState() {
  return { generations: Object.create(null) };
}

export function beginAdminRouteMutation(state, key, route) {
  if (!state || typeof key !== "string" || !key || !formatAdminRoute(route)) return null;
  const generation = (state.generations[key] || 0) + 1;
  state.generations[key] = generation;
  return { key, generation, route: { ...route } };
}

export function isAdminRouteMutationCurrent(state, mutation, route) {
  return Boolean(
    state
    && mutation
    && state.generations[mutation.key] === mutation.generation
    && routeDescriptorsEqual(mutation.route, route),
  );
}

export function createOrganizationLoadState() {
  return { requestId: 0, organizationId: null, organization: null, loading: false, error: "" };
}

export function beginOrganizationLoad(state, route) {
  const organizationId = organizationIdForRoute(route);
  if (!organizationId) {
    return null;
  }
  state.requestId += 1;
  state.organizationId = organizationId;
  state.organization = null;
  state.loading = true;
  state.error = "";
  return { requestId: state.requestId, organizationId };
}

export function completeOrganizationLoad(state, request, organization) {
  if (
    !request
    || request.requestId !== state.requestId
    || request.organizationId !== state.organizationId
    || organization?.id !== request.organizationId
  ) {
    return false;
  }
  state.organization = organization;
  state.loading = false;
  state.error = "";
  return true;
}

export function failOrganizationLoad(state, request, error) {
  if (!request || request.requestId !== state.requestId || request.organizationId !== state.organizationId) {
    return false;
  }
  state.organization = null;
  state.loading = false;
  state.error = typeof error === "string" && error ? error : "unknown_error";
  return true;
}
