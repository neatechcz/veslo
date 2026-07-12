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
