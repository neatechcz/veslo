import assert from "node:assert/strict";
import test from "node:test";

import {
  formatConnectedUserLabel,
  getUnifiedStatusMeta,
  getVesloStatusMeta,
} from "./sidebar-status-controls.model";

test("unified status is ready only when both client and server are connected", () => {
  const ready = getUnifiedStatusMeta(true, "connected");
  assert.equal(ready.label, "Ready");
  assert.equal(ready.dot, "bg-green-9");

  const unavailable = getUnifiedStatusMeta(true, "limited");
  assert.equal(unavailable.label, "Unavailable");
  assert.equal(unavailable.dot, "bg-red-9");
});

test("veslo status label maps connected, limited and unavailable", () => {
  assert.equal(getVesloStatusMeta("connected").label, "Connected");
  assert.equal(getVesloStatusMeta("limited").label, "Limited");
  assert.equal(getVesloStatusMeta("disconnected").label, "Unavailable");
});

test("connected user label trims whitespace and falls back when missing", () => {
  assert.equal(formatConnectedUserLabel("  alice  "), "alice");
  assert.equal(formatConnectedUserLabel(" "), "Unknown");
  assert.equal(formatConnectedUserLabel(null), "Unknown");
});
