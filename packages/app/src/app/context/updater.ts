import { createSignal } from "solid-js";

import type { UpdateHandle } from "../types";
import type { UpdaterEnvironment } from "../lib/tauri";

export type UpdateStatus =
  | { state: "idle"; lastCheckedAt: number | null }
  | { state: "checking"; startedAt: number }
  | { state: "available"; lastCheckedAt: number; version: string; date?: string; notes?: string }
  | {
      state: "downloading";
      lastCheckedAt: number;
      version: string;
      totalBytes: number | null;
      downloadedBytes: number;
      notes?: string;
    }
  | { state: "ready"; lastCheckedAt: number; version: string; notes?: string }
  | { state: "error"; lastCheckedAt: number | null; message: string };

export type PendingUpdate = { update: UpdateHandle; version: string; notes?: string } | null;

export const UPDATE_AUTO_CHECK_EVERY_MS = 60 * 60_000;
export const DEFAULT_UPDATE_AUTO_DOWNLOAD = true;
export const UPDATE_AUTO_DOWNLOAD_RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
] as const;
export const UPDATE_AUTO_DOWNLOAD_MAX_RETRIES = UPDATE_AUTO_DOWNLOAD_RETRY_DELAYS_MS.length;

export type UpdateDownloadRetryInfo =
  | { kind: "active"; retryAttempt: number; maxRetries: number }
  | { kind: "scheduled"; retryAttempt: number; maxRetries: number; nextRetryAt: number; message?: string }
  | { kind: "exhausted"; retryAttempt: number; maxRetries: number; message?: string };

export function resolveNextUpdateDownloadRetry(input: { completedRetries: number; now?: number }) {
  const retryCount = Number.isFinite(input.completedRetries) ? input.completedRetries : 0;
  const completedRetries = Math.max(0, Math.floor(retryCount));
  if (completedRetries >= UPDATE_AUTO_DOWNLOAD_MAX_RETRIES) {
    return {
      kind: "exhausted" as const,
      retryAttempt: UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
      maxRetries: UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
    };
  }

  const retryAttempt = completedRetries + 1;
  const delay = UPDATE_AUTO_DOWNLOAD_RETRY_DELAYS_MS[completedRetries] ?? 0;
  return {
    kind: "scheduled" as const,
    retryAttempt,
    maxRetries: UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
    nextRetryAt: (input.now ?? Date.now()) + delay,
  };
}

export function resolveUpdateAutoDownloadPreference(stored: string | null) {
  if (stored === "0") return false;
  if (stored === "1") return true;
  return DEFAULT_UPDATE_AUTO_DOWNLOAD;
}

export function resolveUpdateStartupPreferences(input: {
  storedAutoCheck: string | null;
  storedAutoDownload: string | null;
}) {
  const autoDownload = resolveUpdateAutoDownloadPreference(input.storedAutoDownload);
  const autoCheck = autoDownload || input.storedAutoCheck !== "0";
  return { autoCheck, autoDownload };
}

export function getUpdateLastCheckedAt(state: UpdateStatus) {
  if (state.state === "checking") return null;
  return state.lastCheckedAt ?? null;
}

export function shouldAutoCheckForUpdatesAt(state: UpdateStatus, now = Date.now()) {
  const lastCheckedAt = getUpdateLastCheckedAt(state);
  if (!lastCheckedAt) return true;
  return now - lastCheckedAt >= UPDATE_AUTO_CHECK_EVERY_MS;
}

export function createUpdaterState() {
  const [updateAutoCheck, setUpdateAutoCheck] = createSignal(true);
  const [updateAutoDownload, setUpdateAutoDownload] = createSignal(DEFAULT_UPDATE_AUTO_DOWNLOAD);
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>({ state: "idle", lastCheckedAt: null });
  const [pendingUpdate, setPendingUpdate] = createSignal<PendingUpdate>(null);
  const [updateEnv, setUpdateEnv] = createSignal<UpdaterEnvironment | null>(null);

  return {
    updateAutoCheck,
    setUpdateAutoCheck,
    updateAutoDownload,
    setUpdateAutoDownload,
    updateStatus,
    setUpdateStatus,
    pendingUpdate,
    setPendingUpdate,
    updateEnv,
    setUpdateEnv,
  } as const;
}
