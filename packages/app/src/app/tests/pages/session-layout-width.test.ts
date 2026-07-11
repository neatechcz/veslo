import assert from "node:assert/strict";
import test from "node:test";

import {
  availableChatWidthForLayout,
  reconcileSidebarLayoutForRootWidth,
  responsiveLayoutRootWidth,
} from "../../pages/session-layout-width.js";
import {
  applyAvailableWidth,
  createInitialSidebarLayoutState,
  SESSION_CHAT_MIN_WIDTH,
  toggleSidebarFromButton,
  type SidebarLayoutState,
} from "../../components/session/sidebar-layout-model.js";

test("narrow mode keeps using docked preference for width decisions to avoid wide/narrow flicker", () => {
  const state: SidebarLayoutState = {
    mode: "narrow",
    docked: { left: false, right: false },
    dockedPreference: { left: true, right: true },
    overlay: null,
  };

  assert.equal(availableChatWidthForLayout(500, state), 0);
});

test("viewport width wins when flex overflow prevents the layout root from shrinking", () => {
  assert.equal(responsiveLayoutRootWidth(1120, 390), 390);
  assert.equal(responsiveLayoutRootWidth(768, 1440), 768);
  assert.equal(responsiveLayoutRootWidth(0, 390), 390);
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

test("wide layout keeps left sidebar docked by collapsing right sidebar before entering narrow mode", () => {
  let state = createInitialSidebarLayoutState({ left: true, right: true });
  state = reconcileSidebarLayoutForRootWidth(state, 1050, 420);
  assert.equal(state.mode, "wide");
  assert.deepEqual(state.docked, { left: true, right: false });
  assert.deepEqual(state.dockedPreference, { left: true, right: true });
});

test("auto-collapsed right sidebar is restored when width can fit both sidebars again", () => {
  const state: SidebarLayoutState = {
    mode: "wide",
    docked: { left: true, right: false },
    dockedPreference: { left: true, right: true },
    overlay: null,
  };

  const next = reconcileSidebarLayoutForRootWidth(state, 1092, 420);
  assert.equal(next.mode, "wide");
  assert.deepEqual(next.docked, { left: true, right: true });
});

test("left resize can keep the left menu open as an overlay when chat width falls below the minimum", () => {
  const state = createInitialSidebarLayoutState({ left: true, right: true });

  const next = reconcileSidebarLayoutForRootWidth(state, 760, 420, {
    overlayOnNarrow: "left",
  });

  assert.equal(next.mode, "narrow");
  assert.deepEqual(next.docked, { left: false, right: false });
  assert.equal(next.overlay, "left");
  assert.deepEqual(next.dockedPreference, { left: true, right: true });
});
