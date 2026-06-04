import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";

import type { Session } from "@opencode-ai/sdk/v2/client";
import type { ProviderListItem } from "./types";

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { reportError } from "./lib/error-reporter";
import type {
  Client,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
  ResetVesloMode,
  UpdateHandle,
} from "./types";
import { currentLocale, t } from "../i18n";
import { addOpencodeCacheHint, isTauriRuntime, safeStringify } from "./utils";
import { mapConfigProvidersToList } from "./utils/providers";
import {
  UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
  createUpdaterState,
  resolveAutoDownloadFailureStatus,
} from "./context/updater";
import {
  resetVesloState,
  resetOpencodeCache,
  sandboxCleanupVesloContainers,
  updaterPrepareInstall,
} from "./lib/tauri";
import { unwrap, waitForHealthy } from "./lib/opencode";
import { currentLocale as __vesloIndirectLocale, t as __vesloIndirectT } from "../i18n";

function throttle<T extends (...args: any[]) => any>(
  fn: T,
  delayMs: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    lastArgs = args;

    if (now - lastCall >= delayMs) {
      lastCall = now;
      fn(...args);
    } else if (!timeoutId){
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        if (lastArgs) fn(...lastArgs);
      }, delayMs - (now - lastCall));
    }
  }
}

export type NotionState = {
  status: Accessor<"disconnected" | "connecting" | "connected" | "error">;
  setStatus: (value: "disconnected" | "connecting" | "connected" | "error") => void;
  statusDetail: Accessor<string | null>;
  setStatusDetail: (value: string | null) => void;
  skillInstalled: Accessor<boolean>;
  setTryPromptVisible: (value: boolean) => void;
};

type DownloadUpdateOptions = {
  automatic?: boolean;
  retryAttempt?: number;
  refreshBeforeDownload?: boolean;
};

