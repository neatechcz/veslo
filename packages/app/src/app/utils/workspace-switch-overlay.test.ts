import assert from "node:assert/strict";
import test from "node:test";

import { computeWorkspaceSwitchOverlayHoldMs } from "./workspace-switch-overlay.js";

test("returns zero hold when overlay was never shown", () => {
  const holdMs = computeWorkspaceSwitchOverlayHoldMs({
    visibleSinceMs: null,
    nowMs: 1_000,
    minVisibleMs: 350,
  });

  assert.equal(holdMs, 0);
});

test("returns remaining hold when overlay closes too quickly", () => {
  const holdMs = computeWorkspaceSwitchOverlayHoldMs({
    visibleSinceMs: 1_000,
    nowMs: 1_200,
    minVisibleMs: 350,
  });

  assert.equal(holdMs, 150);
});

test("returns zero once minimum visible time elapsed", () => {
  const holdMs = computeWorkspaceSwitchOverlayHoldMs({
    visibleSinceMs: 1_000,
    nowMs: 1_450,
    minVisibleMs: 350,
  });

  assert.equal(holdMs, 0);
});
