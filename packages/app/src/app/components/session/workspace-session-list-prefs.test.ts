import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SIDEBAR_VIEW_MODE,
  readProjectOrder,
  readCollapsedProjectMap,
  readSidebarViewMode,
  writeProjectOrder,
  writeCollapsedProjectMap,
  writeSidebarViewMode,
  type SidebarPrefsStorage,
} from "./workspace-session-list-prefs.js";

const createMemoryStorage = (initial?: Record<string, string>): SidebarPrefsStorage & { snapshot: () => Record<string, string> } => {
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

test("sidebar view mode defaults to by-project", () => {
  const storage = createMemoryStorage();
  assert.equal(readSidebarViewMode(storage), DEFAULT_SIDEBAR_VIEW_MODE);
});

test("sidebar view mode accepts stored recent value", () => {
  const storage = createMemoryStorage({
    "veslo.sidebar-session-view.v1": "recent",
  });
  assert.equal(readSidebarViewMode(storage), "recent");
});

test("collapsed project map defaults to empty object", () => {
  const storage = createMemoryStorage();
  assert.deepEqual(readCollapsedProjectMap(storage), {});
});

test("collapsed project map ignores invalid payload", () => {
  const storage = createMemoryStorage({
    "veslo.sidebar-collapsed-projects.v1": "{\"project:a\":\"yes\"}",
  });
  assert.deepEqual(readCollapsedProjectMap(storage), {});
});

test("collapsed project map reads and writes boolean keys", () => {
  const storage = createMemoryStorage();
  writeCollapsedProjectMap(
    {
      "project:a": true,
      "project:b": false,
    },
    storage,
  );

  assert.deepEqual(readCollapsedProjectMap(storage), {
    "project:a": true,
    "project:b": false,
  });
});

test("writeSidebarViewMode persists selected mode", () => {
  const storage = createMemoryStorage();
  writeSidebarViewMode("recent", storage);
  assert.equal(storage.snapshot()["veslo.sidebar-session-view.v1"], "recent");
});

test("project order defaults to empty array", () => {
  const storage = createMemoryStorage();
  assert.deepEqual(readProjectOrder(storage), []);
});

test("project order reads valid string array", () => {
  const storage = createMemoryStorage({
    "veslo.sidebar-project-order.v1": JSON.stringify(["project:a", "project:b"]),
  });
  assert.deepEqual(readProjectOrder(storage), ["project:a", "project:b"]);
});

test("project order ignores invalid payload members", () => {
  const storage = createMemoryStorage({
    "veslo.sidebar-project-order.v1": JSON.stringify([" project:a ", 123, "", "project:a", "project:b"]),
  });
  assert.deepEqual(readProjectOrder(storage), ["project:a", "project:b"]);
});

test("writeProjectOrder persists normalized string array", () => {
  const storage = createMemoryStorage();
  writeProjectOrder([" project:a ", "", "project:b", "project:a"], storage);
  assert.equal(
    storage.snapshot()["veslo.sidebar-project-order.v1"],
    JSON.stringify(["project:a", "project:b"]),
  );
});