export function createSystemState(options: {
  client: Accessor<Client | null>;
  sessions: Accessor<Session[]>;
  sessionStatusById: Accessor<Record<string, string>>;
  refreshPlugins: (scopeOverride?: PluginScope) => Promise<void>;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshMcpServers?: () => Promise<void>;
  reloadWorkspaceEngine?: () => Promise<boolean>;
  canReloadWorkspaceEngine?: () => boolean;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setError: (value: string | null) => void;
  notion?: NotionState;
}) {
  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [reloadReasons, setReloadReasons] = createSignal<ReloadReason[]>([]);
  const [reloadLastTriggeredAt, setReloadLastTriggeredAt] = createSignal<number | null>(null);
  const [reloadLastFinishedAt, setReloadLastFinishedAt] = createSignal<number | null>(null);
  const [reloadTrigger, setReloadTrigger] = createSignal<ReloadTrigger | null>(null);
  const [reloadBusy, setReloadBusy] = createSignal(false);
  const [reloadError, setReloadError] = createSignal<string | null>(null);

  const [cacheRepairBusy, setCacheRepairBusy] = createSignal(false);
  const [cacheRepairResult, setCacheRepairResult] = createSignal<string | null>(null);
  const [dockerCleanupBusy, setDockerCleanupBusy] = createSignal(false);
  const [dockerCleanupResult, setDockerCleanupResult] = createSignal<string | null>(null);

  const updater = createUpdaterState();
  const {
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
  } = updater;

  const [resetModalOpen, setResetModalOpen] = createSignal(false);
  const [resetModalMode, setResetModalMode] = createSignal<ResetVesloMode>("onboarding");
  const [resetModalText, setResetModalText] = createSignal("");
  const [resetModalBusy, setResetModalBusy] = createSignal(false);

  const resetModalTextValue = resetModalText;

  const anyActiveRuns = createMemo(() => {
    const statuses = options.sessionStatusById();
    return options.sessions().some((s) => statuses[s.id] === "running");
  });

  function clearVesloLocalStorage(mode: ResetVesloMode) {
    if (typeof window === "undefined") return;

    try {
      if (mode === "all") {
        window.localStorage.clear();
        return;
      }

      const keys = Object.keys(window.localStorage);
      for (const key of keys) {
        if (key.includes("veslo") || key.includes("openwork")) {
          window.localStorage.removeItem(key);
        }
      }
      // Legacy compatibility key
      window.localStorage.removeItem("veslo_mode_pref");
    } catch {
      // ignore
    }
  }

  function openResetModal(mode: ResetVesloMode) {
    if (anyActiveRuns()) {
      options.setError("Stop active runs before resetting.");
      return;
    }

    options.setError(null);
    setResetModalMode(mode);
    setResetModalText("");
    setResetModalOpen(true);
  }

  async function confirmReset() {
    if (resetModalBusy()) return;

    if (anyActiveRuns()) {
      options.setError("Stop active runs before resetting.");
      return;
    }

    if (resetModalTextValue().trim().toUpperCase() !== "RESET") return;

    setResetModalBusy(true);
    options.setError(null);

    try {
      if (isTauriRuntime()) {
        await resetVesloState(resetModalMode());
      }

      clearVesloLocalStorage(resetModalMode());

      if (isTauriRuntime()) {
        await relaunch();
      } else {
        window.location.reload();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      setResetModalBusy(false);
    }
  }

  function markReloadRequired(reason: ReloadReason, trigger?: ReloadTrigger) {
    setReloadRequired(true);
    setReloadLastTriggeredAt(Date.now());
    setReloadReasons((current) => (current.includes(reason) ? current : [...current, reason]));
    if (trigger) {
      setReloadTrigger(trigger);
    } else {
      setReloadTrigger({
        type:
          reason === "plugins"
            ? "plugin"
            : reason === "skills"
              ? "skill"
              : reason === "agents"
                ? "agent"
                : reason === "commands"
                  ? "command"
                  : reason,
      });
    }
  }

  function clearReloadRequired() {
    setReloadRequired(false);
    setReloadReasons([]);
    setReloadError(null);
    setReloadTrigger(null);
  }

  const reloadCopy = createMemo(() => {
    const copy = (bodyKey: string) => ({
      title: t("settings.reload_required", currentLocale()),
      body: t(bodyKey, currentLocale()),
    });
    const reasons = reloadReasons();
    if (!reasons.length) {
      return copy("reload.banner_default_description");
    }

    if (reasons.length === 1 && reasons[0] === "plugins") {
      return copy("reload.banner_plugins_description");
    }

    if (reasons.length === 1 && reasons[0] === "skills") {
      return copy("reload.banner_skills_description");
    }

    if (reasons.length === 1 && reasons[0] === "agents") {
      return copy("reload.banner_agents_description");
    }

    if (reasons.length === 1 && reasons[0] === "commands") {
      return copy("reload.banner_commands_description");
    }

    if (reasons.length === 1 && reasons[0] === "config") {
      return copy("reload.banner_config_description");
    }

    if (reasons.length === 1 && reasons[0] === "mcp") {
      return copy("reload.banner_mcp_description");
    }

    return copy("reload.banner_config_description");
  });

  const canReloadEngine = createMemo(() => {
    if (!reloadRequired()) return false;
    if (reloadBusy()) return false;
    const override = options.canReloadWorkspaceEngine?.();
    if (override === true) return true;
    if (override === false) return false;
    if (!options.client()) return false;
    return true;
  });

  // Keep this mounted so the reload banner UX remains in the app.
  createEffect(() => {
    reloadRequired();
  });

  async function reloadEngineInstance() {
    const initialClient = options.client();
    if (!initialClient) return false;

    const override = options.canReloadWorkspaceEngine?.();
    if (override === false) {
      setReloadError(__vesloIndirectT("ui.indirect.reload_is_unavailable_for_this_worker_18yjgo", __vesloIndirectLocale()));
      return false;
    }

    // if (anyActiveRuns()) {
    //   setReloadError("Waiting for active tasks to complete before reloading.");
    //   return;
    // }

    setReloadBusy(true);
    setReloadError(null);

    try {
      if (options.reloadWorkspaceEngine) {
        const ok = await options.reloadWorkspaceEngine();
        if (ok === false) {
          setReloadError(__vesloIndirectT("ui.indirect.failed_to_reload_the_engine_wglujt", __vesloIndirectLocale()));
          return false;
        }
      } else {
        unwrap(await initialClient.instance.dispose());
      }

      const nextClient = options.client();
      if (!nextClient) {
        throw new Error("OpenCode client unavailable after reload.");
      }

      await waitForHealthy(nextClient, { timeoutMs: 12_000 });

      try {
        const providerList = unwrap(await nextClient.provider.list());
        options.setProviders(providerList.all);
        options.setProviderDefaults(providerList.default);
        options.setProviderConnectedIds(providerList.connected);
      } catch {
        try {
          const cfg = unwrap(await nextClient.config.providers());
          options.setProviders(mapConfigProvidersToList(cfg.providers));
          options.setProviderDefaults(cfg.default);
          options.setProviderConnectedIds([]);
        } catch {
          options.setProviders([]);
          options.setProviderDefaults({});
          options.setProviderConnectedIds([]);
        }
      }

      await options.refreshPlugins("project").catch(e => reportError(e, "reload.refreshPlugins"));
      await options.refreshSkills({ force: true }).catch(e => reportError(e, "reload.refreshSkills"));
      await options.refreshMcpServers?.().catch(e => reportError(e, "reload.refreshMcpServers"));

      if (options.notion) {
        let nextStatus = options.notion.status();
        if (nextStatus === "connecting") {
          nextStatus = "connected";
          options.notion.setStatus(nextStatus);
          options.notion.setStatusDetail("Worker connected");
        }

        if (nextStatus === "connected") {
          const detail = options.notion.statusDetail();
          if (!detail || detail.toLowerCase().includes("reload")) {
            options.notion.setStatusDetail("Worker connected");
          }
        }

        try {
          window.localStorage.setItem("veslo.notionStatus", nextStatus);
          if (nextStatus === "connected") {
            const detail = options.notion.statusDetail();
            if (detail) {
              window.localStorage.setItem("veslo.notionStatusDetail", detail);
            } else {
              window.localStorage.removeItem("veslo.notionStatusDetail");
            }
          }
        } catch {
          // ignore
        }
      }

      clearReloadRequired();
      if (options.notion && options.notion.status() === "connected" && options.notion.skillInstalled()) {
        options.notion.setTryPromptVisible(true);
      }
      return true;
    } catch (e) {
      setReloadError(e instanceof Error ? e.message : safeStringify(e));
      return false;
    } finally {
      setReloadBusy(false);
      setReloadLastFinishedAt(Date.now());
    }
  }

  async function reloadWorkspaceEngine() {
    return reloadEngineInstance();
  }

  async function repairOpencodeCache() {
    if (!isTauriRuntime()) {
      setCacheRepairResult("Cache repair requires the desktop app.");
      return;
    }

    if (cacheRepairBusy()) return;

    setCacheRepairBusy(true);
    setCacheRepairResult(null);
    options.setError(null);

    try {
      const result = await resetOpencodeCache();
      if (result.errors.length) {
        setCacheRepairResult(result.errors[0]);
        return;
      }

      if (result.removed.length) {
        setCacheRepairResult("OpenCode cache repaired. Restart the engine if it was running.");
      } else {
        setCacheRepairResult("No OpenCode cache found. Nothing to repair.");
      }
    } catch (e) {
      setCacheRepairResult(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setCacheRepairBusy(false);
    }
  }

  async function cleanupVesloDockerContainers() {
    if (!isTauriRuntime()) {
      setDockerCleanupResult("Docker cleanup requires the desktop app.");
      return;
    }

    if (dockerCleanupBusy()) return;

    setDockerCleanupBusy(true);
    setDockerCleanupResult(null);
    options.setError(null);

    try {
      const result = await sandboxCleanupVesloContainers();
      if (!result.candidates.length) {
        setDockerCleanupResult("No Veslo Docker containers found.");
        return;
      }

      const removedCount = result.removed.length;
      if (result.errors.length) {
        const first = result.errors[0];
        setDockerCleanupResult(
          `Removed ${removedCount}/${result.candidates.length} containers. ${first}`,
        );
        return;
      }

      setDockerCleanupResult(`Removed ${removedCount} Veslo Docker container(s).`);
    } catch (e) {
      setDockerCleanupResult(e instanceof Error ? e.message : safeStringify(e));
    } finally {
      setDockerCleanupBusy(false);
    }
  }

  async function checkForUpdates(optionsCheck?: { quiet?: boolean }) {
    if (!isTauriRuntime()) return;

    const env = updateEnv();
    if (env && !env.supported) {
      if (!optionsCheck?.quiet) {
        setUpdateStatus({
          state: "error",
          lastCheckedAt:
            updateStatus().state === "idle"
              ? (updateStatus() as { state: "idle"; lastCheckedAt: number | null }).lastCheckedAt
              : null,
          message: env.reason ?? "Updates are not supported in this environment.",
        });
      }
      return;
    }

    const prev = updateStatus();
    setUpdateStatus({ state: "checking", startedAt: Date.now() });

    try {
      const update = (await check({ timeout: 8_000 })) as unknown as UpdateHandle | null;
      const checkedAt = Date.now();

      if (!update) {
        setPendingUpdate(null);
        setUpdateStatus({ state: "idle", lastCheckedAt: checkedAt });
        return;
      }

      const notes = typeof update.body === "string" ? update.body : undefined;
      setPendingUpdate({ update, version: update.version, notes });
      setUpdateStatus({
        state: "available",
        lastCheckedAt: checkedAt,
        version: update.version,
        date: update.date,
        notes,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);

      if (optionsCheck?.quiet) {
        setUpdateStatus(prev);
        return;
      }

      setPendingUpdate(null);
      setUpdateStatus({ state: "error", lastCheckedAt: null, message });
    }
  }

  async function refreshPendingUpdateForDownload(optionsRefresh?: { requireUpdate?: boolean }) {
    const update = (await check({ timeout: 8_000 })) as unknown as UpdateHandle | null;
    const checkedAt = Date.now();
    if (!update) {
      if (optionsRefresh?.requireUpdate) {
        throw new Error("Update is no longer available.");
      }
      setPendingUpdate(null);
      setUpdateStatus({ state: "idle", lastCheckedAt: checkedAt });
      return null;
    }

    const notes = typeof update.body === "string" ? update.body : undefined;
    const pending = { update, version: update.version, notes };
    setPendingUpdate(pending);
    return { pending, checkedAt, date: update.date };
  }

  async function downloadUpdate(optionsDownload?: DownloadUpdateOptions) {
    let pending = pendingUpdate();
    const state = updateStatus();
    const scheduledRetryDownload =
      optionsDownload?.refreshBeforeDownload &&
      state.state === "downloading" &&
      state.retry?.kind === "scheduled";
    if (state.state === "downloading" && !scheduledRetryDownload) return;
    if (state.state === "ready") return;

    options.setError(null);
    let lastCheckedAt =
      state.state === "available" || state.state === "downloading"
        ? state.lastCheckedAt
        : Date.now();

    try {
      if (optionsDownload?.refreshBeforeDownload) {
        const refreshed = await refreshPendingUpdateForDownload({
          requireUpdate: Boolean(optionsDownload.automatic),
        });
        if (!refreshed) return;
        pending = refreshed.pending;
        lastCheckedAt = refreshed.checkedAt;
      }

      if (!pending) return;

      setUpdateStatus({
        state: "downloading",
        lastCheckedAt,
        version: pending.version,
        totalBytes: null,
        downloadedBytes: 0,
        notes: pending.notes,
        retry:
          optionsDownload?.automatic && (optionsDownload.retryAttempt ?? 0) > 0
            ? {
                kind: "active",
                retryAttempt: optionsDownload.retryAttempt ?? 0,
                maxRetries: UPDATE_AUTO_DOWNLOAD_MAX_RETRIES,
              }
            : undefined,
      });

      let accumulatedBytes = 0;
      let totalBytes: number | null = null;

      const throttledUpdateProgress = throttle(() => {
        setUpdateStatus((current) => {
          if (current.state !== "downloading") return current;
          return {
            ...current,
            totalBytes,
            downloadedBytes: accumulatedBytes,
          };
        });
      }, 100);

      await pending.update.download((event: any) => {
        if (!event || typeof event !== "object") return;
        const record = event as Record<string, any>;

        if (record.event === "Started") {
          const newTotal =
            record.data && typeof record.data.contentLength === "number"
              ? record.data.contentLength
              : null;
          totalBytes = newTotal;
          throttledUpdateProgress();
        }

        if (record.event === "Progress") {
          const chunk =
            record.data && typeof record.data.chunkLength === "number"
              ? record.data.chunkLength
              : 0;
          accumulatedBytes += chunk;
          throttledUpdateProgress();
        }
      });

      setUpdateStatus({
        state: "ready",
        lastCheckedAt,
        version: pending.version,
        notes: pending.notes,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      const failedPending = pending ?? pendingUpdate();
      if (!failedPending) {
        setUpdateStatus({ state: "error", lastCheckedAt, message });
        return;
      }

      if (optionsDownload?.automatic) {
        setUpdateStatus(
          resolveAutoDownloadFailureStatus({
            lastCheckedAt,
            version: failedPending.version,
            notes: failedPending.notes,
            completedRetries: optionsDownload.retryAttempt ?? 0,
            message,
          }),
        );
        return;
      } else {
        setUpdateStatus({ state: "error", lastCheckedAt, message, version: failedPending.version });
      }
    }
  }

  async function retryUpdateDownload() {
    return downloadUpdate({ refreshBeforeDownload: true });
  }

  async function installUpdateAndRestart() {
    const pending = pendingUpdate();
    if (!pending) return;

    if (anyActiveRuns()) {
      options.setError("Stop active runs before installing an update.");
      return;
    }

    options.setError(null);
    try {
      await updaterPrepareInstall();
      await pending.update.install();
      await pending.update.close();
      await relaunch();
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setUpdateStatus({ state: "error", lastCheckedAt: null, message });
    }
  }

  return {
    reloadRequired,
    reloadReasons,
    reloadLastTriggeredAt,
    reloadLastFinishedAt,
    setReloadLastFinishedAt,
    reloadTrigger,
    reloadBusy,
    reloadError,
    reloadCopy,
    canReloadEngine,
    markReloadRequired,
    clearReloadRequired,
    reloadEngineInstance,
    reloadWorkspaceEngine,
    cacheRepairBusy,
    cacheRepairResult,
    repairOpencodeCache,
    dockerCleanupBusy,
    dockerCleanupResult,
    cleanupVesloDockerContainers,
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
    checkForUpdates,
    downloadUpdate,
    retryUpdateDownload,
    installUpdateAndRestart,
    resetModalOpen,
    setResetModalOpen,
    resetModalMode,
    setResetModalMode,
    resetModalText: resetModalTextValue,
    setResetModalText,
    resetModalBusy,
    openResetModal,
    confirmReset,
    anyActiveRuns,
  };
}
