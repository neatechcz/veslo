import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConnectedUserLabel,
  getUnifiedStatusMeta,
  resolveConnectedUserLabel,
  getVesloStatusMeta,
} from "../../components/sidebar-status-controls.model";

test("unified status is ready when the user is logged in and the server is connected", () => {
  // Lazy boot policy: dot reflects "the app is operational" — engine /
  // workspace connection is per-workspace and surfaced separately.
  const readyEvenWithoutClient = getUnifiedStatusMeta(false, "connected", false, true);
  assert.equal(readyEvenWithoutClient.label, "Ready");
  assert.equal(readyEvenWithoutClient.dot, "bg-green-9");

  const limited = getUnifiedStatusMeta(true, "limited", false, true);
  assert.equal(limited.label, "Unavailable");
  assert.equal(limited.dot, "bg-red-9");
});

test("unified status is unavailable when the user is not logged in", () => {
  const loggedOut = getUnifiedStatusMeta(true, "connected", true, false);
  assert.equal(loggedOut.label, "Unavailable");
  assert.equal(loggedOut.dot, "bg-red-9");
});

test("veslo status label maps connected, limited and unavailable", () => {
  assert.equal(getVesloStatusMeta("connected").label, "Connected");
  assert.equal(getVesloStatusMeta("limited").label, "Limited");
  assert.equal(getVesloStatusMeta("disconnected").label, "Unavailable");
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
