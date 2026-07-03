import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createRoot } from "solid-js";

import {
  DEFAULT_UPDATE_AUTO_DOWNLOAD,
  UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
  UPDATE_AUTO_DOWNLOAD_RETRY_DELAYS_MS,
  UPDATE_AUTO_CHECK_EVERY_MS,
  createUpdaterState,
  createUpdateInstallState,
  parseUpdateInstallState,
  resolveAutoDownloadFailureStatus,
  resolveAutoDownloadOptOutStatus,
  resolveNextUpdateDownloadRetry,
  resolveUpdateInstallStartupStatus,
  resolveUpdateAutoDownloadDefaultOffMigration,
  resolveUpdateAutoDownloadPreference,
  resolveUpdatePostInstallRestartAction,
  resolveUpdateStartupPreferences,
  isUpdaterEnabled,
  shouldRelaunchAfterUpdateInstall,
  shouldAutoCheckForUpdatesAt,
} from "../../context/updater.js";

const systemStateSource = () =>
  readFileSync(new URL("../../system-state.ts", import.meta.url), "utf8");

test("auto-download defaults to disabled", () => {
  assert.equal(DEFAULT_UPDATE_AUTO_DOWNLOAD, false);

  createRoot((dispose) => {
    const updater = createUpdaterState();
    assert.equal(updater.updateAutoDownload(), false);
    dispose();
  });
});

test("updater can be disabled for staging builds", () => {
  assert.equal(isUpdaterEnabled(), true);
  assert.equal(isUpdaterEnabled({ VITE_VESLO_UPDATER_ENABLED: "false" }), false);
  assert.equal(isUpdaterEnabled({ VITE_VESLO_UPDATER_ENABLED: "0" }), true);
  assert.match(systemStateSource(), /if \(!isUpdaterEnabled\(\)\) return;/);
});

test("Windows update install state is persisted with target version and start time", () => {
  assert.deepEqual(
    createUpdateInstallState({
      targetVersion: "2026.6.5",
      currentVersion: "2026.6.4",
      startedAt: 1_800_000_000_000,
      platform: "windows",
    }),
    {
      schemaVersion: 1,
      targetVersion: "2026.6.5",
      currentVersion: "2026.6.4",
      startedAt: 1_800_000_000_000,
      platform: "windows",
    },
  );
});

test("startup clears completed update install state after target version launches", () => {
  const state = createUpdateInstallState({
    targetVersion: "2026.6.5",
    currentVersion: "2026.6.4",
    startedAt: 1_800_000_000_000,
    platform: "windows",
  });

  assert.deepEqual(
    resolveUpdateInstallStartupStatus({
      storedState: state,
      currentVersion: "2026.6.5",
      now: 1_800_000_030_000,
    }),
    { action: "clear" },
  );
});

test("startup keeps recent Windows updater handoff in installing state instead of re-offering update", () => {
  const state = createUpdateInstallState({
    targetVersion: "2026.6.5",
    currentVersion: "2026.6.4",
    startedAt: 1_800_000_000_000,
    platform: "windows",
  });

  assert.deepEqual(
    resolveUpdateInstallStartupStatus({
      storedState: state,
      currentVersion: "2026.6.4",
      now: 1_800_000_030_000,
    }),
    {
      action: "recover",
      status: {
        state: "installing",
        lastCheckedAt: null,
        version: "2026.6.5",
        startedAt: 1_800_000_000_000,
        currentVersion: "2026.6.4",
      },
    },
  );
});

test("stale Windows updater handoff becomes a retryable install error", () => {
  const state = createUpdateInstallState({
    targetVersion: "2026.6.5",
    currentVersion: "2026.6.4",
    startedAt: 1_800_000_000_000,
    platform: "windows",
  });

  assert.deepEqual(
    resolveUpdateInstallStartupStatus({
      storedState: state,
      currentVersion: "2026.6.4",
      now: 1_800_000_000_000 + 2 * 60 * 60_000 + 1,
    }),
    {
      action: "stale",
      status: {
        state: "error",
        lastCheckedAt: null,
        version: "2026.6.5",
        message:
          "The previous update install did not finish. Restart Windows if an installer is still running, then retry the update.",
      },
    },
  );
});

test("invalid persisted update install state is ignored", () => {
  assert.equal(parseUpdateInstallState(null), null);
  assert.equal(parseUpdateInstallState("not json"), null);
  assert.equal(parseUpdateInstallState(JSON.stringify({ targetVersion: "2026.6.5" })), null);
});

test("Windows MSI updater handoff does not use the frontend relaunch path", () => {
  assert.equal(shouldRelaunchAfterUpdateInstall("windows"), false);
  assert.equal(shouldRelaunchAfterUpdateInstall("macos"), true);
  assert.equal(shouldRelaunchAfterUpdateInstall("linux"), true);
});

test("post-install restart action avoids single-instance relaunch races on macOS", () => {
  assert.equal(resolveUpdatePostInstallRestartAction("windows"), "installer-handoff");
  assert.equal(resolveUpdatePostInstallRestartAction("macos"), "native-post-exit-relaunch");
  assert.equal(resolveUpdatePostInstallRestartAction("linux"), "frontend-relaunch");
  assert.equal(resolveUpdatePostInstallRestartAction("unknown"), "frontend-relaunch");
});

test("stored auto-download preference overrides the default", () => {
  assert.equal(resolveUpdateAutoDownloadPreference(null), false);
  assert.equal(resolveUpdateAutoDownloadPreference(""), false);
  assert.equal(resolveUpdateAutoDownloadPreference("1"), true);
  assert.equal(resolveUpdateAutoDownloadPreference("0"), false);
  assert.equal(resolveUpdateAutoDownloadPreference("unexpected"), false);
});

