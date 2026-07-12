import assert from "node:assert/strict";
import test from "node:test";

const routes = await import("../public-admin/admin-route-state.js")
  .catch(() => ({} as Record<string, unknown>)) as Record<string, any>;

const routeCases = [
  ["/admin", { area: "platform", page: "overview", organizationId: null }],
  ["/admin/organizations", { area: "platform", page: "organizations", organizationId: null }],
  ["/admin/ai-infrastructure", { area: "platform", page: "ai-infrastructure", organizationId: null }],
  ["/admin/ai-infrastructure/usage", { area: "platform", page: "ai-usage", organizationId: null }],
  ["/admin/ai-infrastructure/alerts", { area: "platform", page: "ai-alerts", organizationId: null }],
  ["/admin/platform-users", { area: "platform", page: "platform-users", organizationId: null }],
  ["/admin/audit", { area: "platform", page: "audit", organizationId: null }],
  ["/admin/organizations/org_1/overview", { area: "organization", page: "overview", organizationId: "org_1" }],
  ["/admin/organizations/org_1/members", { area: "organization", page: "members", organizationId: "org_1" }],
  ["/admin/organizations/org_1/domains-invites", { area: "organization", page: "domains-invites", organizationId: "org_1" }],
  ["/admin/organizations/org_1/billing", { area: "organization", page: "billing", organizationId: "org_1" }],
  ["/admin/organizations/org_1/ai-access", { area: "organization", page: "ai-access", organizationId: "org_1" }],
  ["/admin/organizations/org_1/audit", { area: "organization", page: "audit", organizationId: "org_1" }],
] as const;

test("route parser and formatter round-trip every canonical admin route", () => {
  assert.equal(typeof routes.parseAdminRoute, "function");
  assert.equal(typeof routes.formatAdminRoute, "function");

  for (const [pathname, descriptor] of routeCases) {
    assert.deepEqual(routes.parseAdminRoute(pathname), descriptor, pathname);
    assert.equal(routes.formatAdminRoute(descriptor), pathname);
  }

  const encoded = { area: "organization", page: "overview", organizationId: "org alpha/one" };
  assert.equal(routes.formatAdminRoute(encoded), "/admin/organizations/org%20alpha%2Fone/overview");
  assert.deepEqual(routes.parseAdminRoute(routes.formatAdminRoute(encoded)), encoded);
});

test("invalid and legacy flat paths do not produce route descriptors", () => {
  assert.equal(typeof routes.parseAdminRoute, "function");
  for (const pathname of [
    "/", "/admin/", "/admin/organization", "/admin/credentials", "/admin/users", "/admin/usage",
    "/admin/alerts", "/admin/organizations//overview", "/admin/organizations/org_1", "/admin/organizations/org_1/unknown",
    "/admin/organizations/org_1/overview/extra", "/admin/not-a-page",
  ]) {
    assert.equal(routes.parseAdminRoute(pathname), null, pathname);
  }
});

test("platform routes always clear organization context and organization routes require an id", () => {
  assert.equal(typeof routes.toPlatformRoute, "function");
  assert.equal(typeof routes.organizationIdForRoute, "function");

  const platform = routes.toPlatformRoute("audit");
  assert.deepEqual(platform, { area: "platform", page: "audit", organizationId: null });
  assert.equal(routes.organizationIdForRoute(platform), null);
  assert.equal(routes.formatAdminRoute({ area: "organization", page: "overview", organizationId: "" }), null);
});

test("switching organizations preserves the organization subpage", () => {
  assert.equal(typeof routes.switchOrganizationRoute, "function");
  const current = { area: "organization", page: "domains-invites", organizationId: "org_a" };
  assert.deepEqual(
    routes.switchOrganizationRoute(current, "org_b"),
    { area: "organization", page: "domains-invites", organizationId: "org_b" },
  );
  assert.deepEqual(
    routes.switchOrganizationRoute({ area: "platform", page: "organizations", organizationId: null }, "org_b"),
    { area: "organization", page: "overview", organizationId: "org_b" },
  );
});

test("navigation and popstate replace the complete descriptor without stale organization context", () => {
  assert.equal(typeof routes.createAdminNavigationState, "function");
  assert.equal(typeof routes.navigateAdminRoute, "function");
  assert.equal(typeof routes.applyAdminPopState, "function");

  const state = routes.createAdminNavigationState(routes.parseAdminRoute("/admin/organizations/org_a/members"));
  routes.navigateAdminRoute(state, routes.toPlatformRoute("platform-users"));
  assert.deepEqual(state.route, { area: "platform", page: "platform-users", organizationId: null });

  assert.equal(routes.applyAdminPopState(state, "/admin/organizations/org_b/ai-access"), true);
  assert.deepEqual(state.route, { area: "organization", page: "ai-access", organizationId: "org_b" });
  assert.equal(routes.applyAdminPopState(state, "/admin/bad"), false);
  assert.deepEqual(state.route, { area: "organization", page: "ai-access", organizationId: "org_b" });
});

