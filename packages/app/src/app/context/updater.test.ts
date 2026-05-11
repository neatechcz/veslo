import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import {
  DEFAULT_UPDATE_AUTO_DOWNLOAD,
  UPDATE_AUTO_CHECK_EVERY_MS,
  createUpdaterState,
  resolveUpdateAutoDownloadPreference,
  resolveUpdateStartupPreferences,
  shouldAutoCheckForUpdatesAt,
} from "./updater.js";

test("auto-download defaults to enabled", () => {
  assert.equal(DEFAULT_UPDATE_AUTO_DOWNLOAD, true);

  createRoot((dispose) => {
    const updater = createUpdaterState();
    assert.equal(updater.updateAutoDownload(), true);
    dispose();
  });
});

test("stored auto-download preference overrides the default", () => {
  assert.equal(resolveUpdateAutoDownloadPreference(null), true);
  assert.equal(resolveUpdateAutoDownloadPreference(""), true);
  assert.equal(resolveUpdateAutoDownloadPreference("1"), true);
  assert.equal(resolveUpdateAutoDownloadPreference("0"), false);
  assert.equal(resolveUpdateAutoDownloadPreference("unexpected"), true);
});

test("startup update preferences default to auto-check and auto-download enabled", () => {
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: null,
      storedAutoDownload: null,
    }),
    { autoCheck: true, autoDownload: true },
  );
});

test("startup update preferences preserve explicit auto-download opt-out", () => {
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: "0",
      storedAutoDownload: "0",
    }),
    { autoCheck: false, autoDownload: false },
  );
});

test("startup update preferences let enabled auto-download imply auto-check", () => {
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: "0",
      storedAutoDownload: null,
    }),
    { autoCheck: true, autoDownload: true },
  );
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: "0",
      storedAutoDownload: "1",
    }),
    { autoCheck: true, autoDownload: true },
  );
});

test("auto update checks become due after one hour", () => {
  const now = 1_800_000_000_000;

  assert.equal(UPDATE_AUTO_CHECK_EVERY_MS, 60 * 60_000);

  assert.equal(
    shouldAutoCheckForUpdatesAt(
      { state: "idle", lastCheckedAt: now - UPDATE_AUTO_CHECK_EVERY_MS + 1 },
      now,
    ),
    false,
  );
  assert.equal(
    shouldAutoCheckForUpdatesAt(
      { state: "idle", lastCheckedAt: now - UPDATE_AUTO_CHECK_EVERY_MS },
      now,
    ),
    true,
  );
});
