import assert from "node:assert/strict";
import test from "node:test";

import {
  LEFT_SIDEBAR_WIDTH_DEFAULT,
  LEFT_SIDEBAR_WIDTH_MAX,
  LEFT_SIDEBAR_WIDTH_MIN,
  clampLeftSidebarWidth,
  readLeftSidebarWidth,
  writeLeftSidebarWidth,
  type LeftSidebarWidthStorage,
} from "../../../components/layout/left-sidebar-width-prefs.js";
import { NEW_SESSION_LABEL_VISIBLE_WIDTH } from "../../../components/session/workspace-session-list-model.js";

const createMemoryStorage = (
  initial?: Record<string, string>,
): LeftSidebarWidthStorage & { snapshot: () => Record<string, string> } => {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
    snapshot() {
      return Object.fromEntries(map.entries());
    },
  };
};

test("clampLeftSidebarWidth respects min and max bounds", () => {
  assert.equal(clampLeftSidebarWidth(LEFT_SIDEBAR_WIDTH_MIN - 50), LEFT_SIDEBAR_WIDTH_MIN);
  assert.equal(clampLeftSidebarWidth(LEFT_SIDEBAR_WIDTH_MAX + 50), LEFT_SIDEBAR_WIDTH_MAX);
  assert.equal(clampLeftSidebarWidth(LEFT_SIDEBAR_WIDTH_DEFAULT), LEFT_SIDEBAR_WIDTH_DEFAULT);
});

test("readLeftSidebarWidth falls back to default for invalid payload", () => {
  const storage = createMemoryStorage({ "veslo.global.sidebar.left-width.v1": "invalid" });
  assert.equal(readLeftSidebarWidth(storage), LEFT_SIDEBAR_WIDTH_DEFAULT);
});

test("writeLeftSidebarWidth persists clamped value", () => {
  const storage = createMemoryStorage();
  writeLeftSidebarWidth(999, storage);
  assert.equal(
    storage.snapshot()["veslo.global.sidebar.left-width.v1"],
    String(LEFT_SIDEBAR_WIDTH_MAX),
  );
});

test("writeLeftSidebarWidth round-trips through read", () => {
  const storage = createMemoryStorage();
  writeLeftSidebarWidth(280, storage);
  assert.equal(readLeftSidebarWidth(storage), 280);
});

test("minimum left sidebar width keeps enough inner control width to show the compact new-session label", () => {
  // Dashboard/sidebar shell uses 16px horizontal padding per side plus a 1px right border.
  const controlsRowWidthAtMinimum = LEFT_SIDEBAR_WIDTH_MIN - 33;
  assert.ok(
    controlsRowWidthAtMinimum >= NEW_SESSION_LABEL_VISIBLE_WIDTH,
    "minimum sidebar width should still allow the 'New' label to appear in the controls row",
  );
});