test("history planning canonicalizes same-path stale query and hash context", () => {
  assert.equal(typeof routes.planAdminHistoryUpdate, "function");
  const platformOverview = routes.toPlatformRoute("overview");

  assert.deepEqual(
    routes.planAdminHistoryUpdate(platformOverview, {
      pathname: "/admin",
      search: "?organizationId=org_stale&groupBy=org",
      hash: "#organization",
    }, "push"),
    { method: "push", pathname: "/admin" },
  );
  assert.deepEqual(
    routes.planAdminHistoryUpdate(platformOverview, {
      pathname: "/admin",
      search: "?organizationId=org_stale",
      hash: "",
    }, "replace"),
    { method: "replace", pathname: "/admin" },
  );
  assert.deepEqual(
    routes.planAdminHistoryUpdate(platformOverview, { pathname: "/admin", search: "", hash: "" }, "push"),
    { method: null, pathname: "/admin" },
  );
});

test("popstate route planning replaces noncanonical URL context before loading", () => {
  assert.equal(typeof routes.planAdminHistoryUpdate, "function");
  const state = routes.createAdminNavigationState(routes.toPlatformRoute("organizations"));
  assert.equal(routes.applyAdminPopState(state, "/admin"), true);
  assert.deepEqual(
    routes.planAdminHistoryUpdate(
      state.route,
      { pathname: "/admin", search: "?organizationId=org_old", hash: "#members" },
      "replace",
    ),
    { method: "replace", pathname: "/admin" },
  );
});

test("organization admins cannot access platform routes or unauthorized organizations", () => {
  assert.equal(typeof routes.canAccessAdminRoute, "function");
  const orgAdmin = { platformAdmin: false, organizationIds: ["org_1"] };
  assert.equal(routes.canAccessAdminRoute(routes.parseAdminRoute("/admin"), orgAdmin), false);
  assert.equal(routes.canAccessAdminRoute(routes.parseAdminRoute("/admin/organizations/org_1/overview"), orgAdmin), true);
  assert.equal(routes.canAccessAdminRoute(routes.parseAdminRoute("/admin/organizations/org_2/overview"), orgAdmin), false);
  assert.equal(routes.canAccessAdminRoute(routes.parseAdminRoute("/admin/audit"), { platformAdmin: true, organizationIds: [] }), true);
});

test("stale organization loads cannot replace a newer routed organization", () => {
  assert.equal(typeof routes.createOrganizationLoadState, "function");
  assert.equal(typeof routes.beginOrganizationLoad, "function");
  assert.equal(typeof routes.completeOrganizationLoad, "function");

  const state = routes.createOrganizationLoadState();
  const first = routes.beginOrganizationLoad(state, { area: "organization", page: "overview", organizationId: "org_a" });
  const second = routes.beginOrganizationLoad(state, { area: "organization", page: "overview", organizationId: "org_b" });
  assert.equal(routes.completeOrganizationLoad(state, first, { id: "org_a", name: "A" }), false);
  assert.equal(state.organization, null);
  assert.equal(routes.completeOrganizationLoad(state, second, { id: "org_b", name: "B" }), true);
  assert.deepEqual(state.organization, { id: "org_b", name: "B" });
});

test("platform authority does not grant global user actions inside organization routes", () => {
  assert.equal(typeof routes.adminUserRoutePermissions, "function");
  assert.equal(typeof routes.canPerformAdminRouteAction, "function");
  const access = {
    platformAdmin: true,
    organizationIds: ["org_1"],
    capabilities: ["managedAiUserAccess"],
  };
  const members = { area: "organization", page: "members", organizationId: "org_1" };
  const aiAccess = { area: "organization", page: "ai-access", organizationId: "org_1" };

  assert.deepEqual(routes.adminUserRoutePermissions(members, access), {
    createUser: false,
    editProfile: false,
    editMembership: true,
    editAiAccess: false,
    setPlatformAdmin: false,
    disableUser: false,
    deleteUser: false,
  });
  assert.deepEqual(routes.adminUserRoutePermissions(aiAccess, access), {
    createUser: false,
    editProfile: false,
    editMembership: false,
    editAiAccess: true,
    setPlatformAdmin: false,
    disableUser: false,
    deleteUser: false,
  });
  assert.deepEqual(
    routes.adminUserRoutePermissions(aiAccess, {
      platformAdmin: false,
      organizationIds: ["org_1"],
      capabilities: ["organization", "users"],
    }),
    {
      createUser: false,
      editProfile: false,
      editMembership: false,
      editAiAccess: false,
      setPlatformAdmin: false,
      disableUser: false,
      deleteUser: false,
    },
  );
  for (const action of ["create-user", "edit-user-profile", "set-platform-admin", "disable-user", "delete-user"]) {
    assert.equal(routes.canPerformAdminRouteAction(members, access, action), false, action);
    assert.equal(routes.canPerformAdminRouteAction(aiAccess, access, action), false, action);
  }
  assert.equal(routes.canPerformAdminRouteAction(members, access, "edit-membership"), true);
  assert.equal(routes.canPerformAdminRouteAction(aiAccess, access, "edit-ai-access"), true);
  assert.equal(routes.canPerformAdminRouteAction(
    { area: "organization", page: "overview", organizationId: "org_1" },
    access,
    "edit-organization-profile",
  ), true);
  assert.equal(routes.canPerformAdminRouteAction(
    { area: "organization", page: "domains-invites", organizationId: "org_1" },
    access,
    "manage-organization-domains",
  ), true);
});

