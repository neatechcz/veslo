import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_GLOBAL_SIDEBAR_DOCKED_VISIBILITY,
  GLOBAL_SIDEBAR_DOCKED_PREF_KEY,
  LEGACY_SESSION_SIDEBAR_DOCKED_PREF_KEY,
  readGlobalSidebarDockedPrefs,
  writeGlobalSidebarDockedPrefs,
} from "../../../components/layout/global-sidebar-prefs.js";

const dashboardSource = readFileSync(new URL("../../../pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../../../pages/session.tsx", import.meta.url), "utf8");

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

test("defaults to left-visible and right-collapsed global prefs when storage is empty", () => {
  const storage = createMemoryStorage();
  const value = readGlobalSidebarDockedPrefs(storage);
  assert.deepEqual(value, { left: true, right: false });
  assert.deepEqual(DEFAULT_GLOBAL_SIDEBAR_DOCKED_VISIBILITY, { left: true, right: false });
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

test("dashboard and session views use shared global sidebar prefs", () => {
  for (const [name, source] of [
    ["dashboard", dashboardSource],
    ["session", sessionSource],
  ] as const) {
    assert.match(
      source,
      /readGlobalSidebarDockedPrefs/,
      `${name} view should read docked sidebar visibility through the shared helper`,
    );
    assert.match(
      source,
      /writeGlobalSidebarDockedPrefs/,
      `${name} view should write docked sidebar visibility through the shared helper`,
    );
    assert.doesNotMatch(
      source,
      /const DEFAULT_SIDEBAR_DOCKED_VISIBILITY/,
      `${name} view should not keep a duplicate first-run sidebar default`,
    );
    assert.doesNotMatch(
      source,
      /const readSidebarDockedVisibility/,
      `${name} view should not keep a duplicate sidebar preference reader`,
    );
  }
});
