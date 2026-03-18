import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAvailableWidth,
  createInitialSidebarLayoutState,
  toggleSidebarFromButton,
  SESSION_CHAT_MIN_WIDTH,
  SESSION_CHAT_MIN_WIDTH_EXIT,
} from "./sidebar-layout-model.js";

test("enters narrow below minimum width and exits only at hysteresis threshold", () => {
  let state = createInitialSidebarLayoutState({ left: true, right: true });

  state = applyAvailableWidth(state, SESSION_CHAT_MIN_WIDTH - 1);
  assert.equal(state.mode, "narrow");

  state = applyAvailableWidth(state, SESSION_CHAT_MIN_WIDTH);
  assert.equal(state.mode, "narrow");

  state = applyAvailableWidth(state, SESSION_CHAT_MIN_WIDTH_EXIT - 1);
  assert.equal(state.mode, "narrow");

  state = applyAvailableWidth(state, SESSION_CHAT_MIN_WIDTH_EXIT);
  assert.equal(state.mode, "wide");
});

test("narrow mode allows only one overlay and ignores opposite-side toggle while open", () => {
  let state = createInitialSidebarLayoutState({ left: true, right: true });
  state = applyAvailableWidth(state, SESSION_CHAT_MIN_WIDTH - 1);

  state = toggleSidebarFromButton(state, "left");
  assert.equal(state.overlay, "left");

  const unchanged = toggleSidebarFromButton(state, "right");
  assert.deepEqual(unchanged, state);

  state = toggleSidebarFromButton(state, "left");
  assert.equal(state.overlay, null);

  state = toggleSidebarFromButton(state, "right");
  assert.equal(state.overlay, "right");
});

test("wide docked toggles persist preference and restore after narrow mode", () => {
  let state = createInitialSidebarLayoutState({ left: true, right: true });

  state = toggleSidebarFromButton(state, "left");
  assert.deepEqual(state.docked, { left: false, right: true });
  assert.deepEqual(state.dockedPreference, { left: false, right: true });

  state = applyAvailableWidth(state, SESSION_CHAT_MIN_WIDTH - 1);
  assert.equal(state.mode, "narrow");
  assert.deepEqual(state.docked, { left: false, right: false });
  assert.deepEqual(state.dockedPreference, { left: false, right: true });

  state = toggleSidebarFromButton(state, "right");
  assert.equal(state.overlay, "right");
  assert.deepEqual(state.dockedPreference, { left: false, right: true });

  state = applyAvailableWidth(state, SESSION_CHAT_MIN_WIDTH_EXIT);
  assert.equal(state.mode, "wide");
  assert.equal(state.overlay, null);
  assert.deepEqual(state.docked, { left: false, right: true });
});
