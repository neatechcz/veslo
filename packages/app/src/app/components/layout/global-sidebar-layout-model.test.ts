import assert from "node:assert/strict";
import test from "node:test";

import {
  GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH,
  GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH_EXIT,
  applyGlobalAvailableWidth,
  calculateGlobalAvailableWidth,
  createInitialGlobalSidebarState,
  toggleGlobalSidebarFromButton,
} from "./global-sidebar-layout-model.js";

test("initial state defaults to wide with provided docked preference", () => {
  const state = createInitialGlobalSidebarState({ left: true, right: true });
  assert.equal(state.mode, "wide");
  assert.deepEqual(state.docked, { left: true, right: true });
  assert.deepEqual(state.dockedPreference, { left: true, right: true });
  assert.equal(state.overlay, null);
});

test("enters narrow below minimum width and exits only at hysteresis threshold", () => {
  let state = createInitialGlobalSidebarState({ left: true, right: true });

  state = applyGlobalAvailableWidth(state, GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH - 1);
  assert.equal(state.mode, "narrow");
  assert.deepEqual(state.docked, { left: false, right: false });
  assert.equal(state.overlay, null);

  state = applyGlobalAvailableWidth(state, GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH_EXIT - 1);
  assert.equal(state.mode, "narrow");

  state = applyGlobalAvailableWidth(state, GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH_EXIT);
  assert.equal(state.mode, "wide");
  assert.deepEqual(state.docked, { left: true, right: true });
});

test("available width calculation uses actual docked visibility", () => {
  const hidden = calculateGlobalAvailableWidth(1180, { left: false, right: false });
  assert.equal(hidden, 1180);

  const leftOnly = calculateGlobalAvailableWidth(1180, { left: true, right: false });
  assert.equal(leftOnly, 920);

  const both = calculateGlobalAvailableWidth(1180, { left: true, right: true });
  assert.equal(both, 640);
});

test("narrow mode allows one overlay and blocks opposite-side toggle while open", () => {
  let state = createInitialGlobalSidebarState({ left: true, right: true });
  state = applyGlobalAvailableWidth(state, GLOBAL_CENTER_MIN_INTERACTIVE_WIDTH - 1);
  assert.equal(state.mode, "narrow");

  state = toggleGlobalSidebarFromButton(state, "left");
  assert.equal(state.overlay, "left");

  const unchanged = toggleGlobalSidebarFromButton(state, "right");
  assert.deepEqual(unchanged, state);

  state = toggleGlobalSidebarFromButton(state, "left");
  assert.equal(state.overlay, null);
});

test("wide mode toggle updates docked visibility and preference", () => {
  let state = createInitialGlobalSidebarState({ left: true, right: true });
  state = toggleGlobalSidebarFromButton(state, "left");
  assert.equal(state.mode, "wide");
  assert.deepEqual(state.docked, { left: false, right: true });
  assert.deepEqual(state.dockedPreference, { left: false, right: true });
});

