import assert from "node:assert/strict";
import test from "node:test";

import * as pageLoads from "../public-admin/admin-page-load-state.js";

const platformUsersRoute = {
  area: "platform",
  page: "platform-users",
  organizationId: null,
};

const organizationMembersRoute = (organizationId: string) => ({
  area: "organization",
  page: "members",
  organizationId,
});

test("route scope keys include organization identity", () => {
  assert.equal(pageLoads.adminRouteScopeKey(platformUsersRoute), "platform:platform-users");
  assert.equal(
    pageLoads.adminRouteScopeKey(organizationMembersRoute("org_a")),
    "organization:org_a:members",
  );
  assert.equal(
    pageLoads.adminRouteScopeKey(organizationMembersRoute(" org_a ")),
    "organization:org_a:members",
  );
});

test("beginning a newer page load invalidates all older completions", () => {
  const state = pageLoads.createAdminPageLoadState();
  const orgA = pageLoads.beginAdminPageLoad(state, organizationMembersRoute("org_a"));
  const orgB = pageLoads.beginAdminPageLoad(state, organizationMembersRoute("org_b"));

  assert.equal(pageLoads.isAdminPageLoadCurrent(state, orgA), false);
  assert.equal(pageLoads.completeAdminPageLoad(state, orgA, false), false);
  assert.equal(pageLoads.failAdminPageLoad(state, orgA, new Error("late")), false);
  assert.equal(pageLoads.completeAdminPageLoad(state, orgB, false), true);
  assert.equal(state.status, "ready");
});

test("successful page loads distinguish ready and empty states", () => {
  const state = pageLoads.createAdminPageLoadState();
  const readyRequest = pageLoads.beginAdminPageLoad(state, platformUsersRoute);

  assert.equal(state.status, "loading");
  assert.equal(pageLoads.completeAdminPageLoad(state, readyRequest, false), true);
  assert.equal(state.status, "ready");

  const emptyRequest = pageLoads.beginAdminPageLoad(state, platformUsersRoute);
  assert.equal(pageLoads.completeAdminPageLoad(state, emptyRequest, true), true);
  assert.equal(state.status, "empty");
});

test("errors are safe and aborts never create a visible page error", () => {
  const state = pageLoads.createAdminPageLoadState();
  const errorRequest = pageLoads.beginAdminPageLoad(state, platformUsersRoute);

  assert.equal(
    pageLoads.failAdminPageLoad(
      state,
      errorRequest,
      new Error("raw upstream response containing credential material"),
    ),
    true,
  );
  assert.equal(state.status, "error");
  assert.equal(state.error, "Unable to load data.");
  assert.doesNotMatch(JSON.stringify(state), /credential material/);

  const abortRequest = pageLoads.beginAdminPageLoad(state, platformUsersRoute);
  const abortError = Object.assign(new Error("request aborted"), { name: "AbortError" });
  assert.equal(pageLoads.failAdminPageLoad(state, abortRequest, abortError), true);
  assert.equal(state.status, "idle");
  assert.equal(state.error, "");
});

test("invalid routes fail closed and invalidate the active load", () => {
  const state = pageLoads.createAdminPageLoadState();
  const activeRequest = pageLoads.beginAdminPageLoad(state, platformUsersRoute);

  for (const route of [
    null,
    {},
    { area: "platform", page: "members", organizationId: null },
    { area: "platform", page: "platform-users", organizationId: "org_a" },
    { area: "organization", page: "members", organizationId: "" },
    { area: "organization", page: "members", organizationId: "   " },
    { area: "organization", page: "platform-users", organizationId: "org_a" },
  ]) {
    assert.equal(pageLoads.adminRouteScopeKey(route), null);
  }

  assert.equal(pageLoads.beginAdminPageLoad(state, null), null);
  assert.equal(state.status, "idle");
  assert.equal(state.key, null);
  assert.equal(pageLoads.isAdminPageLoadCurrent(state, activeRequest), false);
  assert.equal(pageLoads.completeAdminPageLoad(state, activeRequest, false), false);
});

test("request tokens and state remain serializable", () => {
  const state = pageLoads.createAdminPageLoadState();
  const first = pageLoads.beginAdminPageLoad(state, platformUsersRoute);
  const second = pageLoads.beginAdminPageLoad(state, organizationMembersRoute("org_a"));

  assert.deepEqual(first, { key: "platform:platform-users", generation: 1 });
  assert.deepEqual(second, { key: "organization:org_a:members", generation: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});
