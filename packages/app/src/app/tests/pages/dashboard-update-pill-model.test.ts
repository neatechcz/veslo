import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDashboardUpdateDownloadPercent,
  resolveDashboardUpdatePillClickAction,
  resolveDashboardUpdatePillModel,
  type DashboardUpdatePillCopy,
} from "../../pages/dashboard-update-pill-model";

const copy: DashboardUpdatePillCopy = {
  available: "Update available",
  downloadFailed: "Download failed",
  downloading: "Downloading",
  downloadUpdate: "Download update",
  installing: "Installing",
  installUpdate: "Install update",
  preparing: "Preparing update",
  ready: "Update ready",
  retryDownload: "Retry download",
  retryingDownload: "Retrying download",
  stopRunsToUpdate: "Stop runs to update",
};

test("dashboard update pill exposes manual download action only when auto-download is disabled", () => {
  const model = resolveDashboardUpdatePillModel({
    anyActiveRuns: false,
    copy,
    isDesktopRuntime: true,
    updateAutoDownload: false,
    updateStatus: { state: "available", version: "2026.7.1" },
  });

  assert.equal(model.show, true);
  assert.equal(model.label, "Update available");
  assert.equal(model.actionLabel, "Download update");
  assert.equal(model.actionTitle, "Download update v2026.7.1");
  assert.equal(model.clickAction, "download");

  assert.equal(resolveDashboardUpdatePillClickAction({
    anyActiveRuns: false,
    updateAutoDownload: true,
    updateStatus: { state: "available", version: "2026.7.1" },
  }), "none");
});

test("dashboard update pill blocks install while runs are active and points to settings", () => {
  const model = resolveDashboardUpdatePillModel({
    anyActiveRuns: true,
    copy,
    isDesktopRuntime: true,
    updateAutoDownload: true,
    updateStatus: { state: "ready", version: "2026.7.1" },
  });

  assert.equal(model.actionDisabled, true);
  assert.equal(model.actionLabel, "Install update");
  assert.equal(model.actionTitle, "Stop runs to update");
  assert.equal(model.clickAction, "open-settings");
  assert.match(model.buttonTone, /amber/);
  assert.equal(model.title, "Update ready v2026.7.1. Stop runs to update.");
});

test("dashboard update pill reports retry and progress states", () => {
  assert.equal(resolveDashboardUpdateDownloadPercent({
    state: "downloading",
    downloadedBytes: 50,
    totalBytes: 200,
  }), 25);

  const retrying = resolveDashboardUpdatePillModel({
    anyActiveRuns: false,
    copy,
    isDesktopRuntime: true,
    updateAutoDownload: true,
    updateStatus: {
      state: "downloading",
      downloadedBytes: 50,
      totalBytes: 200,
      retry: { kind: "scheduled" },
      version: "2026.7.1",
    },
  });
  assert.equal(retrying.label, "Retrying download");
  assert.equal(retrying.clickAction, "open-settings");

  const exhausted = resolveDashboardUpdatePillModel({
    anyActiveRuns: false,
    copy,
    isDesktopRuntime: true,
    updateAutoDownload: true,
    updateStatus: {
      state: "error",
      retry: { kind: "exhausted" },
      version: "2026.7.1",
    },
  });
  assert.equal(exhausted.show, true);
  assert.equal(exhausted.actionLabel, "Retry download");
  assert.equal(exhausted.clickAction, "retry");
});

test("dashboard update pill remains hidden outside desktop runtime", () => {
  const model = resolveDashboardUpdatePillModel({
    anyActiveRuns: false,
    copy,
    isDesktopRuntime: false,
    updateAutoDownload: false,
    updateStatus: { state: "available", version: "2026.7.1" },
  });

  assert.equal(model.show, false);
});