test("startup update preferences default to auto-check enabled and auto-download disabled", () => {
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: null,
      storedAutoDownload: null,
    }),
    { autoCheck: true, autoDownload: false },
  );
});

test("startup update preferences keep automatic checks enabled when auto-download is opted out", () => {
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: "0",
      storedAutoDownload: "0",
    }),
    { autoCheck: true, autoDownload: false },
  );
});

test("startup update preferences keep quiet checks enabled for manual and automatic downloads", () => {
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: "0",
      storedAutoDownload: null,
    }),
    { autoCheck: true, autoDownload: false },
  );
  assert.deepEqual(
    resolveUpdateStartupPreferences({
      storedAutoCheck: "0",
      storedAutoDownload: "1",
    }),
    { autoCheck: true, autoDownload: true },
  );
});

test("legacy auto-download default is migrated to manual download once", () => {
  assert.deepEqual(
    resolveUpdateAutoDownloadDefaultOffMigration({
      storedAutoDownload: "1",
      migrationComplete: false,
    }),
    {
      storedAutoDownload: "0",
      writeAutoDownload: true,
      writeMigration: true,
    },
  );

  assert.deepEqual(
    resolveUpdateAutoDownloadDefaultOffMigration({
      storedAutoDownload: null,
      migrationComplete: false,
    }),
    {
      storedAutoDownload: "0",
      writeAutoDownload: true,
      writeMigration: true,
    },
  );
});

test("auto-download migration preserves later explicit choices", () => {
  assert.deepEqual(
    resolveUpdateAutoDownloadDefaultOffMigration({
      storedAutoDownload: "1",
      migrationComplete: true,
    }),
    {
      storedAutoDownload: "1",
      writeAutoDownload: false,
      writeMigration: false,
    },
  );

  assert.deepEqual(
    resolveUpdateAutoDownloadDefaultOffMigration({
      storedAutoDownload: "0",
      migrationComplete: false,
    }),
    {
      storedAutoDownload: "0",
      writeAutoDownload: false,
      writeMigration: true,
    },
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

test("auto-download retry policy uses three bounded backoff attempts", () => {
  assert.deepEqual(UPDATE_AUTO_DOWNLOAD_RETRY_DELAYS_MS, [
    30_000,
    2 * 60_000,
    10 * 60_000,
  ]);
  assert.equal(UPDATE_AUTO_DOWNLOAD_MAX_RETRIES, 3);
});

test("auto-download retry policy schedules the next clean retry", () => {
  const now = 1_800_000_000_000;

  assert.deepEqual(resolveNextUpdateDownloadRetry({ completedRetries: 0, now }), {
    kind: "scheduled",
    retryAttempt: 1,
    maxRetries: 3,
    nextRetryAt: now + 30_000,
  });

  assert.deepEqual(resolveNextUpdateDownloadRetry({ completedRetries: 1, now }), {
    kind: "scheduled",
    retryAttempt: 2,
    maxRetries: 3,
    nextRetryAt: now + 2 * 60_000,
  });

  assert.deepEqual(resolveNextUpdateDownloadRetry({ completedRetries: 2, now }), {
    kind: "scheduled",
    retryAttempt: 3,
    maxRetries: 3,
    nextRetryAt: now + 10 * 60_000,
  });
});

test("auto-download retry policy treats non-finite completed retries as zero", () => {
  const now = 1_800_000_000_000;

  for (const completedRetries of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(resolveNextUpdateDownloadRetry({ completedRetries, now }), {
      kind: "scheduled",
      retryAttempt: 1,
      maxRetries: 3,
      nextRetryAt: now + 30_000,
    });
  }
});

test("auto-download retry policy exhausts after the third retry fails", () => {
  assert.deepEqual(resolveNextUpdateDownloadRetry({ completedRetries: 3, now: 1000 }), {
    kind: "exhausted",
    retryAttempt: 3,
    maxRetries: 3,
  });
});

test("auto-download failure schedules a retry while attempts remain", () => {
  const status = resolveAutoDownloadFailureStatus({
    lastCheckedAt: 100,
    version: "2026.6.1",
    notes: "Release notes",
    completedRetries: 0,
    now: 1_000,
    message: "network error",
  });

  assert.deepEqual(status, {
    state: "downloading",
    lastCheckedAt: 100,
    version: "2026.6.1",
    totalBytes: null,
    downloadedBytes: 0,
    notes: "Release notes",
    retry: {
      kind: "scheduled",
      retryAttempt: 1,
      maxRetries: 3,
      nextRetryAt: 31_000,
      message: "network error",
    },
  });
});

test("auto-download failure becomes visible error after retries are exhausted", () => {
  const status = resolveAutoDownloadFailureStatus({
    lastCheckedAt: 100,
    version: "2026.6.1",
    completedRetries: 3,
    now: 1_000,
    message: "signature mismatch",
  });

  assert.deepEqual(status, {
    state: "error",
    lastCheckedAt: 100,
    message: "signature mismatch",
    version: "2026.6.1",
    retry: {
      kind: "exhausted",
      retryAttempt: 3,
      maxRetries: 3,
      message: "signature mismatch",
    },
  });
});

test("auto-download opt-out restores a manual available update state", () => {
  const status = resolveAutoDownloadOptOutStatus({
    lastCheckedAt: 100,
    version: "2026.6.1",
    notes: "Release notes",
  });

  assert.deepEqual(status, {
    state: "available",
    lastCheckedAt: 100,
    version: "2026.6.1",
    notes: "Release notes",
  });
});