test("user update payloads contain only fields authorized by the canonical route", () => {
  assert.equal(typeof routes.buildAdminUserUpdatePayload, "function");
  const input = {
    name: "Global Name",
    platformAdmin: true,
    orgId: "org_wrong",
    orgRole: "organization_admin",
  };
  const platform = { area: "platform", page: "platform-users", organizationId: null };
  const members = { area: "organization", page: "members", organizationId: "org_1" };
  const aiAccess = { area: "organization", page: "ai-access", organizationId: "org_1" };
  const platformAccess = { platformAdmin: true, organizationIds: ["org_1"], capabilities: ["managedAiUserAccess"] };

  assert.deepEqual(routes.buildAdminUserUpdatePayload(platform, platformAccess, input), input);
  assert.deepEqual(
    routes.buildAdminUserUpdatePayload(members, platformAccess, input),
    { orgId: "org_1", orgRole: "organization_admin" },
  );
  assert.equal(routes.buildAdminUserUpdatePayload(aiAccess, platformAccess, input), null);
});

test("route mutation tokens reject pending success and error after switching organizations", () => {
  assert.equal(typeof routes.createAdminMutationState, "function");
  assert.equal(typeof routes.beginAdminRouteMutation, "function");
  assert.equal(typeof routes.isAdminRouteMutationCurrent, "function");
  const mutations = routes.createAdminMutationState();
  const orgA = { area: "organization", page: "members", organizationId: "org_a" };
  const orgB = { area: "organization", page: "members", organizationId: "org_b" };

  const pendingSuccess = routes.beginAdminRouteMutation(mutations, "member-save", orgA);
  assert.equal(routes.isAdminRouteMutationCurrent(mutations, pendingSuccess, orgB), false);

  const pendingError = routes.beginAdminRouteMutation(mutations, "member-save", orgA);
  assert.equal(routes.isAdminRouteMutationCurrent(mutations, pendingError, orgB), false);

  const current = routes.beginAdminRouteMutation(mutations, "member-save", orgB);
  assert.equal(routes.isAdminRouteMutationCurrent(mutations, pendingError, orgA), false);
  assert.equal(routes.isAdminRouteMutationCurrent(mutations, current, orgB), true);
});

test("billing actions are organization scoped and manual controls remain platform only", () => {
  const billing = { area: "organization", page: "billing", organizationId: "org_1" };
  const orgAdmin = { platformAdmin: false, organizationIds: ["org_1"], organizationAdminIds: ["org_1"], capabilities: ["organization", "users"] };
  const orgMember = { platformAdmin: false, organizationIds: ["org_1"], organizationAdminIds: [], capabilities: ["organization", "users"] };
  const platformAdmin = { platformAdmin: true, organizationIds: [], capabilities: ["organization"] };
  assert.equal(routes.canPerformAdminRouteAction(billing, orgAdmin, "manage-organization-billing"), true);
  assert.equal(routes.canPerformAdminRouteAction(billing, orgMember, "manage-organization-billing"), false);
  assert.equal(routes.canPerformAdminRouteAction(billing, orgAdmin, "manage-platform-billing"), false);
  assert.equal(routes.canPerformAdminRouteAction(billing, platformAdmin, "manage-platform-billing"), true);
  assert.equal(routes.canPerformAdminRouteAction(
    { area: "organization", page: "overview", organizationId: "org_1" },
    platformAdmin,
    "manage-organization-billing",
  ), false);
});

test("manual billing expiry round-trips through datetime-local in Europe/Prague", () => {
  assert.equal(typeof routes.toAdminDateTimeLocalValue, "function");
  assert.equal(typeof routes.fromAdminDateTimeLocalValue, "function");
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Europe/Prague";
  try {
    for (const iso of ["2026-01-15T12:30:00.000Z", "2026-07-15T12:30:00.000Z"]) {
      const localValue = routes.toAdminDateTimeLocalValue(iso);
      assert.equal(routes.fromAdminDateTimeLocalValue(localValue), iso);
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
