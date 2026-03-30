import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED,
  SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY,
  readSidebarDashboardNavCollapsed,
  writeSidebarDashboardNavCollapsed,
  type SidebarDashboardNavPrefsStorage,
} from "./sidebar-dashboard-nav-prefs.js";

const createMemoryStorage = (initial?: Record<string, string>) => {
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

test("defaults to collapsed when storage is unavailable", () => {
  assert.equal(readSidebarDashboardNavCollapsed(), DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED);
});

test("reads stored collapsed value", () => {
  const storage = createMemoryStorage({
    [SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY]: "false",
  });

  assert.equal(readSidebarDashboardNavCollapsed(storage), false);
});

test("falls back to default when stored value is invalid", () => {
  const storage = createMemoryStorage({
    [SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY]: "\"invalid\"",
  });

  assert.equal(readSidebarDashboardNavCollapsed(storage), DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED);
});

test("writes collapsed value", () => {
  const storage = createMemoryStorage();

  writeSidebarDashboardNavCollapsed(false, storage);

  assert.equal(storage.snapshot()[SIDEBAR_DASHBOARD_NAV_COLLAPSED_KEY], "false");
});

test("ignores storage write failures", () => {
  const storage: SidebarDashboardNavPrefsStorage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error("boom");
    },
  };

  assert.doesNotThrow(() => {
    writeSidebarDashboardNavCollapsed(true, storage);
  });
});

test("falls back safely when window.localStorage accessor throws", () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const throwingWindow = {};
  Object.defineProperty(throwingWindow, "localStorage", {
    configurable: true,
    get() {
      throw new Error("denied");
    },
  });

  Object.defineProperty(globalThis, "window", {
    value: throwingWindow,
    configurable: true,
    writable: true,
  });

  try {
    assert.equal(readSidebarDashboardNavCollapsed(), DEFAULT_SIDEBAR_DASHBOARD_NAV_COLLAPSED);
    assert.doesNotThrow(() => {
      writeSidebarDashboardNavCollapsed(false);
    });
  } finally {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
});
