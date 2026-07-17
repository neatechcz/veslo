import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onMount } from "solid-js";

import { formatBytes, formatRelativeTime, isTauriRuntime, isWindowsPlatform } from "../utils";

import Button from "../components/button";
import DashboardTabRail, { type DashboardTabRailDashboardTab } from "../components/dashboard-tab-rail";
import { CircleAlert, Copy, Download, FolderOpen, Loader2, PlugZap, RefreshCcw, Smartphone, X } from "lucide-solid";
import type { OpencodeConnectStatus, SessionArchiveItem, SettingsTab, StartupPreference } from "../types";
import type {
  VesloServerCapabilities,
  VesloServerDiagnostics,
  VesloServerSettings,
  VesloServerStatus,
} from "../lib/veslo-server";
import type {
  EngineInfo,
  OrchestratorBinaryInfo,
  OrchestratorStatus,
  VesloServerInfo,
  AppBuildInfo,
  OpenCodeRouterInfo,
  WorkspaceInfo,
  DesktopRuntimePreferences,
} from "../lib/tauri";
import {
  appBuildInfo,
  desktopRuntimePreferencesRead,
  desktopRuntimePreferencesWrite,
  engineRestart,
  opencodeRouterRestart,
  opencodeRouterStop,
  vesloServerRestart,
  pickFile,
} from "../lib/tauri";

import {
  getDefaultDenApiBase,
  getDenApiBase,
  readDenApiBaseOverride,
  writeDenApiBaseOverride,
} from "../lib/den-auth";
import { resolveVisibleSettingsTab } from "../lib/settings-tab-label";
import { resolveEffectiveRuntimeSandboxState } from "../lib/runtime-sandbox-state";
import { currentLocale, LANGUAGE_OPTIONS, t, type Language } from "../../i18n";
import { CLOUD_ONLY_MODE } from "../lib/cloud-policy";
import {
  documentRuntimeSettingsRow,
  redactDocumentRuntimeStatus,
  type DocumentRuntimeStatusPayload,
} from "../lib/document-runtime";
import { sanitizeBootstrapDiagnosticPayload } from "../lib/bootstrap-diagnostics";
import { MODEL_VARIANT_OPTIONS } from "../lib/model-variant";
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../i18n";
import type { UpdateDownloadRetryInfo } from "../context/updater";

function formatUpdateRetryDelay(delayMs: number) {
  const clampedMs = Math.max(0, delayMs);
  if (clampedMs < 60_000) return `${Math.max(1, Math.ceil(clampedMs / 1000))}s`;
  if (clampedMs < 60 * 60_000) return `${Math.max(1, Math.ceil(clampedMs / 60_000))}m`;
  return `${Math.max(1, Math.ceil(clampedMs / (60 * 60_000)))}h`;
}

const SUPPORT_DIAGNOSTICS_STORAGE_KEY = "veslo.supportDiagnostics";

export type SettingsViewProps = {
  startupPreference: StartupPreference | null;
  baseUrl: string;
  headerStatus: string;
  busy: boolean;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  onOpenDashboardTab?: (tab: DashboardTabRailDashboardTab) => void;
  vesloServerStatus: VesloServerStatus;
  vesloServerUrl: string;
  vesloReconnectBusy: boolean;
  reconnectVesloServer: () => Promise<boolean>;
  vesloServerHostInfo: VesloServerInfo | null;
  vesloServerCapabilities: VesloServerCapabilities | null;
  vesloServerDiagnostics: VesloServerDiagnostics | null;
  vesloServerWorkspaceId: string | null;
  activeWorkspaceRoot: string;
  opencodeConnectStatus: OpencodeConnectStatus | null;
  engineInfo: EngineInfo | null;
  orchestratorStatus: OrchestratorStatus | null;
  opencodeRouterInfo: OpenCodeRouterInfo | null;
  developerMode: boolean;
  stopHost: () => void;
  restartLocalServer: () => Promise<boolean>;
  engineSource: "path" | "sidecar" | "custom";
  setEngineSource: (value: "path" | "sidecar" | "custom") => void;
  engineCustomBinPath: string;
  setEngineCustomBinPath: (value: string) => void;
  engineRuntime: "direct" | "veslo-orchestrator";
  setEngineRuntime: (value: "direct" | "veslo-orchestrator") => void;
  isWindows: boolean;
  aiAccessBusy: boolean;
  aiAccessConfigured: boolean;
  aiAccessMessage: string;
  aiAccessProviderLabel: string | null;
  aiAccessEffectiveModelLabel: string | null;
  showThinking: boolean;
  toggleShowThinking: () => void;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
  maxEngines: number;
  setMaxEngines: (n: number) => void;
  idleSuspendMs: number;
  setIdleSuspendMs: (ms: number) => void;
  modelVariantLabel: string;
  modelVariant: string;
  setModelVariant: (value: string) => void;
  language: Language;
  setLanguage: (value: Language) => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  denKeepSignedIn: boolean;
  toggleDenKeepSignedIn: () => void;
  updateAutoDownload: boolean;
  toggleUpdateAutoDownload: () => void;
  updateStatus: {
    state: string;
    lastCheckedAt?: number | null;
    version?: string;
    date?: string;
    notes?: string;
    totalBytes?: number | null;
    downloadedBytes?: number;
    message?: string;
    retry?: UpdateDownloadRetryInfo;
  } | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  appVersion: string | null;
  documentRuntimeStatus?: DocumentRuntimeStatusPayload | null;
  documentRuntimeRepairBusy?: boolean;
  repairDocumentRuntime?: () => void;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  retryUpdateDownload: () => void;
  installUpdateAndRestart: () => void;
  anyActiveRuns: boolean;
  onResetStartupPreference: () => void;
  openResetModal: (mode: "onboarding" | "all") => void;
  resetModalBusy: boolean;
  pendingPermissions: unknown;
  events: unknown;
  workspaceDebugEvents: unknown;
  clearWorkspaceDebugEvents: () => void;
  safeStringify: (value: unknown) => string;
  repairOpencodeMigration: () => void;
  migrationRepairBusy: boolean;
  migrationRepairResult: { ok: boolean; message: string } | null;
  migrationRepairAvailable: boolean;
  migrationRepairUnavailableReason: string | null;
  repairOpencodeCache: () => void;
  cacheRepairBusy: boolean;
  cacheRepairResult: string | null;
  cleanupVesloDockerContainers: () => void;
  dockerCleanupBusy: boolean;
  dockerCleanupResult: string | null;
  resetAppConfigDefaults: () => Promise<{ ok: boolean; message: string }>;
  notionStatus: "disconnected" | "connecting" | "connected" | "error";
  notionStatusDetail: string | null;
  notionError: string | null;
  notionBusy: boolean;
  connectNotion: () => void;
  engineDoctorVersion: string | null;
  sessionArchives?: SessionArchiveItem[];
  onUnarchiveSession?: (
    workspaceId: string,
    sessionId: string,
    workspaceIdentity?: string | null,
    directory?: string | null,
  ) => Promise<void> | void;
};

