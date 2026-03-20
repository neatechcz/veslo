import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_GLOBAL_SIDEBAR_DOCKED_VISIBILITY,
  GLOBAL_SIDEBAR_DOCKED_PREF_KEY,
  LEGACY_SESSION_SIDEBAR_DOCKED_PREF_KEY,
  readGlobalSidebarDockedPrefs,
  writeGlobalSidebarDockedPrefs,
} from "./global-sidebar-prefs.js";

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

test("defaults to left-visible global prefs when storage is empty", () => {
  const storage = createMemoryStorage();
  const value = readGlobalSidebarDockedPrefs(storage);
  assert.deepEqual(value, DEFAULT_GLOBAL_SIDEBAR_DOCKED_VISIBILITY);
});

test("reads global prefs directly when present", () => {
  const storage = createMemoryStorage({
    [GLOBAL_SIDEBAR_DOCKED_PREF_KEY]: JSON.stringify({ left: false, right: true }),
  });
  const value = readGlobalSidebarDockedPrefs(storage);
  assert.deepEqual(value, { left: false, right: true });
});

test("migrates legacy session prefs into global key", () => {
  const storage = createMemoryStorage({
    [LEGACY_SESSION_SIDEBAR_DOCKED_PREF_KEY]: JSON.stringify({ left: false, right: false }),
  });

  const value = readGlobalSidebarDockedPrefs(storage);
  assert.deepEqual(value, { left: false, right: false });

  const snapshot = storage.snapshot();
  assert.equal(snapshot[GLOBAL_SIDEBAR_DOCKED_PREF_KEY], JSON.stringify({ left: false, right: false }));
});

test("falls back to defaults for invalid payload", () => {
  const storage = createMemoryStorage({
    [GLOBAL_SIDEBAR_DOCKED_PREF_KEY]: "{\"left\":\"bad\",\"right\":true}",
  });
  const value = readGlobalSidebarDockedPrefs(storage);
  assert.deepEqual(value, DEFAULT_GLOBAL_SIDEBAR_DOCKED_VISIBILITY);
});

test("write helper persists normalized booleans", () => {
  const storage = createMemoryStorage();
  writeGlobalSidebarDockedPrefs({ left: true, right: false }, storage);
  const snapshot = storage.snapshot();
  assert.equal(snapshot[GLOBAL_SIDEBAR_DOCKED_PREF_KEY], JSON.stringify({ left: true, right: false }));
});

