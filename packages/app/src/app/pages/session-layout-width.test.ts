import assert from "node:assert/strict";
import test from "node:test";

import { availableChatWidthForLayout } from "./session-layout-width.js";
import type { SidebarLayoutState } from "../components/session/sidebar-layout-model.js";

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
