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
      retry?: Extract<UpdateDownloadRetryInfo, { kind: "active" | "scheduled" }>;
    }
  | { state: "ready"; lastCheckedAt: number; version: string; notes?: string }
  | {
      state: "installing";
      lastCheckedAt: number | null;
      version: string;
      startedAt: number;
      currentVersion?: string;
      notes?: string;
    }
  | {
      state: "error";
      lastCheckedAt: number | null;
      message: string;
      version?: string;
      retry?: Extract<UpdateDownloadRetryInfo, { kind: "exhausted" }>;
    };

export type PendingUpdate = { update: UpdateHandle; version: string; notes?: string } | null;

export const UPDATE_AUTO_CHECK_EVERY_MS = 60 * 60_000;
export const DEFAULT_UPDATE_AUTO_DOWNLOAD = false;
export const UPDATE_AUTO_DOWNLOAD_DEFAULT_OFF_MIGRATION_KEY =
  "veslo.updateAutoDownloadDefaultOff.v1";
export const UPDATE_INSTALL_STATE_KEY = "veslo.updateInstallState.v1";
export const UPDATE_INSTALL_STALE_AFTER_MS = 2 * 60 * 60_000;
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

export type UpdateInstallPlatform = "windows" | "macos" | "linux" | "unknown";

export type UpdateInstallState = {
  schemaVersion: 1;
  targetVersion: string;
  currentVersion?: string;
  startedAt: number;
  platform: UpdateInstallPlatform;
};

export type UpdateInstallStartupStatus =
  | { action: "ignore" }
  | { action: "clear" }
  | { action: "recover"; status: Extract<UpdateStatus, { state: "installing" }> }
  | { action: "stale"; status: Extract<UpdateStatus, { state: "error" }> };

function normalizeUpdateVersion(version: string | null | undefined) {
  return (version ?? "").trim().replace(/^v/i, "");
}

export function createUpdateInstallState(input: {
  targetVersion: string;
  currentVersion?: string;
  startedAt?: number;
  platform: UpdateInstallPlatform;
}): UpdateInstallState {
  return {
    schemaVersion: 1,
    targetVersion: input.targetVersion,
    currentVersion: input.currentVersion,
    startedAt: input.startedAt ?? Date.now(),
    platform: input.platform,
  };
}

export function parseUpdateInstallState(raw: string | null): UpdateInstallState | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<UpdateInstallState>;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.targetVersion !== "string" || !parsed.targetVersion.trim()) return null;
    if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt) || parsed.startedAt <= 0) {
      return null;
    }
    if (
      parsed.platform !== "windows" &&
      parsed.platform !== "macos" &&
      parsed.platform !== "linux" &&
      parsed.platform !== "unknown"
    ) {
      return null;
    }

    return {
      schemaVersion: 1,
      targetVersion: parsed.targetVersion,
      currentVersion: typeof parsed.currentVersion === "string" ? parsed.currentVersion : undefined,
      startedAt: parsed.startedAt,
      platform: parsed.platform,
    };
  } catch {
    return null;
  }
}

export function resolveUpdateInstallStartupStatus(input: {
  storedState: UpdateInstallState | null;
  currentVersion: string | null;
  now?: number;
}): UpdateInstallStartupStatus {
  const stored = input.storedState;
  if (!stored) return { action: "ignore" };

  const targetVersion = normalizeUpdateVersion(stored.targetVersion);
  const currentVersion = normalizeUpdateVersion(input.currentVersion);
  if (targetVersion && currentVersion && targetVersion === currentVersion) {
    return { action: "clear" };
  }

  const now = input.now ?? Date.now();
  if (now - stored.startedAt > UPDATE_INSTALL_STALE_AFTER_MS) {
    return {
      action: "stale",
      status: {
        state: "error",
        lastCheckedAt: null,
        version: stored.targetVersion,
        message:
          "The previous update install did not finish. Restart Windows if an installer is still running, then retry the update.",
      },
    };
  }

  return {
    action: "recover",
    status: {
      state: "installing",
      lastCheckedAt: null,
      version: stored.targetVersion,
      startedAt: stored.startedAt,
      currentVersion: stored.currentVersion,
    },
  };
}

export function shouldRelaunchAfterUpdateInstall(platform: UpdateInstallPlatform) {
  return platform !== "windows";
}

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

export function resolveAutoDownloadFailureStatus(input: {
  lastCheckedAt: number;
  version: string;
  notes?: string;
  completedRetries: number;
  now?: number;
  message: string;
}): UpdateStatus {
  const retry = resolveNextUpdateDownloadRetry({
    completedRetries: input.completedRetries,
    now: input.now,
  });

  if (retry.kind === "scheduled") {
    return {
      state: "downloading",
      lastCheckedAt: input.lastCheckedAt,
      version: input.version,
      totalBytes: null,
      downloadedBytes: 0,
      notes: input.notes,
      retry: { ...retry, message: input.message },
    };
  }

  return {
    state: "error",
    lastCheckedAt: input.lastCheckedAt,
    message: input.message,
    version: input.version,
    retry: { ...retry, message: input.message },
  };
}

export function resolveAutoDownloadOptOutStatus(input: {
  lastCheckedAt: number;
  version: string;
  notes?: string;
}): UpdateStatus {
  return {
    state: "available",
    lastCheckedAt: input.lastCheckedAt,
    version: input.version,
    notes: input.notes,
  };
}

export function resolveUpdateAutoDownloadPreference(stored: string | null) {
  if (stored === "0") return false;
  if (stored === "1") return true;
  return DEFAULT_UPDATE_AUTO_DOWNLOAD;
}

export function resolveUpdateAutoDownloadDefaultOffMigration(input: {
  storedAutoDownload: string | null;
  migrationComplete: boolean;
}) {
  if (input.migrationComplete) {
    return {
      storedAutoDownload: input.storedAutoDownload,
      writeAutoDownload: false,
      writeMigration: false,
    };
  }

  if (input.storedAutoDownload === "0") {
    return {
      storedAutoDownload: input.storedAutoDownload,
      writeAutoDownload: false,
      writeMigration: true,
    };
  }

  return {
    storedAutoDownload: "0",
    writeAutoDownload: input.storedAutoDownload !== "0",
    writeMigration: true,
  };
}

export function resolveUpdateStartupPreferences(input: {
  storedAutoCheck: string | null;
  storedAutoDownload: string | null;
}) {
  const autoDownload = resolveUpdateAutoDownloadPreference(input.storedAutoDownload);
  return { autoCheck: true, autoDownload };
}

export function getUpdateLastCheckedAt(state: UpdateStatus) {
  if (state.state === "checking") return null;
  if (state.state === "installing") return null;
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
