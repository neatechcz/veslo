import assert from "node:assert/strict";
import test from "node:test";

import { availableChatWidthForLayout } from "./session-layout-width.js";
import {
  applyAvailableWidth,
  createInitialSidebarLayoutState,
  SESSION_CHAT_MIN_WIDTH,
  toggleSidebarFromButton,
  type SidebarLayoutState,
} from "../components/session/sidebar-layout-model.js";

test("narrow mode keeps using docked preference for width decisions to avoid wide/narrow flicker", () => {
  const state: SidebarLayoutState = {
    mode: "narrow",
    docked: { left: false, right: false },
    dockedPreference: { left: true, right: true },
    overlay: null,
  };

  assert.equal(availableChatWidthForLayout(500, state), 0);
});

test("wide mode uses currently docked sidebars for width decisions", () => {
  const state: SidebarLayoutState = {
    mode: "wide",
    docked: { left: true, right: false },
    dockedPreference: { left: true, right: false },
    overlay: null,
  };

  assert.equal(availableChatWidthForLayout(800, state), 540);
});

test("wide mode accepts custom left sidebar width", () => {
  const state: SidebarLayoutState = {
    mode: "wide",
    docked: { left: true, right: false },
    dockedPreference: { left: true, right: false },
    overlay: null,
  };

  assert.equal(availableChatWidthForLayout(800, state, 300), 500);
});

test("left menu takes priority over right preference in narrow mode so layout can return to wide", () => {
  let state = createInitialSidebarLayoutState({ left: true, right: true });
  state = applyAvailableWidth(state, SESSION_CHAT_MIN_WIDTH - 1);
  assert.equal(state.mode, "narrow");

  state = toggleSidebarFromButton(state, "right");
  assert.equal(state.overlay, "right");

  state = toggleSidebarFromButton(state, "left");
  assert.equal(state.overlay, "left");
  assert.deepEqual(state.dockedPreference, { left: true, right: false });

  const availableWidth = availableChatWidthForLayout(700, state);
  assert.equal(availableWidth, 440);

  state = applyAvailableWidth(state, availableWidth);
  assert.equal(state.mode, "wide");
  assert.deepEqual(state.docked, { left: true, right: false });
});
