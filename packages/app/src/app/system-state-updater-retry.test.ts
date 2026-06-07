import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createEffect, createRoot } from "solid-js";

import { createSystemState } from "./system-state.js";
import type { UpdateHandle } from "./types.js";

const source = readFileSync(new URL("./system-state.ts", import.meta.url), "utf8");

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const createSystemStateForTest = () =>
  createSystemState({
    client: () => null,
    sessions: () => [],
    sessionStatusById: () => ({}),
    refreshPlugins: async () => undefined,
    refreshSkills: async () => undefined,
    setProviders: () => undefined,
    setProviderDefaults: () => undefined,
    setProviderConnectedIds: () => undefined,
    setError: () => undefined,
  });

const createPendingUpdateForTest = (): UpdateHandle => ({
  available: true,
  currentVersion: "2026.6.0",
  version: "2026.6.1",
  rawJson: {},
  close: async () => undefined,
  download: async () => undefined,
  install: async () => undefined,
  downloadAndInstall: async () => undefined,
});

test("system state schedules automatic updater download retries", () => {
  assert.match(source, /resolveAutoDownloadFailureStatus/);
  assert.match(source, /type\s+DownloadUpdateOptions/);
  assert.match(source, /automatic\?:\s*boolean/);
  assert.match(source, /retryAttempt\?:\s*number/);
  assert.match(source, /refreshBeforeDownload\?:\s*boolean/);
});

test("scheduled updater retries refresh the update handle before downloading", () => {
  assert.match(source, /async function refreshPendingUpdateForDownload/);
  assert.match(source, /requireUpdate\?:\s*boolean/);
  assert.match(source, /await check\(\{ timeout: 8_000 \}\)/);
  assert.match(source, /throw new Error\("Update is no longer available\."\)/);
  assert.match(source, /refreshBeforeDownload[\s\S]*refreshPendingUpdateForDownload/);
});

test("manual updater downloads do not enter the automatic retry loop", () => {
  assert.match(source, /if \(optionsDownload\?\.automatic && updateAutoDownload\(\)\)/);
  assert.match(source, /resolveAutoDownloadFailureStatus\(\{/);
  assert.match(source, /else[\s\S]*setUpdateStatus\(\{ state: "error"/);
});

test("automatic retry stops when auto-download is disabled", () => {
  assert.match(source, /resolveAutoDownloadOptOutStatus/);
  assert.match(source, /if \(optionsDownload\?\.automatic && updateAutoDownload\(\)\)/);
  assert.match(source, /if \(optionsDownload\?\.automatic\)[\s\S]*resolveAutoDownloadOptOutStatus\(\{/);
});

test("disabling auto-download restores scheduled retry to manual availability", () => {
  assert.match(source, /function restoreAutoDownloadToManualAvailability\(\)/);
  assert.match(source, /if \(state\.state !== "downloading"\) return;/);
  assert.match(source, /setUpdateAutoDownloadSignal/);
  assert.match(source, /restoreAutoDownloadToManualAvailability\(\)/);
  assert.match(source, /const next = setUpdateAutoDownloadSignal\(value\);[\s\S]*if \(!next\) \{[\s\S]*restoreAutoDownloadToManualAvailability\(\)/);
  assert.doesNotMatch(source, /setUpdateAutoDownloadSignal\(\(current\) => \{[\s\S]*restoreScheduledUpdateRetryForManualDownload\(\)/);
});

test("disabling auto-download during scheduled retry does not trigger automatic download", async () => {
  await createRoot(async (dispose) => {
    try {
      const systemState = createSystemStateForTest();
      let automaticDownloads = 0;

      systemState.setPendingUpdate({
        update: createPendingUpdateForTest(),
        version: "2026.6.1",
        notes: "Release notes",
      });
      systemState.setUpdateStatus({
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
          nextRetryAt: Date.now() + 30_000,
        },
      });

      createEffect(() => {
        if (!systemState.updateAutoDownload()) return;
        const state = systemState.updateStatus();
        if (state.state !== "available") return;
        if (!systemState.pendingUpdate()) return;
        automaticDownloads += 1;
      });

      await tick();
      assert.equal(automaticDownloads, 0);

      systemState.setUpdateAutoDownload(false);
      await tick();

      assert.equal(systemState.updateAutoDownload(), false);
      assert.equal(systemState.updateStatus().state, "available");
      assert.equal(automaticDownloads, 0);
    } finally {
      dispose();
    }
  });
});

test("disabling auto-download during active automatic download pauses to manual availability", async () => {
  await createRoot(async (dispose) => {
    try {
      const systemState = createSystemStateForTest();

      systemState.setPendingUpdate({
        update: createPendingUpdateForTest(),
        version: "2026.6.1",
        notes: "Release notes",
      });
      systemState.setUpdateStatus({
        state: "downloading",
        lastCheckedAt: 100,
        version: "2026.6.1",
        totalBytes: 100,
        downloadedBytes: 35,
        notes: "Release notes",
      });

      systemState.setUpdateAutoDownload(false);
      await tick();

      assert.equal(systemState.updateAutoDownload(), false);
      assert.deepEqual(systemState.updateStatus(), {
        state: "available",
        lastCheckedAt: 100,
        version: "2026.6.1",
        notes: "Release notes",
      });
    } finally {
      dispose();
    }
  });
});

test("late automatic download completion after pause does not mark update ready", async () => {
  await createRoot(async (dispose) => {
    try {
      let finishDownload!: () => void;
      const systemState = createSystemStateForTest();

      systemState.setPendingUpdate({
        update: {
          ...createPendingUpdateForTest(),
          download: async (onEvent) => {
            onEvent?.({ event: "Started", data: { contentLength: 100 } });
            await new Promise<void>((resolve) => {
              finishDownload = resolve;
            });
            onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
          },
        },
        version: "2026.6.1",
        notes: "Release notes",
      });
      systemState.setUpdateStatus({
        state: "available",
        lastCheckedAt: 100,
        version: "2026.6.1",
        notes: "Release notes",
      });

      const downloadPromise = (systemState.downloadUpdate as (options?: { automatic?: boolean }) => Promise<void>)({
        automatic: true,
      });
      await tick();

      assert.equal(systemState.updateStatus().state, "downloading");

      systemState.setUpdateAutoDownload(false);
      await tick();

      assert.equal(systemState.updateStatus().state, "available");
      finishDownload();
      await downloadPromise;

      assert.equal(systemState.updateAutoDownload(), false);
      assert.deepEqual(systemState.updateStatus(), {
        state: "available",
        lastCheckedAt: 100,
        version: "2026.6.1",
        notes: "Release notes",
      });
    } finally {
      dispose();
    }
  });
});

test("stale updater progress does not mutate scheduled retry state", () => {
  assert.match(
    source,
    /if \(current\.state === "downloading" && current\.retry\?\.kind === "scheduled"\) return current;[\s\S]*if \(current\.state !== "downloading"\) return current;[\s\S]*downloadedBytes: accumulatedBytes/,
  );
});

test("system state exposes a manual retry entry point", () => {
  assert.match(source, /async function retryUpdateDownload\(\)/);
  assert.match(source, /downloadUpdate\(\{[\s\S]*refreshBeforeDownload: true[\s\S]*\}\)/);
  assert.match(source, /retryUpdateDownload,/);
});
