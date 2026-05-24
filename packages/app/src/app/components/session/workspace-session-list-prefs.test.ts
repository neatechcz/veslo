import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CHAT_SIDEBAR_DEFAULT_HEIGHT_PX,
  CHAT_SIDEBAR_MIN_HEIGHT_PX,
} from "./workspace-session-list-windowing.js";

import {
  DEFAULT_SIDEBAR_VIEW_MODE,
  SIDEBAR_CHAT_COLLAPSED_KEY,
  SIDEBAR_CHAT_HEIGHT_KEY,
  readExpandedParentSessionIds,
  readChatSidebarCollapsed,
  readChatSidebarHeight,
  readProjectOrder,
  readCollapsedProjectMap,
  readSidebarViewMode,
  writeExpandedParentSessionIds,
  writeChatSidebarCollapsed,
  writeChatSidebarHeight,
  writeProjectOrder,
  writeCollapsedProjectMap,
  writeSidebarViewMode,
  type SidebarPrefsStorage,
} from "./workspace-session-list-prefs.js";

const source = readFileSync(new URL("./workspace-session-list-prefs.ts", import.meta.url), "utf8");

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

test("expanded parent session ids read and write normalized ids", () => {
  const storage = createMemoryStorage({
    "veslo.sidebar-expanded-parent-sessions.v1": JSON.stringify([" session-a ", 123, "", "session-a", "session-b"]),
  });

  assert.deepEqual(Array.from(readExpandedParentSessionIds(storage)), ["session-a", "session-b"]);

  writeExpandedParentSessionIds(new Set([" session-c ", "", "session-b", "session-c"]), storage);

  assert.equal(
    storage.snapshot()["veslo.sidebar-expanded-parent-sessions.v1"],
    JSON.stringify(["session-c", "session-b"]),
  );
});

test("chat sidebar height reads and writes normalized pixels", () => {
  const storage = createMemoryStorage({
    [SIDEBAR_CHAT_HEIGHT_KEY]: "320",
  });

  assert.equal(readChatSidebarHeight(storage), 320);

  writeChatSidebarHeight(37, storage);
  assert.equal(storage.snapshot()[SIDEBAR_CHAT_HEIGHT_KEY], String(CHAT_SIDEBAR_MIN_HEIGHT_PX));
});

test("chat sidebar height defaults on missing or invalid storage", () => {
  assert.equal(readChatSidebarHeight(createMemoryStorage()), CHAT_SIDEBAR_DEFAULT_HEIGHT_PX);
  assert.equal(
    readChatSidebarHeight(createMemoryStorage({ [SIDEBAR_CHAT_HEIGHT_KEY]: "tiny" })),
    CHAT_SIDEBAR_DEFAULT_HEIGHT_PX,
  );
});

test("chat sidebar collapsed state reads and writes compact booleans", () => {
  const storage = createMemoryStorage({
    [SIDEBAR_CHAT_COLLAPSED_KEY]: "1",
  });

  assert.equal(readChatSidebarCollapsed(storage), true);

  writeChatSidebarCollapsed(false, storage);
  assert.equal(storage.snapshot()[SIDEBAR_CHAT_COLLAPSED_KEY], "0");

  writeChatSidebarCollapsed(true, storage);
  assert.equal(storage.snapshot()[SIDEBAR_CHAT_COLLAPSED_KEY], "1");
});

test("prefs source no longer defines archived visibility helpers", () => {
  assert.doesNotMatch(source, /SIDEBAR_SHOW_ARCHIVED_KEY/);
  assert.doesNotMatch(source, /readShowArchivedSessions/);
  assert.doesNotMatch(source, /writeShowArchivedSessions/);
});
