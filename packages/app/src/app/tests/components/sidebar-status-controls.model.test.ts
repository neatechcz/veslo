import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConnectedUserLabel,
  getRuntimeReadinessMeta,
  getUnifiedStatusMeta,
  resolveConnectedUserLabel,
  getVesloStatusMeta,
} from "../../components/sidebar-status-controls.model";

test("unified status is ready when the user is logged in and the server is connected", () => {
  // Lazy boot policy: dot reflects "the app is operational" — engine /
  // workspace connection is per-workspace and surfaced separately.
  const readyEvenWithoutClient = getUnifiedStatusMeta(false, "reachable", false, true);
  assert.equal(readyEvenWithoutClient.label, "Ready");
  assert.equal(readyEvenWithoutClient.dot, "bg-green-9");

  const limited = getUnifiedStatusMeta(true, "limited", false, true);
  assert.equal(limited.label, "Limited");
  assert.equal(limited.dot, "bg-amber-9");

  const authDesync = getUnifiedStatusMeta(true, "auth_desync", false, true);
  assert.equal(authDesync.label, "Authentication failed");
  assert.equal(authDesync.dot, "bg-red-9");
});

test("unified status is unavailable when the user is not logged in", () => {
  const loggedOut = getUnifiedStatusMeta(true, "reachable", true, false);
  assert.equal(loggedOut.label, "Unavailable");
  assert.equal(loggedOut.dot, "bg-red-9");
});

test("veslo status label maps reachability, limited, auth desync and unavailable", () => {
  assert.equal(getVesloStatusMeta("reachable").label, "Connected");
  assert.equal(getVesloStatusMeta("limited").label, "Limited");
  assert.equal(getVesloStatusMeta("auth_desync").label, "Authentication failed");
  assert.equal(getVesloStatusMeta("unreachable").label, "Unavailable");
});

test("runtime readiness keeps a reachable server distinct from warmup and degradation", () => {
  assert.equal(getRuntimeReadinessMeta("ready")?.label, "Connected");
  assert.equal(getRuntimeReadinessMeta("starting")?.label, "Starting engine");
  assert.equal(getRuntimeReadinessMeta("degraded")?.label, "Limited");
  assert.equal(getRuntimeReadinessMeta("unavailable")?.label, "Unavailable");
  assert.equal(getRuntimeReadinessMeta("not-applicable"), null);
  assert.equal(getRuntimeReadinessMeta("unknown"), null);
});

test("connected user label trims whitespace and falls back when missing", () => {
  assert.equal(formatConnectedUserLabel("  alice  "), "alice");
  assert.equal(formatConnectedUserLabel(" "), "Not signed in");
  assert.equal(formatConnectedUserLabel(null), "Not signed in");
});

test("connected user label falls back to persisted auth when the reactive prop is blank", () => {
  assert.equal(resolveConnectedUserLabel("michal.sara@neatech.cz", "stale@example.com"), "michal.sara@neatech.cz");
  assert.equal(resolveConnectedUserLabel(" ", "michal.sara@neatech.cz"), "michal.sara@neatech.cz");
  assert.equal(resolveConnectedUserLabel(null, "  Michal Sara  "), "Michal Sara");
  assert.equal(resolveConnectedUserLabel(null, null), "Not signed in");
});