export default function SettingsView(props: SettingsViewProps) {
  const translate = (key: string) => t(key, currentLocale());
  const engineCustomBinPathLabel = () => props.engineCustomBinPath.trim() || translate("settings.no_binary_selected");

  const handlePickEngineBinary = async () => {
    if (!isTauriRuntime()) return;
    try {
      const selected = await pickFile({ title: translate("settings.select_opencode_binary") });
      const path = Array.isArray(selected) ? selected[0] : selected;
      const trimmed = (path ?? "").trim();
      if (!trimmed) return;
      props.setEngineCustomBinPath(trimmed);
      props.setEngineSource("custom");
    } catch {
      // ignore
    }
  };
  const [buildInfo, setBuildInfo] = createSignal<AppBuildInfo | null>(null);
  const updateState = () => props.updateStatus?.state ?? "idle";
  const updateNotes = () => props.updateStatus?.notes ?? null;
  const updateVersion = () => props.updateStatus?.version ?? null;
  const updateDate = () => props.updateStatus?.date ?? null;
  const updateLastCheckedAt = () => props.updateStatus?.lastCheckedAt ?? null;
  const updateDownloadedBytes = () => props.updateStatus?.downloadedBytes ?? null;
  const updateTotalBytes = () => props.updateStatus?.totalBytes ?? null;
  const updateErrorMessage = () => props.updateStatus?.message ?? null;
  const updateRetry = () => props.updateStatus?.retry ?? null;
  const updateRetryDelayLabel = () => {
    const retry = updateRetry();
    if (retry?.kind !== "scheduled") return null;
    return formatUpdateRetryDelay(retry.nextRetryAt - Date.now());
  };
  const documentRuntimeRow = createMemo(() => documentRuntimeSettingsRow(props.documentRuntimeStatus));
  const documentRuntimeToneClass = createMemo(() => {
    switch (documentRuntimeRow().tone) {
      case "ready":
        return "border-green-7/25 bg-green-3/20 text-green-11";
      case "info":
        return "border-blue-7/25 bg-blue-3/20 text-blue-11";
      case "warning":
        return "border-amber-7/35 bg-amber-3/20 text-amber-11";
      case "danger":
        return "border-red-7/35 bg-red-3/20 text-red-11";
    }
  });
  const documentRuntimeActionLabel = createMemo(() => {
    switch (documentRuntimeRow().action) {
      case "install":
        return props.documentRuntimeRepairBusy ? "Installing..." : "Install office package";
      case "repair":
        return props.documentRuntimeRepairBusy ? "Repairing..." : "Repair";
      case "update":
        return props.documentRuntimeRepairBusy ? "Updating..." : "Update office package";
      case "wait":
        return "Waiting";
      case "none":
        return null;
    }
  });
  const handleDocumentRuntimeAction = () => {
    const action = documentRuntimeRow().action;
    if (action === "install" || action === "repair" || action === "update") {
      props.repairDocumentRuntime?.();
      return;
    }
  };
  const updateDownloadPercent = createMemo<number | null>(() => {
    const total = updateTotalBytes();
    if (total == null || total <= 0) return null;
    const downloaded = updateDownloadedBytes() ?? 0;
    const clamped = Math.max(0, Math.min(1, downloaded / total));
    return Math.floor(clamped * 100);
  });

  const showGeneralUpdateControls = createMemo(() => {
    if (!isTauriRuntime()) return false;
    if (props.updateEnv && props.updateEnv.supported === false) return false;
    return true;
  });

  const generalUpdateTone = createMemo(() => {
    switch (updateState()) {
      case "available":
        return "border-amber-7/35 bg-amber-3/20 text-amber-11";
      case "ready":
        return props.anyActiveRuns
          ? "border-amber-7/35 bg-amber-3/20 text-amber-11"
          : "border-green-7/35 bg-green-3/20 text-green-11";
      case "installing":
        return "border-blue-7/35 bg-blue-3/20 text-blue-11";
      case "error":
        return "border-red-7/35 bg-red-3/20 text-red-11";
      default:
        return "border-dls-border bg-dls-surface text-dls-secondary";
    }
  });

  const generalUpdateLabel = createMemo(() => {
    const version = updateVersion() ?? "";
    if (updateState() === "available" && props.updateAutoDownload) {
      return version
        ? `${translate("settings.sidebar_update_preparing")} v${version}`
        : translate("settings.sidebar_update_preparing");
    }
    if (updateState() === "available") return `${translate("settings.update_available")}${version}`;
    if (updateState() === "ready") return `${translate("settings.update_ready")}${version}`;
    if (updateState() === "installing") return translate("settings.update_installing");
    if (updateState() === "downloading") {
      const retry = updateRetry();
      if (retry?.kind === "scheduled") {
        const delay = updateRetryDelayLabel();
        return delay
          ? translate("settings.update_retrying_in").replace("{time}", delay)
          : translate("settings.update_retrying_download");
      }
      if (retry?.kind === "active") return translate("settings.update_retrying_download");
      const percent = updateDownloadPercent();
      return percent == null ? translate("settings.update_downloading") : `${translate("settings.update_downloading")} ${percent}%`;
    }
    if (updateState() === "checking") return translate("settings.update_checking");
    if (updateState() === "error" && updateRetry()?.kind === "exhausted") return translate("settings.update_download_failed");
    if (updateState() === "error") return translate("settings.update_error");
    return translate("settings.update_uptodate");
  });

  const generalUpdateActionLabel = createMemo(() => {
    if (updateState() === "available" && !props.updateAutoDownload) return translate("settings.download_update");
    if (updateState() === "downloading" && props.updateAutoDownload) return translate("settings.pause_update_download");
    if (updateState() === "ready") return translate("settings.install_restart");
    if (updateState() === "error" && updateRetry()?.kind === "exhausted") {
      return translate("settings.retry_update_download");
    }
    if (updateState() === "error") return translate("settings.retry");
    if (updateState() === "checking" || updateState() === "downloading" || updateState() === "installing") return null;
    return translate("settings.check_update");
  });

  const generalUpdateDisabled = createMemo(() => {
    if (updateState() === "checking") return true;
    if (updateState() === "installing") return true;
    if (updateState() === "downloading") return !props.updateAutoDownload;
    if (updateState() === "ready" && props.anyActiveRuns) return true;
    return props.busy;
  });
  const documentRuntimeActionDisabled = createMemo(() => {
    const action = documentRuntimeRow().action;
    if (action === "wait") return true;
    if (action === "install" || action === "repair" || action === "update") {
      return !props.repairDocumentRuntime || Boolean(props.documentRuntimeRepairBusy) || props.anyActiveRuns;
    }
    return true;
  });

  const generalUpdateTitle = createMemo(() => {
    if (updateState() === "ready" && props.anyActiveRuns) {
      return translate("settings.stop_runs_to_update");
    }
    return generalUpdateLabel();
  });

  const handleGeneralUpdateAction = () => {
    if (generalUpdateDisabled()) return;
    if (updateState() === "downloading" && props.updateAutoDownload) {
      props.toggleUpdateAutoDownload();
      return;
    }
    if (updateState() === "available" && !props.updateAutoDownload) {
      props.downloadUpdate();
      return;
    }
    if (updateState() === "ready") {
      props.installUpdateAndRestart();
      return;
    }
    if (updateState() === "error" && updateRetry()?.kind === "exhausted") {
      props.retryUpdateDownload();
      return;
    }
    props.checkForUpdates();
  };

  const notionStatusLabel = () => {
    switch (props.notionStatus) {
      case "connected":
        return translate("status.connected");
      case "connecting":
        return translate("settings.reload_required");
      case "error":
        return translate("settings.connection_failed");
      default:
        return translate("dashboard.not_connected");
    }
  };

  const notionStatusStyle = () => {
    if (props.notionStatus === "connected") {
      return "bg-green-7/10 text-green-11 border-green-7/20";
    }
    if (props.notionStatus === "error") {
      return "bg-red-7/10 text-red-11 border-red-7/20";
    }
    if (props.notionStatus === "connecting") {
      return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    }
    return "bg-gray-4/60 text-gray-11 border-gray-7/50";
  };

  const [vesloReconnectStatus, setVesloReconnectStatus] = createSignal<string | null>(null);
  const [vesloReconnectError, setVesloReconnectError] = createSignal<string | null>(null);
  const [vesloRestartBusy, setVesloRestartBusy] = createSignal(false);
  const [vesloRestartStatus, setVesloRestartStatus] = createSignal<string | null>(null);
  const [vesloRestartError, setVesloRestartError] = createSignal<string | null>(null);
  const [runtimePreferences, setRuntimePreferences] = createSignal<DesktopRuntimePreferences | null>(null);
  const [supportDiagnosticsBusy, setSupportDiagnosticsBusy] = createSignal(false);
  const [supportDiagnosticsStatus, setSupportDiagnosticsStatus] = createSignal<string | null>(null);
  const [supportDiagnosticsError, setSupportDiagnosticsError] = createSignal<string | null>(null);
  const defaultDenApiBase = getDefaultDenApiBase();
  const [denApiBaseOverride, setDenApiBaseOverride] = createSignal(readDenApiBaseOverride() ?? "");
  const [denApiBaseDraft, setDenApiBaseDraft] = createSignal(getDenApiBase());
  const [denApiBaseStatus, setDenApiBaseStatus] = createSignal<string | null>(null);
  const [denApiBaseError, setDenApiBaseError] = createSignal<string | null>(null);
  const activeDenApiBase = createMemo(() => denApiBaseOverride() || defaultDenApiBase);
  const denApiBaseDirty = createMemo(() => denApiBaseDraft().trim() !== activeDenApiBase());
  const aiAccessStatusLabel = createMemo(() => {
    if (props.aiAccessBusy) return translate("status.loading");
    if (!props.aiAccessConfigured) return translate("status.needs_admin");
    return translate("status.configured");
  });
  const aiAccessStatusStyle = createMemo(() => {
    if (props.aiAccessBusy) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    if (!props.aiAccessConfigured) return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    return "bg-green-7/10 text-green-11 border-green-7/20";
  });
  const handleReconnectVesloServer = async () => {
    if (props.busy || props.vesloReconnectBusy) return;
    if (!props.vesloServerUrl.trim()) return;
    setVesloReconnectStatus(null);
    setVesloReconnectError(null);
    try {
      const ok = await props.reconnectVesloServer();
      if (!ok) {
        setVesloReconnectError(translate("settings.reconnect_failed_check"));
        return;
      }
      setVesloReconnectStatus(translate("settings.reconnected_server"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVesloReconnectError(message || translate("settings.reconnect_failed"));
    }
  };

  const handleRestartLocalServer = async () => {
    if (props.busy || vesloRestartBusy()) return;
    setVesloRestartStatus(null);
    setVesloRestartError(null);
    setVesloRestartBusy(true);
    try {
      const ok = await props.restartLocalServer();
      if (!ok) {
        setVesloRestartError(translate("settings.restart_failed_check_logs"));
        return;
      }
      setVesloRestartStatus(translate("settings.restarted_local_server"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVesloRestartError(message || translate("settings.restart_local_server_failed"));
    } finally {
      setVesloRestartBusy(false);
    }
  };

  const supportDiagnosticsEnabled = () => runtimePreferences()?.supportDiagnostics ?? false;

  const persistSupportDiagnosticsBrowserOverride = (enabled: boolean) => {
    try {
      window.localStorage?.setItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // Native preference remains the source of truth for the desktop runtime.
    }
  };

  const handleToggleSupportDiagnostics = async () => {
    if (!isTauriRuntime() || props.busy || supportDiagnosticsBusy()) return;
    setSupportDiagnosticsBusy(true);
    setSupportDiagnosticsStatus(null);
    setSupportDiagnosticsError(null);
    try {
      const current = runtimePreferences() ?? await desktopRuntimePreferencesRead();
      const supportDiagnostics = !current.supportDiagnostics;
      const saved = await desktopRuntimePreferencesWrite({ ...current, supportDiagnostics });
      setRuntimePreferences(saved);
      persistSupportDiagnosticsBrowserOverride(saved.supportDiagnostics);
      setSupportDiagnosticsStatus(
        saved.supportDiagnostics
          ? "Support diagnostics enabled. Restart Veslo before reproducing the issue."
          : "Support diagnostics disabled for the UI. Restart Veslo to stop local services.",
      );
    } catch (error) {
      setSupportDiagnosticsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSupportDiagnosticsBusy(false);
    }
  };

  const handleSaveDenApiBase = () => {
    setDenApiBaseStatus(null);
    setDenApiBaseError(null);
    const result = writeDenApiBaseOverride(denApiBaseDraft());
    if (!result.ok) {
      setDenApiBaseError(result.error);
      return;
    }

    const savedOverride = result.value ?? "";
    setDenApiBaseOverride(savedOverride);
    const effective = savedOverride || defaultDenApiBase;
    setDenApiBaseDraft(effective);
    setDenApiBaseStatus(
      savedOverride
        ? translate("settings.browser_signin_saved_custom").replace("{endpoint}", effective)
        : translate("settings.browser_signin_saved_default").replace("{endpoint}", effective),
    );
  };

  const vesloStatusLabel = createMemo(() => {
    switch (props.vesloServerStatus) {
      case "connected":
        return translate("status.connected");
      case "limited":
        return translate("status.limited");
      case "auth_desync":
        return translate("errors.authentication_failed");
      default:
        return translate("dashboard.not_connected");
    }
  });

  const vesloStatusStyle = createMemo(() => {
    switch (props.vesloServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      case "auth_desync":
        return "bg-red-7/10 text-red-11 border-red-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  });

  const engineStatusLabel = createMemo(() => {
    if (!isTauriRuntime()) return translate("status.unavailable");
    return props.engineInfo?.running ? translate("status.running") : translate("status.offline");
  });

  const engineStatusStyle = createMemo(() => {
    if (!isTauriRuntime()) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.engineInfo?.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const opencodeConnectStatusLabel = createMemo(() => {
    const status = props.opencodeConnectStatus?.status;
    if (!status) return translate("status.idle");
    if (status === "connected") return translate("status.connected");
    if (status === "connecting") return translate("status.connecting");
    return translate("status.failed");
  });

  const opencodeConnectStatusStyle = createMemo(() => {
    const status = props.opencodeConnectStatus?.status;
    if (!status) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    if (status === "connected") return "bg-green-7/10 text-green-11 border-green-7/20";
    if (status === "connecting") return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    return "bg-red-7/10 text-red-11 border-red-7/20";
  });

  const opencodeConnectTimestamp = createMemo(() => {
    const at = props.opencodeConnectStatus?.at;
    if (!at) return null;
    return formatRelativeTime(at);
  });

  const opencodeRouterStatusLabel = createMemo(() => {
    if (!isTauriRuntime()) return translate("status.unavailable");
    return props.opencodeRouterInfo?.running ? translate("status.running") : translate("status.offline");
  });

  const opencodeRouterStatusStyle = createMemo(() => {
    if (!isTauriRuntime()) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.opencodeRouterInfo?.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const [opencodeRouterRestarting, setOpenCodeRouterRestarting] = createSignal(false);
  const [opencodeRouterRestartError, setOpenCodeRouterRestartError] = createSignal<string | null>(null);
  const [vesloServerRestarting, setVesloServerRestarting] = createSignal(false);
  const [vesloServerRestartError, setVesloServerRestartError] = createSignal<string | null>(null);
  const [opencodeRestarting, setOpencodeRestarting] = createSignal(false);
  const [opencodeRestartError, setOpencodeRestartError] = createSignal<string | null>(null);

  const handleOpenCodeRouterRestart = async () => {
    if (opencodeRouterRestarting()) return;
    const workspacePath = props.opencodeRouterInfo?.workspacePath?.trim() || props.engineInfo?.projectDir?.trim();
    const opencodeUrl = props.opencodeRouterInfo?.opencodeUrl?.trim() || props.engineInfo?.baseUrl?.trim();
    const opencodeUsername = props.engineInfo?.opencodeUsername?.trim() || undefined;
    const opencodePassword = props.engineInfo?.opencodePassword?.trim() || undefined;
    if (!workspacePath) {
      setOpenCodeRouterRestartError(translate("settings.no_worker_path_available"));
      return;
    }
    setOpenCodeRouterRestarting(true);
    setOpenCodeRouterRestartError(null);
    try {
      await opencodeRouterRestart({
        workspacePath,
        opencodeUrl: opencodeUrl || undefined,
        opencodeUsername,
        opencodePassword,
      });
    } catch (e) {
      setOpenCodeRouterRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpenCodeRouterRestarting(false);
    }
  };

  const handleOpenCodeRouterStop = async () => {
    if (opencodeRouterRestarting()) return;
    setOpenCodeRouterRestarting(true);
    setOpenCodeRouterRestartError(null);
    try {
      await opencodeRouterStop();
    } catch (e) {
      setOpenCodeRouterRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpenCodeRouterRestarting(false);
    }
  };

  const handleVesloServerRestart = async () => {
    if (vesloServerRestarting() || !isTauriRuntime()) return;
    setVesloServerRestarting(true);
    setVesloServerRestartError(null);
    try {
      await vesloServerRestart();
      await props.reconnectVesloServer();
    } catch (e) {
      setVesloServerRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setVesloServerRestarting(false);
    }
  };

  const handleOpenCodeRestart = async () => {
    if (opencodeRestarting() || !isTauriRuntime()) return;
    setOpencodeRestarting(true);
    setOpencodeRestartError(null);
    try {
      await engineRestart();
      await props.reconnectVesloServer();
    } catch (e) {
      setOpencodeRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpencodeRestarting(false);
    }
  };

  const orchestratorStatusLabel = createMemo(() => {
    if (!props.orchestratorStatus) return translate("status.unavailable");
    return props.orchestratorStatus.running ? translate("status.running") : translate("status.offline");
  });

  const orchestratorStatusStyle = createMemo(() => {
    if (!props.orchestratorStatus) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.orchestratorStatus.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const isLocalEngineRunning = createMemo(() => Boolean(props.engineInfo?.running));
  const startupLabel = createMemo(() => "Connect to cloud server");

  const availableTabs = createMemo<SettingsTab[]>(() => {
    const tabs: SettingsTab[] = ["general", "archived", "advanced"];
    if (props.developerMode) tabs.push("debug");
    return tabs;
  });

  const activeTab = createMemo<SettingsTab>(() => {
    return resolveVisibleSettingsTab(props.settingsTab, props.developerMode);
  });

  createEffect(() => {
    if (props.settingsTab !== activeTab()) {
      props.setSettingsTab(activeTab());
    }
  });

  const formatCapability = (cap?: { read?: boolean; write?: boolean; source?: string }) => {
    if (!cap) return translate("status.unavailable");
    const parts = [cap.read ? translate("settings.capability_read") : null, cap.write ? translate("settings.capability_write") : null].filter(Boolean).join(" / ");
    const label = parts || translate("settings.capability_no_access");
    return cap.source ? `${label} · ${cap.source}` : label;
  };

  const engineStdout = () => {
    if (!isTauriRuntime()) return translate("settings.available_in_desktop_app");
    return props.engineInfo?.lastStdout?.trim() || translate("settings.no_stdout");
  };

  const engineStderr = () => {
    if (!isTauriRuntime()) return translate("settings.available_in_desktop_app");
    return props.engineInfo?.lastStderr?.trim() || translate("settings.no_stderr");
  };

  const vesloStdout = () => {
    if (!props.vesloServerHostInfo) return translate("settings.logs_available_on_host");
    return props.vesloServerHostInfo.lastStdout?.trim() || translate("settings.no_stdout");
  };

  const vesloStderr = () => {
    if (!props.vesloServerHostInfo) return translate("settings.logs_available_on_host");
    return props.vesloServerHostInfo.lastStderr?.trim() || translate("settings.no_stderr");
  };

  const opencodeRouterStdout = () => {
    if (!isTauriRuntime()) return translate("settings.available_in_desktop_app");
    return props.opencodeRouterInfo?.lastStdout?.trim() || translate("settings.no_stdout");
  };

  const opencodeRouterStderr = () => {
    if (!isTauriRuntime()) return translate("settings.available_in_desktop_app");
    return props.opencodeRouterInfo?.lastStderr?.trim() || translate("settings.no_stderr");
  };

  const formatOrchestratorBinary = (binary?: OrchestratorBinaryInfo | null) => {
    if (!binary) return translate("settings.binary_unavailable");
    const version = binary.actualVersion || binary.expectedVersion || translate("status.unknown");
    return `${binary.source} · ${version}`;
  };

  const formatOrchestratorBinaryVersion = (binary?: OrchestratorBinaryInfo | null) => {
    if (!binary) return "—";
    return binary.actualVersion || binary.expectedVersion || "—";
  };

  const orchestratorBinaryPath = () => props.orchestratorStatus?.binaries?.opencode?.path ?? "—";
  const orchestratorSidecarSummary = () => {
    const info = props.orchestratorStatus?.sidecar;
    if (!info) return translate("settings.sidecar_config_unavailable");
    const source = info.source ?? "auto";
    const target = info.target ?? translate("status.unknown");
    return `${source} · ${target}`;
  };

  const appVersionLabel = () => (props.appVersion ? `v${props.appVersion}` : "—");
  const appCommitLabel = () => {
    const sha = buildInfo()?.gitSha?.trim();
    if (!sha) return "—";
    return sha.length > 12 ? sha.slice(0, 12) : sha;
  };
  const opencodeVersionLabel = () => {
    const binary = props.orchestratorStatus?.binaries?.opencode ?? null;
    if (binary) return formatOrchestratorBinary(binary);
    return props.engineDoctorVersion ?? "—";
  };
  const vesloServerVersionLabel = () => props.vesloServerDiagnostics?.version ?? "—";
  const opencodeRouterVersionLabel = () => props.opencodeRouterInfo?.version ?? "—";
  const orchestratorVersionLabel = () => props.orchestratorStatus?.cliVersion ?? "—";

  onMount(() => {
    if (!isTauriRuntime()) return;
    void appBuildInfo().then((info) => setBuildInfo(info)).catch(() => setBuildInfo(null));
    void desktopRuntimePreferencesRead()
      .then((preferences) => {
        setRuntimePreferences(preferences);
        persistSupportDiagnosticsBrowserOverride(preferences.supportDiagnostics);
      })
      .catch(() => setRuntimePreferences(null));
  });

  const formatUptime = (uptimeMs?: number | null) => {
    if (!uptimeMs) return "—";
    return formatRelativeTime(Date.now() - uptimeMs);
  };

  const archivedSessionRows = createMemo(() => {
    const rows = props.sessionArchives ?? [];
    return [...rows].sort((left, right) => right.archivedAt - left.archivedAt);
  });

  const formatArchivedSessionTitle = (item: SessionArchiveItem) => item.title.trim() || item.sessionId;

  const formatArchivedSessionLocation = (item: SessionArchiveItem) => {
    const parts = [item.workspaceLabel?.trim(), item.projectLabel?.trim(), item.resolvedDirectory?.trim()].filter(
      (part): part is string => Boolean(part),
    );
    return parts.length > 0 ? parts.join(" · ") : item.sessionId;
  };

  const handleUnarchiveArchivedSession = async (item: SessionArchiveItem) => {
    await Promise.resolve(
      props.onUnarchiveSession?.(item.workspaceId, item.sessionId, item.workspaceIdentity, item.resolvedDirectory),
    );
  };

  const [debugReportStatus, setDebugReportStatus] = createSignal<string | null>(null);
  const [configActionStatus, setConfigActionStatus] = createSignal<string | null>(null);
  const [revealConfigBusy, setRevealConfigBusy] = createSignal(false);
  const [resetConfigBusy, setResetConfigBusy] = createSignal(false);

  const workspaceConfigPath = createMemo(() => {
    const root = props.activeWorkspaceRoot.trim();
    if (!root) return "";
    const normalized = root.replace(/[\\/]+$/, "");
    const separator = props.isWindows ? "\\" : "/";
    return `${normalized}${separator}.opencode${separator}veslo.json`;
  });

  const runtimeSandboxState = createMemo(() =>
    resolveEffectiveRuntimeSandboxState({
      configuredSandbox: props.vesloServerCapabilities?.sandbox,
      engineInfo: props.engineInfo,
      orchestratorEngines: props.orchestratorStatus?.engines ?? null,
      targetWorkspaceRoot: props.activeWorkspaceRoot.trim() || props.engineInfo?.projectDir?.trim() || null,
    }),
  );

  const runtimeSandboxReport = createMemo(() => {
    const state = runtimeSandboxState();
    return {
      configuredBackend: state.configuredBackend,
      configuredEnabled: state.configuredEnabled,
      effectiveBackend: state.effectiveBackend,
      isSandboxed: state.isSandboxed,
      engineChildKind: state.childKind,
      engineChildKindSource: state.childKindSource,
      directoryQueryMode: state.directoryQueryMode,
      requiresEngineBridgeUrl: state.requiresEngineBridgeUrl,
      sandboxFallback: state.sandboxFallback,
    };
  });

  const runtimeSandboxStatusLabel = createMemo(() => {
    const state = runtimeSandboxState();
    if (state.sandboxFallback) return "running without sandbox fallback";
    if (state.isSandboxed) return "sandbox active";
    if (state.configuredEnabled) return "sandbox configured";
    return "sandbox disabled";
  });

  const runtimeSandboxStatusStyle = createMemo(() => {
    const state = runtimeSandboxState();
    if (state.sandboxFallback) return "bg-amber-4/70 text-amber-12 border-amber-7/60";
    if (state.isSandboxed) return "bg-green-4/70 text-green-12 border-green-7/60";
    return "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const runtimeDebugReport = createMemo(() => ({
    generatedAt: new Date().toISOString(),
    app: {
      version: appVersionLabel(),
      commit: appCommitLabel(),
      startupPreference: props.startupPreference ?? "unset",
      workspaceRoot: props.activeWorkspaceRoot.trim() || null,
      workspaceConfigPath: workspaceConfigPath() || null,
    },
    versions: {
      orchestrator: orchestratorVersionLabel(),
      opencode: opencodeVersionLabel(),
      vesloServer: vesloServerVersionLabel(),
      opencodeRouter: opencodeRouterVersionLabel(),
    },
    services: {
      engine: {
        status: engineStatusLabel(),
        baseUrl: props.engineInfo?.baseUrl ?? null,
        pid: props.engineInfo?.pid ?? null,
        stdout: engineStdout(),
        stderr: engineStderr(),
      },
      orchestrator: {
        status: orchestratorStatusLabel(),
        dataDir: props.orchestratorStatus?.dataDir ?? null,
        activeWorkspace: props.orchestratorStatus?.activeId ?? null,
        sidecar: orchestratorSidecarSummary(),
      },
      vesloServer: {
        status: vesloStatusLabel(),
        baseUrl: (props.vesloServerHostInfo?.baseUrl ?? props.vesloServerUrl) || null,
        pid: props.vesloServerHostInfo?.pid ?? null,
        stdout: vesloStdout(),
        stderr: vesloStderr(),
      },
      opencodeRouter: {
        status: opencodeRouterStatusLabel(),
        healthPort: props.opencodeRouterInfo?.healthPort ?? null,
        pid: props.opencodeRouterInfo?.pid ?? null,
        stdout: opencodeRouterStdout(),
        stderr: opencodeRouterStderr(),
      },
    },
    diagnostics: props.vesloServerDiagnostics,
    capabilities: props.vesloServerCapabilities,
    documentRuntime: redactDocumentRuntimeStatus(props.documentRuntimeStatus),
    runtimeSandbox: runtimeSandboxReport(),
    bootstrap: sanitizeBootstrapDiagnosticPayload({
      serverStatus: props.vesloServerStatus,
      headerStatus: props.headerStatus,
      lastServerLaunch: props.vesloServerHostInfo
        ? {
            running: props.vesloServerHostInfo.running,
            lifecycleStatus: props.vesloServerHostInfo.lifecycleStatus ?? null,
            lifecycleReason: props.vesloServerHostInfo.lifecycleReason ?? null,
          }
        : null,
    }),
    pendingPermissions: props.pendingPermissions,
    recentEvents: props.events,
    workspaceDebugEvents: props.workspaceDebugEvents,
  }));

  const runtimeDebugReportJson = createMemo(() => `${JSON.stringify(runtimeDebugReport(), null, 2)}\n`);

  const copyRuntimeDebugReport = async () => {
    const navigatorApi = (globalThis as { navigator?: Navigator }).navigator;
    if (!navigatorApi?.clipboard?.writeText) {
      setDebugReportStatus(translate("settings.clipboard_unavailable"));
      return;
    }
    try {
      await navigatorApi.clipboard.writeText(runtimeDebugReportJson());
      setDebugReportStatus(translate("settings.copied_runtime_report"));
    } catch (error) {
      setDebugReportStatus(error instanceof Error ? error.message : translate("settings.copy_runtime_report_failed"));
    }
  };

  const exportRuntimeDebugReport = () => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      setDebugReportStatus(translate("settings.export_unavailable"));
      return;
    }
    try {
      const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
      const blob = new Blob([runtimeDebugReportJson()], { type: "application/json" });
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `veslo-debug-report-${stamp}.json`;
      anchor.click();
      window.URL.revokeObjectURL(url);
      setDebugReportStatus(translate("settings.exported_runtime_report"));
    } catch (error) {
      setDebugReportStatus(error instanceof Error ? error.message : translate("settings.export_runtime_report_failed"));
    }
  };

  const revealWorkspaceConfig = async () => {
    if (!isTauriRuntime() || revealConfigBusy()) return;
    const path = workspaceConfigPath();
    if (!path) {
      setConfigActionStatus(translate("settings.select_worker_before_reveal_config"));
      return;
    }
    setRevealConfigBusy(true);
    setConfigActionStatus(null);
    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      if (isWindowsPlatform()) {
        await openPath(path);
      } else {
        await revealItemInDir(path);
      }
      setConfigActionStatus(translate("settings.revealed_workspace_config"));
    } catch (error) {
      setConfigActionStatus(error instanceof Error ? error.message : translate("settings.reveal_workspace_config_failed"));
    } finally {
      setRevealConfigBusy(false);
    }
  };

  const resetAppConfigDefaults = async () => {
    if (resetConfigBusy()) return;
    setResetConfigBusy(true);
    setConfigActionStatus(null);
    try {
      const result = await props.resetAppConfigDefaults();
      setConfigActionStatus(result.message);
    } catch (error) {
      setConfigActionStatus(error instanceof Error ? error.message : translate("settings.reset_app_config_failed"));
    } finally {
      setResetConfigBusy(false);
    }
  };

  const compactOutlineActionClass =
    "inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60";
  const compactDangerActionClass =
    "inline-flex items-center gap-1.5 rounded-md border border-red-7/35 bg-red-3/25 px-3 py-1.5 text-xs font-medium text-red-11 transition-colors duration-150 hover:border-red-7/50 hover:bg-red-3/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-7/35 disabled:cursor-not-allowed disabled:opacity-60";
  const compactInputClass =
    "w-full rounded-md border border-dls-border bg-dls-surface px-3 py-2 text-xs text-dls-text font-mono shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] placeholder:text-dls-secondary/70";

  return (
    <section class="space-y-6">
      <div class="space-y-4">
        <h1 class="font-product type-title-md text-gray-12">{translate("dashboard.settings")}</h1>
        <DashboardTabRail
          activeDashboardTab="settings"
          activeSettingsTab={activeTab()}
          onOpenSettingsTab={props.setSettingsTab}
          onOpenDashboardTab={(tab) => props.onOpenDashboardTab?.(tab)}
          showDeveloperSettings={props.developerMode}
        />
      </div>

      <Switch>
        <Match when={activeTab() === "general"}>
          <div class="space-y-6">
            <Show when={props.developerMode}>
              <div
                data-testid="managed-ai-access-settings-card"
                class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4"
              >
                <div class="flex items-start justify-between gap-4">
                  <div>
                    <div class="flex items-center gap-2">
                      <PlugZap size={16} class="text-gray-11" />
                      <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.ai_access_1fcmzn", __vesloCurrentLocale())}</div>
                    </div>
                    <div class="text-xs text-gray-9 mt-1">{__vesloT("ui.literal.provider_and_model_assignment_is_managed_by__ekvlg6", __vesloCurrentLocale())}</div>
                  </div>
                  <div class={`text-xs px-2 py-1 rounded-full border ${aiAccessStatusStyle()}`}>
                    {aiAccessStatusLabel()}
                  </div>
                </div>

                <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 px-4 py-3 space-y-3">
                  <div class="text-xs text-gray-10">{props.aiAccessMessage}</div>
                  <Show
                    when={props.aiAccessConfigured}
                    fallback={<div class="text-[11px] text-gray-8">{__vesloT("ui.literal.users_can_sign_in_but_prompts_stay_blocked_u_e6wyhu", __vesloCurrentLocale())}</div>}
                  >
                    <div class="grid gap-3 md:grid-cols-2">
                      <div class="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2">
                        <div class="text-[11px] uppercase tracking-wide text-gray-8">{__vesloT("ui.literal.provider_evz7q4", __vesloCurrentLocale())}</div>
                        <div class="text-sm font-medium text-gray-12 mt-1">{props.aiAccessProviderLabel ?? translate("settings.not_assigned")}</div>
                      </div>
                      <div class="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2">
                        <div class="text-[11px] uppercase tracking-wide text-gray-8">{translate("settings.effective_model")}</div>
                        <div class="text-sm font-medium text-gray-12 mt-1">{props.aiAccessEffectiveModelLabel ?? translate("settings.not_assigned")}</div>
                      </div>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.run_preferences_1vi96h", __vesloCurrentLocale())}</div>
                <div class="text-xs text-gray-10">{__vesloT("ui.literal.user_level_display_and_thinking_controls_sti_otxozr", __vesloCurrentLocale())}</div>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">{translate("settings.technical_details_label")}</div>
                  <div class="text-xs text-gray-7">{translate("settings.technical_details_description")}</div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={props.toggleShowThinking}
                  disabled={props.busy}
                >
                  {props.showThinking ? translate("common.on") : translate("common.off")}
                </Button>
              </div>

              <div class="bg-gray-1 p-3 rounded-xl border border-gray-6 space-y-2">
                <div>
                  <div class="text-sm text-gray-12">{translate("session.thinking_effort")}</div>
                  <div class="text-xs text-gray-7">{__vesloT("ui.literal.default_thinking_mode_for_new_sessions_1tbk20", __vesloCurrentLocale())}</div>
                </div>
                <div class="flex gap-1.5 flex-wrap">
                  <For each={MODEL_VARIANT_OPTIONS}>
                    {(option) => (
                      <button
                        type="button"
                        class={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          props.modelVariant === option.value
                            ? "bg-gray-12 text-gray-1"
                            : "bg-gray-3 text-gray-11 hover:bg-gray-4 hover:text-gray-12"
                        }`}
                        onClick={() => props.setModelVariant(option.value)}
                        disabled={props.busy}
                      >
                        {translate(option.labelKey)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
              <div class="flex items-center justify-between gap-4">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <div class="text-sm text-gray-12">{__vesloT("ui.literal.document_runtime_z4n8k2", __vesloCurrentLocale())}</div>
                    <span class={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${documentRuntimeToneClass()}`}>
                      {documentRuntimeRow().status}
                    </span>
                  </div>
                  <div class="text-xs text-gray-7">{documentRuntimeRow().detail}</div>
                  <Show when={documentRuntimeRow().progressPercent !== null}>
                    <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-5">
                      <div
                        class="h-full rounded-full bg-blue-9 transition-[width] duration-300"
                        style={{ width: `${documentRuntimeRow().progressPercent ?? 0}%` }}
                      />
                    </div>
                  </Show>
                </div>
                <Show when={documentRuntimeActionLabel()}>
                  {(label) => (
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={handleDocumentRuntimeAction}
                      disabled={documentRuntimeActionDisabled()}
                      title={props.anyActiveRuns && ["install", "repair", "update"].includes(documentRuntimeRow().action) ? translate("settings.stop_runs_to_update") : ""}
                    >
                      {label()}
                    </Button>
                  )}
                </Show>
              </div>

            </div>

            <Show when={showGeneralUpdateControls()}>
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                <div class="flex items-start justify-between gap-4">
                  <div>
                    <div class="text-sm font-medium text-gray-12">{translate("settings.version")}</div>
                    <div class="text-xs text-gray-10">{translate("settings.check_for_updates")}</div>
                  </div>
                  <Show when={props.appVersion}>
                    {(version) => <div class="text-xs text-gray-7 font-mono">v{version()}</div>}
                  </Show>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <div
                    class={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${generalUpdateTone()}`}
                    title={generalUpdateTitle()}
                  >
                    <Show when={updateState() === "checking" || updateState() === "downloading" || updateState() === "installing"}>
                      <Loader2 size={12} class="animate-spin shrink-0" />
                    </Show>
                    <span class="tabular-nums whitespace-nowrap">{generalUpdateLabel()}</span>
                  </div>
                  <Show when={generalUpdateActionLabel()}>
                    {(label) => (
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3 rounded-full border-dls-border bg-dls-surface hover:bg-dls-hover"
                        onClick={handleGeneralUpdateAction}
                        disabled={generalUpdateDisabled()}
                        title={updateState() === "ready" && props.anyActiveRuns ? translate("settings.stop_runs_to_update") : label()}
                      >
                        {label()}
                      </Button>
                    )}
                  </Show>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={props.updateAutoDownload}
                    class="inline-flex h-8 max-w-full items-center justify-between gap-2 rounded-full border border-gray-6 bg-gray-1 px-3 text-left transition-colors hover:bg-gray-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)]"
                    onClick={() => props.toggleUpdateAutoDownload()}
                  >
                    <span class="min-w-0 whitespace-nowrap text-xs font-medium text-gray-12">{translate("settings.auto_update_label")}</span>
                    <span class={`relative h-4 w-8 shrink-0 rounded-full border transition-colors ${
                      props.updateAutoDownload
                        ? "border-gray-12/20 bg-gray-12"
                        : "border-gray-6 bg-gray-3"
                    }`}>
                      <span class={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-gray-1 shadow-sm transition-transform ${
                        props.updateAutoDownload ? "translate-x-4" : "translate-x-0"
                      }`} />
                    </span>
                  </button>
                </div>

                <Show when={updateState() === "idle" && updateLastCheckedAt()}>
                  <div class="text-xs text-gray-9">
                    {translate("settings.last_checked_time").replace("{time}", formatRelativeTime(updateLastCheckedAt() as number))}
                  </div>
                </Show>
              </div>
            </Show>

            <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">{translate("settings.appearance_title")}</div>
                <div class="text-xs text-gray-9">{translate("settings.appearance_hint")}</div>
              </div>

              <div class="flex flex-wrap gap-2">
                <Button
                  variant={props.themeMode === "system" ? "secondary" : "outline"}
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("system")}
                  disabled={props.busy}
                >
                  {translate("settings.theme_system")}
                </Button>
                <Button
                  variant={props.themeMode === "light" ? "secondary" : "outline"}
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("light")}
                  disabled={props.busy}
                >
                  {translate("settings.theme_light")}
                </Button>
                <Button
                  variant={props.themeMode === "dark" ? "secondary" : "outline"}
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("dark")}
                  disabled={props.busy}
                >
                  {translate("settings.theme_dark")}
                </Button>
              </div>

              <div class="space-y-2">
                <div class="text-xs font-medium text-gray-11">{translate("settings.language")}</div>
                <div class="text-xs text-gray-9">{translate("settings.language.description")}</div>
                <div class="flex flex-wrap gap-2">
                  <For each={LANGUAGE_OPTIONS}>
                    {(option) => (
                      <Button
                        variant={props.language === option.value ? "secondary" : "outline"}
                        class="text-xs h-8 py-0 px-3"
                        onClick={() => props.setLanguage(option.value)}
                        disabled={props.busy}
                      >
                        {option.nativeName}
                      </Button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </Match>

        <Match when={activeTab() === "archived"}>
          <div class="space-y-6">
            <Show when={props.sessionArchives !== undefined}>
              <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4">
                <div class="flex items-start justify-between gap-4">
                  <div>
                    <div class="flex items-center gap-2">
                      <RefreshCcw size={16} class="text-gray-11" />
                      <div class="text-sm font-medium text-gray-12">{translate("settings.archived_sessions_label")}</div>
                      <span class="rounded-full border border-gray-6/60 bg-gray-3/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-10">
                        {__vesloT("ui.literal.this_workspace_12yvwg", __vesloCurrentLocale())}</span>
                    </div>
                    <div class="text-xs text-gray-9 mt-1">{translate("settings.archived_sessions_description")}</div>
                  </div>
                  <div class="text-xs px-2 py-1 rounded-full border bg-gray-4/60 text-gray-11 border-gray-7/50">
                    {archivedSessionRows().length}
                  </div>
                </div>

                <Show
                  when={archivedSessionRows().length > 0}
                  fallback={
                    <div class="rounded-xl border border-dashed border-gray-7/50 bg-gray-1/40 px-3 py-4 text-xs text-gray-9">
                      {translate("settings.archived_sessions_empty")}
                    </div>
                  }
                >
                  <div class="space-y-2">
                    <For each={archivedSessionRows()}>
                      {(item) => (
                        <div
                          class="rounded-xl border border-gray-6/60 bg-gray-1/40 px-3 py-3 space-y-3"
                          data-testid="settings-archived-session-row"
                          data-session-id={item.sessionId}
                          data-workspace-id={item.workspaceId}
                        >
                          <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0 space-y-1">
                              <div class="flex flex-wrap items-center gap-2">
                                <div class="text-sm font-medium text-gray-12 truncate">{formatArchivedSessionTitle(item)}</div>
                                <Show when={!item.availableOnThisDevice}>
                                  <span class="rounded-full border border-amber-7/40 bg-amber-2 px-2 py-0.5 text-[11px] font-medium text-amber-11">
                                    {translate("settings.archived_sessions_unavailable_on_device")}
                                  </span>
                                </Show>
                              </div>
                              <div class="text-[11px] text-gray-8 truncate">{formatArchivedSessionLocation(item)}</div>
                              <div class="text-[11px] text-gray-8">
                                {translate("settings.archived_sessions_archived_at")} {formatRelativeTime(item.archivedAt)}
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              data-testid="settings-archived-session-unarchive-button"
                              data-session-id={item.sessionId}
                              data-workspace-id={item.workspaceId}
                              class="text-xs h-8 py-0 px-3 shrink-0"
                              onClick={() => void handleUnarchiveArchivedSession(item)}
                              disabled={props.busy || !props.onUnarchiveSession}
                            >
                              {translate("settings.archived_sessions_unarchive")}
                            </Button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Match>

        <Match when={activeTab() === "advanced"}>
          <div class="space-y-6">
            <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-3">
              <div class="text-sm font-medium text-gray-12">{__vesloT("dashboard.connection", __vesloCurrentLocale())}</div>
              <div class="text-xs text-gray-9">{props.headerStatus}</div>
              <div class="text-xs text-gray-8 font-mono break-all">{props.baseUrl}</div>
              <div class="space-y-2 rounded-xl border border-gray-6/70 bg-gray-1/50 p-3">
                <div class="text-xs text-gray-11">{__vesloT("ui.literal.browser_sign_in_endpoint_12m8wo", __vesloCurrentLocale())}</div>
                <div class="text-[11px] text-gray-8">
                  {__vesloT("ui.literal.used_by_the_desktop_sign_in_flow_and_handoff_18syli", __vesloCurrentLocale())}</div>
                <div class="flex flex-col gap-2 md:flex-row md:items-center">
                  <input
                    type="text"
                    class={compactInputClass}
                    spellcheck={false}
                    value={denApiBaseDraft()}
                    placeholder={defaultDenApiBase}
                    onInput={(event) => {
                      setDenApiBaseDraft(event.currentTarget.value);
                      setDenApiBaseStatus(null);
                      setDenApiBaseError(null);
                    }}
                  />
                  <Button
                    variant="outline"
                    class="text-xs h-9 py-0 px-3 shrink-0"
                    onClick={handleSaveDenApiBase}
                    disabled={props.busy || !denApiBaseDirty()}
                  >
                    {__vesloT("common.save", __vesloCurrentLocale())}</Button>
                </div>
                <div class="text-[11px] text-gray-8">
                  {__vesloT("ui.literal.active_endpoint_q0vu8a", __vesloCurrentLocale())}{" "}<span class="font-mono break-all text-gray-10">{activeDenApiBase()}</span>
                </div>
                <Show when={denApiBaseStatus()}>
                  {(value) => <div class="text-xs text-gray-10">{value()}</div>}
                </Show>
                <Show when={denApiBaseError()}>
                  {(value) => <div class="text-xs text-red-11">{value()}</div>}
                </Show>
              </div>
              <div class="flex items-center justify-between rounded-xl border border-gray-6/70 bg-gray-1/50 p-3 gap-3">
                <div class="min-w-0">
                  <div class="text-xs text-gray-11">{__vesloT("ui.literal.keep_me_signed_in_nj7h25", __vesloCurrentLocale())}</div>
                  <div class="text-[11px] text-gray-8">{__vesloT("ui.literal.if_off_veslo_asks_for_sign_in_on_each_launch_11rkho", __vesloCurrentLocale())}</div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-9 py-0 px-3 shrink-0"
                  onClick={props.toggleDenKeepSignedIn}
                  disabled={props.busy}
                >
                  {props.denKeepSignedIn ? translate("common.on") : translate("common.off")}
                </Button>
              </div>
              <div class="pt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  class={compactOutlineActionClass}
                  onClick={handleReconnectVesloServer}
                  disabled={props.busy || props.vesloReconnectBusy || !props.vesloServerUrl.trim()}
                >
                  <RefreshCcw size={14} class={`text-dls-secondary ${props.vesloReconnectBusy ? "animate-spin" : ""}`} />
                  {props.vesloReconnectBusy ? translate("settings.reconnecting") : translate("settings.reconnect_server")}
                </button>
                <Show when={isLocalEngineRunning()}>
                  <button
                    type="button"
                    class={compactOutlineActionClass}
                    onClick={handleRestartLocalServer}
                    disabled={props.busy || vesloRestartBusy()}
                  >
                    <RefreshCcw size={14} class={`text-dls-secondary ${vesloRestartBusy() ? "animate-spin" : ""}`} />
                    {vesloRestartBusy() ? translate("settings.restarting") : translate("settings.restart_local_server")}
                  </button>
                </Show>
                <Show when={isLocalEngineRunning()}>
                  <button
                    type="button"
                    class={compactDangerActionClass}
                    onClick={() => props.stopHost()}
                    disabled={props.busy}
                  >
                    <CircleAlert size={14} />
                    {__vesloT("ui.literal.stop_local_server_gfmy19", __vesloCurrentLocale())}</button>
                </Show>
                <Show when={!isLocalEngineRunning() && props.vesloServerStatus === "connected"}>
                  <button
                    type="button"
                    class={compactOutlineActionClass}
                    onClick={() => props.stopHost()}
                    disabled={props.busy}
                  >
                    {__vesloT("ui.literal.disconnect_server_1xj61t", __vesloCurrentLocale())}</button>
                </Show>
              </div>
              <Show when={vesloReconnectStatus()}>
                {(value) => <div class="text-xs text-gray-10">{value()}</div>}
              </Show>
              <Show when={vesloReconnectError()}>
                {(value) => <div class="text-xs text-red-11">{value()}</div>}
              </Show>
              <Show when={vesloRestartStatus()}>
                {(value) => <div class="text-xs text-gray-10">{value()}</div>}
              </Show>
              <Show when={vesloRestartError()}>
                {(value) => <div class="text-xs text-red-11">{value()}</div>}
              </Show>
            </div>

            <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">{translate("settings.migration_recovery_label")}</div>
                <div class="text-xs text-gray-9">{translate("settings.migration_recovery_hint")}</div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  class="text-xs h-8 py-0 px-3"
                  onClick={props.repairOpencodeMigration}
                  disabled={props.busy || props.migrationRepairBusy || !props.migrationRepairAvailable}
                  title={props.migrationRepairUnavailableReason ?? ""}
                >
                  {props.migrationRepairBusy
                    ? translate("settings.fixing_migration")
                    : translate("settings.fix_migration")}
                </Button>
              </div>
              <Show when={props.migrationRepairUnavailableReason}>
                {(reason) => <div class="text-xs text-amber-11">{reason()}</div>}
              </Show>
              <Show when={props.migrationRepairBusy}>
                <div class="text-xs text-gray-10">{translate("status.repairing_migration")}</div>
              </Show>
              <Show when={props.migrationRepairResult}>
                {(result) => (
                  <div
                    class={`rounded-xl border px-3 py-2 text-xs ${
                      result().ok
                        ? "border-green-7/30 bg-green-2/30 text-green-12"
                        : "border-red-7/30 bg-red-2/30 text-red-12"
                    }`}
                  >
                    {result().message}
                  </div>
                )}
              </Show>
            </div>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="text-sm font-medium text-gray-12">{translate("settings.updates_title")}</div>
                  <div class="text-xs text-gray-10">{translate("settings.updates_hint")}</div>
                </div>
                <div class="text-xs text-gray-7 font-mono">{props.appVersion ? `v${props.appVersion}` : ""}</div>
              </div>

              <Show
                when={!isTauriRuntime()}
                fallback={
                  <Show
                    when={props.updateEnv && props.updateEnv.supported === false}
                    fallback={
                      <>
                        <div class="flex items-center justify-between gap-3 bg-gray-1 p-3 rounded-xl border border-gray-6">
                          <div class="min-w-0 text-sm text-gray-12">{translate("settings.auto_update_label")}</div>
                          <div class="flex shrink-0 items-center gap-2">
                            <Show when={updateState() === "downloading" && props.updateAutoDownload}>
                              <Button
                                variant="outline"
                                class="h-8 rounded-full border-gray-6 px-3 py-0 text-xs"
                                onClick={() => props.toggleUpdateAutoDownload()}
                              >
                                {translate("settings.pause_update_download")}
                              </Button>
                            </Show>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={props.updateAutoDownload}
                              class={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] ${
                                props.updateAutoDownload
                                  ? "border-gray-12/20 bg-gray-12"
                                  : "border-gray-6 bg-gray-3 hover:bg-gray-4"
                              }`}
                              onClick={() => props.toggleUpdateAutoDownload()}
                            >
                              <span class={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-gray-1 shadow-sm transition-transform ${
                                props.updateAutoDownload ? "translate-x-5" : "translate-x-0"
                              }`} />
                            </button>
                          </div>
                        </div>

                        <Show
                          when={
                            Boolean(updateLastCheckedAt()) ||
                            (updateState() === "available" && Boolean(updateDate())) ||
                            updateState() === "downloading" ||
                            updateState() === "error"
                          }
                        >
                          <div class="space-y-2 rounded-xl border border-gray-6 bg-gray-1 p-3">
                            <Show when={updateState() === "idle" && updateLastCheckedAt()}>
                              <div class="text-xs text-gray-7">
                                {translate("settings.last_checked_time").replace("{time}", formatRelativeTime(updateLastCheckedAt() as number))}
                              </div>
                            </Show>
                            <Show when={updateState() === "available" && updateDate()}>
                              <div class="text-xs text-gray-7">
                                {translate("settings.published_date").replace("{date}", updateDate() ?? "")}
                              </div>
                            </Show>
                            <Show when={updateState() === "downloading"}>
                              <div class="text-xs text-gray-7">
                                {formatBytes((updateDownloadedBytes() as number) ?? 0)}
                                <Show when={updateTotalBytes() != null}>
                                  {` / ${formatBytes(updateTotalBytes() as number)}`}
                                </Show>
                              </div>
                            </Show>
                            <Show when={updateState() === "error"}>
                              <div class="text-xs text-red-11">{updateErrorMessage()}</div>
                            </Show>
                          </div>
                        </Show>

                        <Show when={updateState() === "available" && updateNotes()}>
                          <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11 whitespace-pre-wrap max-h-40 overflow-auto">
                            {updateNotes()}
                          </div>
                        </Show>
                      </>
                    }
                  >
                    <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
                      {props.updateEnv?.reason ?? translate("settings.updates_not_supported")}
                    </div>
                  </Show>
                }
              >
                <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
                  {translate("settings.updates_desktop_only")}
                </div>
              </Show>
            </div>

            <Show when={isTauriRuntime()}>
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                <div>
                  <div class="text-sm font-medium text-gray-12">{translate("settings.appearance_title")}</div>
                  <div class="text-xs text-gray-10">{translate("settings.appearance_hint")}</div>
                </div>

                <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">{translate("settings.hide_titlebar_label")}</div>
                    <div class="text-xs text-gray-7">{translate("settings.hide_titlebar_hint")}</div>
                  </div>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3 shrink-0"
                    onClick={props.toggleHideTitlebar}
                    disabled={props.busy}
                  >
                    {props.hideTitlebar ? translate("settings.on") : translate("settings.off")}
                  </Button>
                </div>
              </div>
            </Show>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
              <div>
                <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.performance_h8k2nm", __vesloCurrentLocale())}</div>
                <div class="text-xs text-gray-10">{__vesloT("ui.literal.engine_pool_tuning_multi_workspace_routing_rest_8q2mha", __vesloCurrentLocale())}</div>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0 flex-1">
                  <div class="text-sm text-gray-12">{__vesloT("ui.literal.max_concurrent_engines_v7m3ka", __vesloCurrentLocale())}</div>
                  <div class="text-xs text-gray-7">{__vesloT("ui.literal.upper_bound_for_the_per_workspace_engine_pool_1_64_k9d2xp", __vesloCurrentLocale())}</div>
                </div>
                <input
                  type="number"
                  min={1}
                  max={64}
                  step={1}
                  class="w-20 text-xs h-8 px-2 rounded border border-gray-6 bg-gray-1 text-gray-12 shrink-0"
                  value={props.maxEngines}
                  disabled={props.busy}
                  onChange={(event) => {
                    const v = Number(event.currentTarget.value);
                    if (Number.isFinite(v)) props.setMaxEngines(v);
                  }}
                />
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0 flex-1">
                  <div class="text-sm text-gray-12">{__vesloT("ui.literal.idle_suspend_minutes_4f7qxb", __vesloCurrentLocale())}</div>
                  <div class="text-xs text-gray-7">{__vesloT("ui.literal.suspend_an_engine_after_this_many_minutes_of_in_6p9zmt", __vesloCurrentLocale())}</div>
                </div>
                <input
                  type="number"
                  min={0}
                  max={120}
                  step={1}
                  class="w-20 text-xs h-8 px-2 rounded border border-gray-6 bg-gray-1 text-gray-12 shrink-0"
                  value={Math.round(props.idleSuspendMs / 60_000)}
                  disabled={props.busy}
                  onChange={(event) => {
                    const minutes = Number(event.currentTarget.value);
                    if (Number.isFinite(minutes)) props.setIdleSuspendMs(Math.max(0, minutes) * 60_000);
                  }}
                />
              </div>
            </div>

            <Show when={isTauriRuntime()}>
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-sm font-medium text-gray-12">Support diagnostics</div>
                    <div class="text-xs text-gray-10">Collect runtime and send-workflow logs only while Veslo support asks for them. Logs can contain task and session metadata.</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-label="Toggle support diagnostics"
                    aria-checked={supportDiagnosticsEnabled()}
                    disabled={props.busy || supportDiagnosticsBusy()}
                    class={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:opacity-50 ${
                      supportDiagnosticsEnabled()
                        ? "border-gray-12/20 bg-gray-12"
                        : "border-gray-6 bg-gray-3 hover:bg-gray-4"
                    }`}
                    onClick={handleToggleSupportDiagnostics}
                  >
                    <span class={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-gray-1 shadow-sm transition-transform ${
                      supportDiagnosticsEnabled() ? "translate-x-5" : "translate-x-0"
                    }`} />
                  </button>
                </div>
                <div class="text-[11px] text-gray-8">The setting is off by default, writes to the app log folder, and applies to new local services after a Veslo restart.</div>
                <Show when={supportDiagnosticsStatus()}>
                  {(status) => <div class="text-xs text-green-11">{status()}</div>}
                </Show>
                <Show when={supportDiagnosticsError()}>
                  {(error) => <div class="text-xs text-red-11">{error()}</div>}
                </Show>
              </div>
            </Show>

          </div>
        </Match>

        <Match when={activeTab() === "debug"}>
          <Show when={props.developerMode}>
            <section>
              <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider mb-4">{__vesloT("ui.literal.developer_elt1il", __vesloCurrentLocale())}</h3>

              <div class="space-y-4">
                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.runtime_debug_report_g4jh4m", __vesloCurrentLocale())}</div>
                      <div class="text-xs text-gray-10">{__vesloT("ui.literal.readable_diagnostics_snapshot_with_one_click_qr6oa4", __vesloCurrentLocale())}</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={copyRuntimeDebugReport}>
                        <Copy size={13} class="mr-1.5" />
                        {__vesloT("ui.literal.copy_json_1rp9ci", __vesloCurrentLocale())}</Button>
                      <Button variant="secondary" class="text-xs h-8 py-0 px-3" onClick={exportRuntimeDebugReport}>
                        <Download size={13} class="mr-1.5" />
                        {__vesloT("ui.literal.export_1sh99l", __vesloCurrentLocale())}</Button>
                    </div>
                  </div>
                  <div class="grid gap-2 md:grid-cols-2 text-xs text-gray-11">
                    <div>{__vesloT("ui.literal.desktop_app_188n2e", __vesloCurrentLocale())}{" "}{appVersionLabel()}</div>
                    <div>{__vesloT("ui.literal.commit_fy9fpu", __vesloCurrentLocale())}{" "}{appCommitLabel()}</div>
                    <div>{__vesloT("ui.literal.orchestrator_kmt3t5", __vesloCurrentLocale())}{" "}{orchestratorVersionLabel()}</div>
                    <div>{__vesloT("ui.literal.opencode_v0epke", __vesloCurrentLocale())}{" "}{opencodeVersionLabel()}</div>
                    <div>{__vesloT("ui.literal.veslo_server_1df7hz", __vesloCurrentLocale())}{" "}{vesloServerVersionLabel()}</div>
                    <div>{__vesloT("ui.literal.opencoderouter_1abm12", __vesloCurrentLocale())}{" "}{opencodeRouterVersionLabel()}</div>
                  </div>
                  <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto bg-gray-1 border border-gray-6 rounded-lg p-3">
                    {runtimeDebugReportJson()}
                  </pre>
                  <Show when={debugReportStatus()}>
                    {(status) => <div class="text-xs text-gray-10">{status()}</div>}
                  </Show>
                </div>

                <Show when={!CLOUD_ONLY_MODE}>
                  <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                    <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.workspace_config_16f12z", __vesloCurrentLocale())}</div>
                    <div class="text-xs text-gray-10">{__vesloT("ui.literal.reveal_or_reset_opencode_veslo_json_defaults_eyndom", __vesloCurrentLocale())}</div>
                    <div class="text-[11px] text-gray-7 font-mono break-all">{workspaceConfigPath() || translate("settings.no_active_worker")}</div>
                    <div class="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={revealWorkspaceConfig}
                        disabled={!isTauriRuntime() || revealConfigBusy() || !workspaceConfigPath()}
                        title={!isTauriRuntime() ? translate("settings.reveal_config_requires_desktop") : ""}
                      >
                        <FolderOpen size={13} class="mr-1.5" />
                        {revealConfigBusy() ? translate("dashboard.opening") : translate("settings.reveal_config")}
                      </Button>
                      <Button
                        variant="danger"
                        class="text-xs h-8 py-0 px-3"
                        onClick={resetAppConfigDefaults}
                        disabled={resetConfigBusy() || props.anyActiveRuns}
                        title={props.anyActiveRuns ? translate("settings.stop_runs_before_resetting_config") : ""}
                      >
                        {resetConfigBusy() ? translate("settings.resetting") : translate("settings.reset_config_defaults")}
                      </Button>
                    </div>
                    <Show when={configActionStatus()}>
                      {(status) => <div class="text-xs text-gray-10">{status()}</div>}
                    </Show>
                  </div>
                </Show>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">{__vesloT("settings.opencode_cache", __vesloCurrentLocale())}</div>
                    <div class="text-xs text-gray-7">
                      {__vesloT("settings.opencode_cache_description", __vesloCurrentLocale())}</div>
                    <Show when={props.cacheRepairResult}>
                      <div class="text-xs text-gray-11 mt-2">{props.cacheRepairResult}</div>
                    </Show>
                  </div>
                  <Button
                    variant="secondary"
                    class="text-xs h-8 py-0 px-3 shrink-0"
                    onClick={props.repairOpencodeCache}
                    disabled={props.cacheRepairBusy || !isTauriRuntime()}
                    title={isTauriRuntime() ? "" : translate("settings.cache_repair_requires_desktop")}
                  >
                    {props.cacheRepairBusy ? translate("settings.repairing_cache") : translate("settings.repair_cache")}
                  </Button>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">{__vesloT("ui.literal.legacy_docker_containers_x2r8kn", __vesloCurrentLocale())}</div>
                    <div class="text-xs text-gray-7">
                      {__vesloT("ui.literal.force_remove_old_docker_containers_launched_by_b6c3ya", __vesloCurrentLocale())}
                    </div>
                    <Show when={props.dockerCleanupResult}>
                      <div class="text-xs text-gray-11 mt-2">{props.dockerCleanupResult}</div>
                    </Show>
                  </div>
                  <Button
                    variant="danger"
                    class="text-xs h-8 py-0 px-3 shrink-0"
                    onClick={props.cleanupVesloDockerContainers}
                    disabled={props.dockerCleanupBusy || props.anyActiveRuns || !isTauriRuntime()}
                    title={
                      !isTauriRuntime()
                        ? translate("settings.docker_cleanup_requires_desktop")
                        : props.anyActiveRuns
                          ? translate("settings.stop_runs_before_cleanup")
                          : ""
                    }
                  >
                    {props.dockerCleanupBusy ? translate("settings.removing_containers") : translate("settings.delete_containers")}
                  </Button>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="text-sm font-medium text-gray-12">{__vesloT("settings.startup", __vesloCurrentLocale())}</div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
                    <div class="flex items-center gap-3">
                      <div class="p-2 rounded-lg bg-green-7/10 text-green-11">
                        <Smartphone size={18} />
                      </div>
                      <span class="text-sm font-medium text-gray-12">{startupLabel()}</span>
                    </div>
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3"
                      onClick={props.reconnectVesloServer}
                      disabled={props.busy}
                    >
                      {__vesloT("ui.literal.reconnect_1lh8zk", __vesloCurrentLocale())}</Button>
                  </div>

                  <p class="text-xs text-gray-7">
                    {__vesloT("ui.literal.this_build_is_cloud_only_local_host_mode_is__1nekpu", __vesloCurrentLocale())}</p>
                </div>

                <Show when={isTauriRuntime() && props.developerMode && !CLOUD_ONLY_MODE}>
                  <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                    <div>
                      <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.engine_1ovbg4", __vesloCurrentLocale())}</div>
                      <div class="text-xs text-gray-10">{__vesloT("ui.literal.choose_how_opencode_runs_locally_kx86rr", __vesloCurrentLocale())}</div>
                    </div>

                    <div class="space-y-3">
                      <div class="text-xs text-gray-10">{__vesloT("settings.engine_source", __vesloCurrentLocale())}</div>
                      <div class={props.developerMode ? "grid grid-cols-3 gap-2" : "grid grid-cols-2 gap-2"}>
                        <Button
                          variant={props.engineSource === "sidecar" ? "secondary" : "outline"}
                          onClick={() => props.setEngineSource("sidecar")}
                          disabled={props.busy}
                        >
                          {__vesloT("ui.literal.bundled_recommended_yyqq91", __vesloCurrentLocale())}</Button>
                        <Button
                          variant={props.engineSource === "path" ? "secondary" : "outline"}
                          onClick={() => props.setEngineSource("path")}
                          disabled={props.busy}
                        >
                          {__vesloT("ui.literal.system_install_path_8clptf", __vesloCurrentLocale())}</Button>
                        <Show when={props.developerMode}>
                          <Button
                            variant={props.engineSource === "custom" ? "secondary" : "outline"}
                            onClick={() => props.setEngineSource("custom")}
                            disabled={props.busy}
                          >
                            {__vesloT("ui.literal.custom_binary_1h1lhu", __vesloCurrentLocale())}</Button>
                        </Show>
                      </div>
                      <div class="text-[11px] text-gray-7">
                        {__vesloT("ui.literal.bundled_engine_is_the_most_reliable_option_u_xcb0hs", __vesloCurrentLocale())}</div>
                    </div>

                    <Show when={props.developerMode && props.engineSource === "custom"}>
                      <div class="space-y-2">
                        <div class="text-xs text-gray-10">{__vesloT("ui.literal.custom_opencode_binary_1ectwk", __vesloCurrentLocale())}</div>
                        <div class="flex items-center gap-2">
                          <div
                            class="flex-1 min-w-0 text-[11px] text-gray-7 font-mono truncate bg-gray-1 p-3 rounded-xl border border-gray-6"
                            title={engineCustomBinPathLabel()}
                          >
                            {engineCustomBinPathLabel()}
                          </div>
                          <Button
                            variant="outline"
                            class="text-xs h-10 px-3 shrink-0"
                            onClick={handlePickEngineBinary}
                            disabled={props.busy}
                          >
                            {__vesloT("common.choose", __vesloCurrentLocale())}</Button>
                          <Button
                            variant="outline"
                            class="text-xs h-10 px-3 shrink-0"
                            onClick={() => props.setEngineCustomBinPath("")}
                            disabled={props.busy || !props.engineCustomBinPath.trim()}
                            title={!props.engineCustomBinPath.trim() ? translate("settings.no_custom_path_set") : translate("skills.clear_selection")}
                          >
                            {__vesloT("skills.clear_selection", __vesloCurrentLocale())}</Button>
                        </div>
                        <div class="text-[11px] text-gray-7">
                          {__vesloT("ui.literal.use_this_to_point_veslo_at_a_local_opencode__t3m97b", __vesloCurrentLocale())}</div>
                      </div>
                    </Show>

                    <Show when={props.developerMode}>
                      <div class="space-y-3">
                        <div class="text-xs text-gray-10">{__vesloT("ui.literal.engine_runtime_d5h13b", __vesloCurrentLocale())}</div>
                        <div class="grid grid-cols-2 gap-2">
                          <Button
                            variant={props.engineRuntime === "direct" ? "secondary" : "outline"}
                            onClick={() => props.setEngineRuntime("direct")}
                            disabled={props.busy}
                          >
                            {__vesloT("ui.literal.direct_opencode_1bn4g6", __vesloCurrentLocale())}</Button>
                          <Button
                            variant={props.engineRuntime === "veslo-orchestrator" ? "secondary" : "outline"}
                            onClick={() => props.setEngineRuntime("veslo-orchestrator")}
                            disabled={props.busy}
                          >
                            {__vesloT("ui.literal.veslo_orchestrator_1xzyr6", __vesloCurrentLocale())}</Button>
                        </div>
                        <div class="text-[11px] text-gray-7">{__vesloT("ui.literal.applies_the_next_time_the_engine_starts_or_r_nuk2g1", __vesloCurrentLocale())}</div>
                      </div>
                    </Show>
                  </div>
                </Show>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.reset_recovery_6bi5e9", __vesloCurrentLocale())}</div>
                    <div class="text-xs text-gray-10">{__vesloT("ui.literal.clear_data_or_restart_the_setup_flow_ttu3fs", __vesloCurrentLocale())}</div>
                  </div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-gray-12">{__vesloT("settings.reset_onboarding", __vesloCurrentLocale())}</div>
                      <div class="text-xs text-gray-7">{__vesloT("settings.reset_onboarding_description", __vesloCurrentLocale())}</div>
                    </div>
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={() => props.openResetModal("onboarding")}
                      disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
                      title={props.anyActiveRuns ? translate("settings.stop_active_runs_reset_hint") : ""}
                    >
                      {__vesloT("settings.reset", __vesloCurrentLocale())}</Button>
                  </div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-gray-12">{__vesloT("settings.reset_app_data", __vesloCurrentLocale())}</div>
                      <div class="text-xs text-gray-7">{__vesloT("settings.reset_app_data_description", __vesloCurrentLocale())}</div>
                    </div>
                    <Button
                      variant="danger"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={() => props.openResetModal("all")}
                      disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
                      title={props.anyActiveRuns ? translate("settings.stop_active_runs_reset_hint") : ""}
                    >
                      {__vesloT("settings.reset", __vesloCurrentLocale())}</Button>
                  </div>

                  <div class="text-xs text-gray-7">
                    {__vesloT("settings.requires_typing", __vesloCurrentLocale())}{" "}<span class="font-mono text-gray-11">RESET</span> {__vesloT("settings.will_restart", __vesloCurrentLocale())}</div>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.devtools_icfg5r", __vesloCurrentLocale())}</div>
                    <div class="text-xs text-gray-10">{__vesloT("ui.literal.sidecar_health_capabilities_and_audit_trail_1amrzr", __vesloCurrentLocale())}</div>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">{__vesloT("ui.literal.service_restarts_jkcomk", __vesloCurrentLocale())}</div>
                      <div class="text-xs text-gray-10">{__vesloT("ui.literal.restart_specific_host_services_without_leavi_k8g0ek", __vesloCurrentLocale())}</div>
                    </div>
                    <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                      <Button
                        variant="secondary"
                        onClick={handleRestartLocalServer}
                        disabled={props.busy || vesloRestartBusy() || !isTauriRuntime()}
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw class={`w-3.5 h-3.5 mr-1.5 ${vesloRestartBusy() ? "animate-spin" : ""}`} />
                        {vesloRestartBusy() ? translate("settings.restarting") : translate("settings.restart_orchestrator")}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleOpenCodeRestart}
                        disabled={opencodeRestarting() || !isTauriRuntime()}
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw class={`w-3.5 h-3.5 mr-1.5 ${opencodeRestarting() ? "animate-spin" : ""}`} />
                        {opencodeRestarting() ? translate("settings.restarting") : translate("settings.restart_opencode")}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleVesloServerRestart}
                        disabled={vesloServerRestarting() || !isTauriRuntime()}
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw class={`w-3.5 h-3.5 mr-1.5 ${vesloServerRestarting() ? "animate-spin" : ""}`} />
                        {vesloServerRestarting() ? translate("settings.restarting") : translate("settings.restart_veslo_server")}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleOpenCodeRouterRestart}
                        disabled={opencodeRouterRestarting() || !isTauriRuntime()}
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw class={`w-3.5 h-3.5 mr-1.5 ${opencodeRouterRestarting() ? "animate-spin" : ""}`} />
                        {opencodeRouterRestarting() ? translate("settings.restarting") : translate("settings.restart_opencode_router")}
                      </Button>
                    </div>
                    <Show when={vesloRestartStatus()}>
                      <div class="text-xs text-green-11 bg-green-3/50 border border-green-6 rounded-lg p-2">{vesloRestartStatus()}</div>
                    </Show>
                    <Show when={vesloRestartError() || opencodeRestartError() || vesloServerRestartError() || opencodeRouterRestartError()}>
                      <div class="text-xs text-red-11 bg-red-3/50 border border-red-6 rounded-lg p-2">
                        {vesloRestartError() || opencodeRestartError() || vesloServerRestartError() || opencodeRouterRestartError()}
                      </div>
                    </Show>
                  </div>

                  <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div>
                        <div class="text-sm font-medium text-gray-12">{__vesloT("skills.detail_tab_versions", __vesloCurrentLocale())}</div>
                        <div class="text-xs text-gray-10">{__vesloT("ui.literal.sidecar_desktop_build_info_6zin83", __vesloCurrentLocale())}</div>
                      </div>
                        <div class="space-y-1">
                          <div class="text-[11px] text-gray-7 font-mono truncate">{__vesloT("ui.literal.desktop_app_188n2e", __vesloCurrentLocale())}{" "}{appVersionLabel()}</div>
                          <div class="text-[11px] text-gray-7 font-mono truncate">{__vesloT("ui.literal.commit_fy9fpu", __vesloCurrentLocale())}{" "}{appCommitLabel()}</div>
                          <div class="text-[11px] text-gray-7 font-mono truncate">{__vesloT("ui.literal.orchestrator_kmt3t5", __vesloCurrentLocale())}{" "}{orchestratorVersionLabel()}</div>
                          <div class="text-[11px] text-gray-7 font-mono truncate">{__vesloT("ui.literal.opencode_v0epke", __vesloCurrentLocale())}{" "}{opencodeVersionLabel()}</div>
                          <div class="text-[11px] text-gray-7 font-mono truncate">
                            {__vesloT("ui.literal.veslo_server_1df7hz", __vesloCurrentLocale())}{" "}{vesloServerVersionLabel()}
                          </div>
                          <div class="text-[11px] text-gray-7 font-mono truncate">{__vesloT("ui.literal.opencoderouter_1abm12", __vesloCurrentLocale())}{" "}{opencodeRouterVersionLabel()}</div>
                        </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">{__vesloT("onboarding.opencode_engine", __vesloCurrentLocale())}</div>
                          <div class="text-xs text-gray-10">{__vesloT("ui.literal.local_execution_sidecar_19q64h", __vesloCurrentLocale())}</div>
                        </div>
                        <div class={`text-xs px-2 py-1 rounded-full border ${engineStatusStyle()}`}>
                          {engineStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.engineInfo?.baseUrl ?? translate("settings.base_url_unavailable")}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.engineInfo?.projectDir ?? translate("settings.no_project_directory")}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">{__vesloT("ui.literal.pid_5yw6p4", __vesloCurrentLocale())}{" "}{props.engineInfo?.pid ?? "—"}</div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">{__vesloT("ui.literal.last_stdout_66o4p0", __vesloCurrentLocale())}</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {engineStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">{__vesloT("ui.literal.last_stderr_1kmdvm", __vesloCurrentLocale())}</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {engineStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="font-product type-ui-md font-medium text-gray-12">{__vesloT("ui.literal.orchestrator_daemon_14ptku", __vesloCurrentLocale())}</div>
                          <div class="font-reading type-ui-sm text-gray-10">{__vesloT("ui.literal.workspace_orchestration_layer_5wr94c", __vesloCurrentLocale())}</div>
                        </div>
                        <div class={`font-product type-ui-xs px-2 py-1 rounded-full border ${orchestratorStatusStyle()}`}>
                          {orchestratorStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.orchestratorStatus?.dataDir ?? translate("settings.data_directory_unavailable")}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {__vesloT("ui.literal.daemon_33yrzx", __vesloCurrentLocale())}{" "}{props.orchestratorStatus?.daemon?.baseUrl ?? "—"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {__vesloT("ui.literal.opencode_v0epke", __vesloCurrentLocale())}{" "}{props.orchestratorStatus?.opencode?.baseUrl ?? "—"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {__vesloT("ui.literal.version_1f269h", __vesloCurrentLocale())}{" "}{props.orchestratorStatus?.cliVersion ?? "—"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {__vesloT("ui.literal.sidecar_t6w1se", __vesloCurrentLocale())}{" "}{orchestratorSidecarSummary()}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate" title={orchestratorBinaryPath()}>
                          {__vesloT("ui.literal.opencode_binary_byu0fh", __vesloCurrentLocale())}{" "}{formatOrchestratorBinary(props.orchestratorStatus?.binaries?.opencode ?? null)}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {__vesloT("ui.literal.active_workspace_rotr1o", __vesloCurrentLocale())}{" "}{props.orchestratorStatus?.activeId ?? "—"}
                        </div>
                      </div>
                      <Show when={props.orchestratorStatus?.lastError}>
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">{__vesloT("ui.literal.last_error_1a7xgo", __vesloCurrentLocale())}</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {props.orchestratorStatus?.lastError}
                          </pre>
                        </div>
                      </Show>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="font-product type-ui-md font-medium text-gray-12">{__vesloT("ui.literal.opencode_sdk_15j9h3", __vesloCurrentLocale())}</div>
                          <div class="font-reading type-ui-sm text-gray-10">{__vesloT("ui.literal.ui_connection_diagnostics_a5vi6x", __vesloCurrentLocale())}</div>
                        </div>
                        <div class={`font-product type-ui-xs px-2 py-1 rounded-full border ${opencodeConnectStatusStyle()}`}>
                          {opencodeConnectStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.opencodeConnectStatus?.baseUrl ?? translate("settings.base_url_unavailable")}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.opencodeConnectStatus?.directory ?? translate("settings.no_project_directory")}
                        </div>
                        <div class="font-product type-ui-xs text-gray-7">
                          {__vesloT("ui.literal.last_attempt_n4aaie", __vesloCurrentLocale())}{" "}{opencodeConnectTimestamp() ?? "—"}
                        </div>
                        <Show when={props.opencodeConnectStatus?.reason}>
                          <div class="font-product type-ui-xs text-gray-7">{__vesloT("ui.literal.reason_19diqi", __vesloCurrentLocale())}{" "}{props.opencodeConnectStatus?.reason}</div>
                        </Show>
                        <Show when={props.opencodeConnectStatus?.metrics}>
                          {(metrics) => (
                            <div class="font-product type-ui-xs pt-1 space-y-1 text-gray-7">
                              <Show when={metrics().healthyMs != null}>
                                <div>{__vesloT("ui.literal.healthy_944m4o", __vesloCurrentLocale())}{" "}{Math.round(metrics().healthyMs as number)}ms</div>
                              </Show>
                              <Show when={metrics().loadSessionsMs != null}>
                                <div>{__vesloT("ui.literal.load_sessions_1yff8f", __vesloCurrentLocale())}{" "}{Math.round(metrics().loadSessionsMs as number)}ms</div>
                              </Show>
                              <Show when={metrics().pendingPermissionsMs != null}>
                                <div>
                                  {__vesloT("ui.literal.pending_permissions_13wfyd", __vesloCurrentLocale())}{" "}{Math.round(metrics().pendingPermissionsMs as number)}ms
                                </div>
                              </Show>
                              <Show when={metrics().providersMs != null}>
                                <div>{__vesloT("ui.literal.providers_b9u37p", __vesloCurrentLocale())}{" "}{Math.round(metrics().providersMs as number)}ms</div>
                              </Show>
                              <Show when={metrics().totalMs != null}>
                                <div>{__vesloT("ui.literal.total_293rad", __vesloCurrentLocale())}{" "}{Math.round(metrics().totalMs as number)}ms</div>
                              </Show>
                            </div>
                          )}
                        </Show>
                      </div>
                      <Show when={props.opencodeConnectStatus?.error}>
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">{__vesloT("ui.literal.last_error_1a7xgo", __vesloCurrentLocale())}</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {props.opencodeConnectStatus?.error}
                          </pre>
                        </div>
                      </Show>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="font-product type-ui-md font-medium text-gray-12">{__vesloT("dashboard.remote_mode_veslo_alpha", __vesloCurrentLocale())}</div>
                          <div class="font-reading type-ui-sm text-gray-10">{__vesloT("ui.literal.config_and_approvals_sidecar_18tj5t", __vesloCurrentLocale())}</div>
                        </div>
                        <div class={`font-product type-ui-xs px-2 py-1 rounded-full border ${vesloStatusStyle()}`}>
                          {vesloStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {(props.vesloServerHostInfo?.baseUrl ?? props.vesloServerUrl) || translate("settings.base_url_unavailable")}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">{__vesloT("ui.literal.pid_5yw6p4", __vesloCurrentLocale())}{" "}{props.vesloServerHostInfo?.pid ?? "—"}</div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">{__vesloT("ui.literal.last_stdout_66o4p0", __vesloCurrentLocale())}</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {vesloStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">{__vesloT("ui.literal.last_stderr_1kmdvm", __vesloCurrentLocale())}</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {vesloStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="font-product type-ui-md font-medium text-gray-12">{__vesloT("ui.literal.opencoderouter_sidecar_gritgy", __vesloCurrentLocale())}</div>
                          <div class="font-reading type-ui-sm text-gray-10">{__vesloT("ui.literal.bridge_runtime_currently_hidden_from_end_use_1ak2dr", __vesloCurrentLocale())}</div>
                        </div>
                        <div class={`font-product type-ui-xs px-2 py-1 rounded-full border ${opencodeRouterStatusStyle()}`}>
                          {opencodeRouterStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.opencodeRouterInfo?.opencodeUrl?.trim() || translate("settings.opencode_url_unavailable")}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.opencodeRouterInfo?.workspacePath?.trim() || translate("settings.no_worker_directory")}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {__vesloT("ui.literal.health_port_19tjkf", __vesloCurrentLocale())}{" "}{props.opencodeRouterInfo?.healthPort ?? "—"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">{__vesloT("ui.literal.pid_5yw6p4", __vesloCurrentLocale())}{" "}{props.opencodeRouterInfo?.pid ?? "—"}</div>
                      </div>
                      <div class="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          onClick={handleOpenCodeRouterRestart}
                          disabled={opencodeRouterRestarting() || !isTauriRuntime()}
                          class="text-xs px-3 py-1.5"
                        >
                          <RefreshCcw class={`w-3.5 h-3.5 mr-1.5 ${opencodeRouterRestarting() ? "animate-spin" : ""}`} />
                          {opencodeRouterRestarting() ? translate("settings.restarting") : translate("settings.restart")}
                        </Button>
                        <Show when={props.opencodeRouterInfo?.running}>
                          <Button
                            variant="ghost"
                            onClick={handleOpenCodeRouterStop}
                            disabled={opencodeRouterRestarting()}
                            class="text-xs px-3 py-1.5"
                          >
                            {__vesloT("session.stop_label", __vesloCurrentLocale())}</Button>
                        </Show>
                      </div>
                      <Show when={opencodeRouterRestartError()}>
                        <div class="font-product type-ui-sm text-red-11 bg-red-3/50 border border-red-6 rounded-lg p-2">
                          {opencodeRouterRestartError()}
                        </div>
                      </Show>
                      <div class="grid gap-2">
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">{__vesloT("ui.literal.last_stdout_66o4p0", __vesloCurrentLocale())}</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {opencodeRouterStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">{__vesloT("ui.literal.last_stderr_1kmdvm", __vesloCurrentLocale())}</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {opencodeRouterStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="font-product type-ui-md font-medium text-gray-12">{__vesloT("ui.literal.veslo_server_diagnostics_14kjjk", __vesloCurrentLocale())}</div>
                      <div class="font-mono type-ui-xs text-gray-8 truncate">
                        {props.vesloServerDiagnostics?.version ?? "—"}
                      </div>
                    </div>
                    <Show
                      when={props.vesloServerDiagnostics}
                      fallback={<div class="font-product type-ui-sm text-gray-9">{__vesloT("ui.literal.diagnostics_unavailable_j6iv91", __vesloCurrentLocale())}</div>}
                    >
                      {(diag) => (
                        <div class="font-product type-ui-sm grid md:grid-cols-2 gap-2 text-gray-11">
                          <div>{__vesloT("ui.literal.started_1nkwq4", __vesloCurrentLocale())}{" "}{formatUptime(diag().uptimeMs)}</div>
                          <div>{__vesloT("ui.literal.read_only_7asksw", __vesloCurrentLocale())}{" "}{diag().readOnly ? translate("common.true") : translate("common.false")}</div>
                          <div>
                            {__vesloT("ui.literal.approval_6s3vw4", __vesloCurrentLocale())}{" "}{diag().approval.mode} ({diag().approval.timeoutMs}{__vesloT("ui.literal.ms_9kn2zs", __vesloCurrentLocale())}</div>
                          <div>{__vesloT("ui.literal.workspaces_1qpwgk", __vesloCurrentLocale())}{" "}{diag().workspaceCount}</div>
                          <div>{__vesloT("ui.literal.active_workspace_rotr1o", __vesloCurrentLocale())}{" "}{diag().activeWorkspaceId ?? "—"}</div>
                          <div>{__vesloT("ui.literal.config_path_10ow8r", __vesloCurrentLocale())}{" "}{diag().server.configPath ?? translate("common.default")}</div>
                          <div>{__vesloT("ui.literal.token_source_rfu5df", __vesloCurrentLocale())}{" "}{diag().tokenSource.client}</div>
                          <div>{__vesloT("ui.literal.host_token_source_1t2g6o", __vesloCurrentLocale())}{" "}{diag().tokenSource.host}</div>
                        </div>
                      )}
                    </Show>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="font-product type-ui-md font-medium text-gray-12">{__vesloT("ui.literal.veslo_server_capabilities_1fu1yi", __vesloCurrentLocale())}</div>
                      <div class="font-mono type-ui-xs text-gray-8 truncate">
                        {props.vesloServerWorkspaceId ? `${translate("workspace.fallback_worker")} ${props.vesloServerWorkspaceId}` : translate("settings.worker_unresolved")}
                      </div>
                    </div>
                    <Show
                      when={props.vesloServerCapabilities}
                      fallback={<div class="font-product type-ui-sm text-gray-9">{__vesloT("ui.literal.capabilities_unavailable_connect_with_a_clie_1d5uu2", __vesloCurrentLocale())}</div>}
                    >
                      {(caps) => (
                        <div class="font-product type-ui-sm grid md:grid-cols-2 gap-2 text-gray-11">
                          <div>{__vesloT("ui.literal.skills_pwxsnz", __vesloCurrentLocale())}{" "}{formatCapability(caps().skills)}</div>
                          <div>{__vesloT("ui.literal.plugins_107x7q", __vesloCurrentLocale())}{" "}{formatCapability(caps().plugins)}</div>
                          <div>{__vesloT("ui.literal.mcp_1gfg4x", __vesloCurrentLocale())}{" "}{formatCapability(caps().mcp)}</div>
                          <div>{__vesloT("ui.literal.commands_189r59", __vesloCurrentLocale())}{" "}{formatCapability(caps().commands)}</div>
                          <div>{__vesloT("ui.literal.config_1o4qqc", __vesloCurrentLocale())}{" "}{formatCapability(caps().config)}</div>
                          <div>{__vesloT("ui.literal.proxy_opencoderouter_1oq2yh", __vesloCurrentLocale())}{" "}{caps().proxy?.opencodeRouter ? translate("mcp.enabled") : translate("mcp.disabled")}</div>
                          <div>
                            {__vesloT("ui.literal.browser_tools_wve4ga", __vesloCurrentLocale())}{" "}{(() => {
                              const browser = caps().toolProviders?.browser;
                              if (!browser?.enabled) return translate("mcp.disabled");
                              return `${browser.mode} · ${browser.placement}`;
                            })()}
                          </div>
                          <div>
                            {__vesloT("ui.literal.file_tools_1lpb92", __vesloCurrentLocale())}{" "}{(() => {
                              const files = caps().toolProviders?.files;
                              if (!files) return translate("status.unavailable");
                              const parts = [
                                files.injection ? translate("settings.inbox_on") : translate("settings.inbox_off"),
                                files.outbox ? translate("settings.outbox_on") : translate("settings.outbox_off"),
                              ];
                              return parts.join(" · ");
                            })()}
                          </div>
                          <div>
                            {__vesloT("ui.literal.sandbox_a1meoq", __vesloCurrentLocale())}{" "}{(() => {
                              const sandbox = caps().sandbox;
                              return sandbox
                                ? `${sandbox.backend} (${sandbox.enabled ? translate("common.on") : translate("common.off")})`
                                : translate("status.unavailable");
                            })()}
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="font-product type-ui-md font-medium text-gray-12">Runtime sandbox</div>
                      <div class={`font-product type-ui-xs px-2 py-1 rounded-full border ${runtimeSandboxStatusStyle()}`}>
                        {runtimeSandboxStatusLabel()}
                      </div>
                    </div>
                    <div class="font-product type-ui-sm grid md:grid-cols-2 gap-2 text-gray-11">
                      <div>Configured backend {runtimeSandboxState().configuredBackend}</div>
                      <div>Configured enabled {runtimeSandboxState().configuredEnabled ? translate("common.true") : translate("common.false")}</div>
                      <div>Effective backend {runtimeSandboxState().effectiveBackend}</div>
                      <div>Sandboxed {runtimeSandboxState().isSandboxed ? translate("common.true") : translate("common.false")}</div>
                      <div>Engine child {runtimeSandboxState().childKind ?? "unknown"}</div>
                      <div>Child source {runtimeSandboxState().childKindSource}</div>
                      <div>Directory mode {runtimeSandboxState().directoryQueryMode}</div>
                      <div>Engine bridge URL {runtimeSandboxState().requiresEngineBridgeUrl ? "required" : "not required"}</div>
                      <div>Fallback {runtimeSandboxState().sandboxFallback ? translate("common.true") : translate("common.false")}</div>
                    </div>
                  </div>

                  <div class="grid md:grid-cols-2 gap-4">
                    <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                      <div class="text-xs text-gray-10 mb-2">{__vesloT("settings.pending_permissions", __vesloCurrentLocale())}</div>
                      <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                        {props.safeStringify(props.pendingPermissions)}
                      </pre>
                    </div>
                    <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                      <div class="text-xs text-gray-10 mb-2">{__vesloT("settings.recent_events", __vesloCurrentLocale())}</div>
                      <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                        {props.safeStringify(props.events)}
                      </pre>
                    </div>
                  </div>

                  <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                    <div class="flex items-center justify-between gap-3 mb-2">
                      <div class="text-xs text-gray-10">{__vesloT("ui.literal.workspace_debug_events_g2kpm2", __vesloCurrentLocale())}</div>
                      <Button
                        variant="outline"
                        class="text-xs h-7 py-0 px-2 shrink-0"
                        onClick={props.clearWorkspaceDebugEvents}
                        disabled={props.busy}
                      >
                        {__vesloT("skills.clear_selection", __vesloCurrentLocale())}</Button>
                    </div>
                    <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                      {props.safeStringify(props.workspaceDebugEvents)}
                    </pre>
                  </div>
                </div>
              </div>
            </section>
          </Show>
        </Match>
      </Switch>
    </section>
  );
}
