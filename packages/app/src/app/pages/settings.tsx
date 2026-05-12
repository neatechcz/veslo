import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onMount } from "solid-js";

import { formatBytes, formatRelativeTime, isTauriRuntime, isWindowsPlatform } from "../utils";

import Button from "../components/button";
import { CircleAlert, Copy, Download, FolderOpen, Loader2, PlugZap, RefreshCcw, Smartphone, X } from "lucide-solid";
import type { OpencodeConnectStatus, SessionArchiveItem, SettingsTab, StartupPreference } from "../types";
import type {
  VesloAuditEntry,
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
  SandboxDebugProbeResult,
  WorkspaceInfo,
} from "../lib/tauri";
import ExtensionsOverview from "./extensions-overview";
import {
  appBuildInfo,
  engineRestart,
  opencodeRouterRestart,
  opencodeRouterStop,
  vesloServerRestart,
  pickFile,
  sandboxDebugProbe,
} from "../lib/tauri";
import {
  getDefaultDenApiBase,
  getDenApiBase,
  readDenApiBaseOverride,
  writeDenApiBaseOverride,
} from "../lib/den-auth";
import { resolveSettingsTabLabel, resolveVisibleSettingsTab } from "../lib/settings-tab-label";
import { currentLocale, LANGUAGE_OPTIONS, t, type Language } from "../../i18n";
import { CLOUD_ONLY_MODE } from "../lib/cloud-policy";
import { MODEL_VARIANT_OPTIONS } from "../lib/model-variant";

export type SettingsViewProps = {
  startupPreference: StartupPreference | null;
  baseUrl: string;
  headerStatus: string;
  busy: boolean;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  vesloServerStatus: VesloServerStatus;
  vesloServerUrl: string;
  vesloReconnectBusy: boolean;
  reconnectVesloServer: () => Promise<boolean>;
  vesloServerHostInfo: VesloServerInfo | null;
  vesloServerCapabilities: VesloServerCapabilities | null;
  vesloServerDiagnostics: VesloServerDiagnostics | null;
  vesloServerWorkspaceId: string | null;
  activeWorkspaceRoot: string;
  vesloAuditEntries: VesloAuditEntry[];
  vesloAuditStatus: "idle" | "loading" | "error";
  vesloAuditError: string | null;
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
  aiAccessDefaultModelLabel: string | null;
  aiAccessAllowedModels: string[];
  showThinking: boolean;
  toggleShowThinking: () => void;
  autoCompactContext: boolean;
  toggleAutoCompactContext: () => void;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
  modelVariantLabel: string;
  modelVariant: string;
  setModelVariant: (value: string) => void;
  language: Language;
  setLanguage: (value: Language) => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  denKeepSignedIn: boolean;
  toggleDenKeepSignedIn: () => void;
  updateAutoCheck: boolean;
  toggleUpdateAutoCheck: () => void;
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
  } | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  appVersion: string | null;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  installUpdateAndRestart: () => void;
  anyActiveRuns: boolean;
  onResetStartupPreference: () => void;
  openResetModal: (mode: "onboarding" | "all") => void;
  resetModalBusy: boolean;
  pendingPermissions: unknown;
  events: unknown;
  workspaceDebugEvents: unknown;
  sandboxCreateProgress: unknown;
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
  onUnarchiveSession?: (sessionId: string) => Promise<void> | void;
  workspaces: WorkspaceInfo[];
};

export default function SettingsView(props: SettingsViewProps) {
  const translate = (key: string) => t(key, currentLocale());
  const engineCustomBinPathLabel = () => props.engineCustomBinPath.trim() || "No binary selected.";

  const handlePickEngineBinary = async () => {
    if (!isTauriRuntime()) return;
    try {
      const selected = await pickFile({ title: "Select OpenCode binary" });
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
    if (updateState() === "downloading") {
      const percent = updateDownloadPercent();
      return percent == null ? translate("settings.update_downloading") : `${translate("settings.update_downloading")} ${percent}%`;
    }
    if (updateState() === "checking") return translate("settings.update_checking");
    if (updateState() === "error") return translate("settings.update_error");
    return translate("settings.update_uptodate");
  });

  const generalUpdateActionLabel = createMemo(() => {
    if (updateState() === "available" && !props.updateAutoDownload) return translate("settings.download_update");
    if (updateState() === "ready") return translate("settings.install_restart");
    if (updateState() === "error") return translate("settings.retry");
    if (updateState() === "checking" || updateState() === "downloading") return null;
    return translate("settings.check_update");
  });

  const generalUpdateDisabled = createMemo(() => {
    if (updateState() === "checking" || updateState() === "downloading") return true;
    if (updateState() === "ready" && props.anyActiveRuns) return true;
    return props.busy;
  });

  const generalUpdateTitle = createMemo(() => {
    if (updateState() === "ready" && props.anyActiveRuns) {
      return translate("settings.stop_runs_to_update");
    }
    return generalUpdateLabel();
  });

  const handleGeneralUpdateAction = () => {
    if (generalUpdateDisabled()) return;
    if (updateState() === "available" && !props.updateAutoDownload) {
      props.downloadUpdate();
      return;
    }
    if (updateState() === "ready") {
      props.installUpdateAndRestart();
      return;
    }
    props.checkForUpdates();
  };

  const notionStatusLabel = () => {
    switch (props.notionStatus) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Reload required";
      case "error":
        return "Connection failed";
      default:
        return "Not connected";
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
  const defaultDenApiBase = getDefaultDenApiBase();
  const [denApiBaseOverride, setDenApiBaseOverride] = createSignal(readDenApiBaseOverride() ?? "");
  const [denApiBaseDraft, setDenApiBaseDraft] = createSignal(getDenApiBase());
  const [denApiBaseStatus, setDenApiBaseStatus] = createSignal<string | null>(null);
  const [denApiBaseError, setDenApiBaseError] = createSignal<string | null>(null);
  const activeDenApiBase = createMemo(() => denApiBaseOverride() || defaultDenApiBase);
  const denApiBaseDirty = createMemo(() => denApiBaseDraft().trim() !== activeDenApiBase());
  const aiAccessStatusLabel = createMemo(() => {
    if (props.aiAccessBusy) return "Loading";
    if (!props.aiAccessConfigured) return "Needs admin";
    return "Configured";
  });
  const aiAccessStatusStyle = createMemo(() => {
    if (props.aiAccessBusy) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    if (!props.aiAccessConfigured) return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    return "bg-green-7/10 text-green-11 border-green-7/20";
  });
  const aiAccessAllowedModelsSummary = createMemo(() => {
    const models = props.aiAccessAllowedModels.filter((value) => value.trim().length > 0);
    if (!models.length) return "Only the admin default model is allowed.";
    if (models.length === 1) return models[0]!;
    return `${models.length} allowed models`;
  });

  const handleReconnectVesloServer = async () => {
    if (props.busy || props.vesloReconnectBusy) return;
    if (!props.vesloServerUrl.trim()) return;
    setVesloReconnectStatus(null);
    setVesloReconnectError(null);
    try {
      const ok = await props.reconnectVesloServer();
      if (!ok) {
        setVesloReconnectError("Reconnect failed. Check server URL/token and try again.");
        return;
      }
      setVesloReconnectStatus("Reconnected to Veslo server.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVesloReconnectError(message || "Failed to reconnect Veslo server.");
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
        setVesloRestartError("Restart failed. Check logs and try again.");
        return;
      }
      setVesloRestartStatus("Restarted local server.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVesloRestartError(message || "Failed to restart local server.");
    } finally {
      setVesloRestartBusy(false);
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
        ? `Saved. Browser sign-in now uses ${effective}.`
        : `Saved. Browser sign-in now uses the default endpoint (${effective}).`,
    );
  };

  const vesloStatusLabel = createMemo(() => {
    switch (props.vesloServerStatus) {
      case "connected":
        return "Connected";
      case "limited":
        return "Limited";
      default:
        return "Not connected";
    }
  });

  const vesloStatusStyle = createMemo(() => {
    switch (props.vesloServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  });

  const engineStatusLabel = createMemo(() => {
    if (!isTauriRuntime()) return "Unavailable";
    return props.engineInfo?.running ? "Running" : "Offline";
  });

  const engineStatusStyle = createMemo(() => {
    if (!isTauriRuntime()) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.engineInfo?.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const opencodeConnectStatusLabel = createMemo(() => {
    const status = props.opencodeConnectStatus?.status;
    if (!status) return "Idle";
    if (status === "connected") return "Connected";
    if (status === "connecting") return "Connecting";
    return "Failed";
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
    if (!isTauriRuntime()) return "Unavailable";
    return props.opencodeRouterInfo?.running ? "Running" : "Offline";
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
      setOpenCodeRouterRestartError("No worker path available");
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
    if (!props.orchestratorStatus) return "Unavailable";
    return props.orchestratorStatus.running ? "Running" : "Offline";
  });

  const orchestratorStatusStyle = createMemo(() => {
    if (!props.orchestratorStatus) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.orchestratorStatus.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const vesloAuditStatusLabel = createMemo(() => {
    if (!props.vesloServerWorkspaceId) return "Unavailable";
    if (props.vesloAuditStatus === "loading") return "Loading";
    if (props.vesloAuditStatus === "error") return "Error";
    return "Ready";
  });

  const vesloAuditStatusStyle = createMemo(() => {
    if (!props.vesloServerWorkspaceId) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    if (props.vesloAuditStatus === "loading") return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    if (props.vesloAuditStatus === "error") return "bg-red-7/10 text-red-11 border-red-7/20";
    return "bg-green-7/10 text-green-11 border-green-7/20";
  });

  const isLocalEngineRunning = createMemo(() => Boolean(props.engineInfo?.running));
  const startupLabel = createMemo(() => "Connect to cloud server");

  const availableTabs = createMemo<SettingsTab[]>(() => {
    const tabs: SettingsTab[] = ["general", "extensions", "archived"];
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

  const formatActor = (entry: VesloAuditEntry) => {
    const actor = entry.actor;
    if (!actor) return "unknown";
    if (actor.type === "host") return "host";
    if (actor.type === "remote") {
      return actor.clientId ? `remote:${actor.clientId}` : "remote";
    }
    return "unknown";
  };

  const formatCapability = (cap?: { read?: boolean; write?: boolean; source?: string }) => {
    if (!cap) return "Unavailable";
    const parts = [cap.read ? "read" : null, cap.write ? "write" : null].filter(Boolean).join(" / ");
    const label = parts || "no access";
    return cap.source ? `${label} · ${cap.source}` : label;
  };

  const engineStdout = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return props.engineInfo?.lastStdout?.trim() || "No stdout captured yet.";
  };

  const engineStderr = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return props.engineInfo?.lastStderr?.trim() || "No stderr captured yet.";
  };

  const vesloStdout = () => {
    if (!props.vesloServerHostInfo) return "Logs are available on the host.";
    return props.vesloServerHostInfo.lastStdout?.trim() || "No stdout captured yet.";
  };

  const vesloStderr = () => {
    if (!props.vesloServerHostInfo) return "Logs are available on the host.";
    return props.vesloServerHostInfo.lastStderr?.trim() || "No stderr captured yet.";
  };

  const opencodeRouterStdout = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return props.opencodeRouterInfo?.lastStdout?.trim() || "No stdout captured yet.";
  };

  const opencodeRouterStderr = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return props.opencodeRouterInfo?.lastStderr?.trim() || "No stderr captured yet.";
  };

  const formatOrchestratorBinary = (binary?: OrchestratorBinaryInfo | null) => {
    if (!binary) return "Binary unavailable";
    const version = binary.actualVersion || binary.expectedVersion || "unknown";
    return `${binary.source} · ${version}`;
  };

  const formatOrchestratorBinaryVersion = (binary?: OrchestratorBinaryInfo | null) => {
    if (!binary) return "—";
    return binary.actualVersion || binary.expectedVersion || "—";
  };

  const orchestratorBinaryPath = () => props.orchestratorStatus?.binaries?.opencode?.path ?? "—";
  const orchestratorSidecarSummary = () => {
    const info = props.orchestratorStatus?.sidecar;
    if (!info) return "Sidecar config unavailable";
    const source = info.source ?? "auto";
    const target = info.target ?? "unknown";
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

  const handleUnarchiveArchivedSession = async (sessionId: string) => {
    await Promise.resolve(props.onUnarchiveSession?.(sessionId));
  };

  const [debugReportStatus, setDebugReportStatus] = createSignal<string | null>(null);
  const [configActionStatus, setConfigActionStatus] = createSignal<string | null>(null);
  const [revealConfigBusy, setRevealConfigBusy] = createSignal(false);
  const [resetConfigBusy, setResetConfigBusy] = createSignal(false);
  const [sandboxProbeBusy, setSandboxProbeBusy] = createSignal(false);
  const [sandboxProbeStatus, setSandboxProbeStatus] = createSignal<string | null>(null);
  const [sandboxProbeResult, setSandboxProbeResult] = createSignal<SandboxDebugProbeResult | null>(null);

  const sandboxCreateSummary = createMemo(() => {
    const raw = props.sandboxCreateProgress as
      | { runId?: string; stage?: string; error?: string | null; logs?: string[] }
      | null
      | undefined;
    if (!raw || typeof raw !== "object") {
      return { runId: null, stage: null, error: null, logs: [] as string[] };
    }
    return {
      runId: typeof raw.runId === "string" && raw.runId.trim() ? raw.runId : null,
      stage: typeof raw.stage === "string" && raw.stage.trim() ? raw.stage : null,
      error: typeof raw.error === "string" && raw.error.trim() ? raw.error : null,
      logs: Array.isArray(raw.logs)
        ? raw.logs.filter((line) => typeof line === "string" && line.trim()).slice(-400)
        : [],
    };
  });

  const workspaceConfigPath = createMemo(() => {
    const root = props.activeWorkspaceRoot.trim();
    if (!root) return "";
    const normalized = root.replace(/[\\/]+$/, "");
    const separator = props.isWindows ? "\\" : "/";
    return `${normalized}${separator}.opencode${separator}veslo.json`;
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
    pendingPermissions: props.pendingPermissions,
    recentEvents: props.events,
    workspaceDebugEvents: props.workspaceDebugEvents,
    sandboxCreateProgress: sandboxCreateSummary(),
    sandboxProbe: sandboxProbeResult(),
  }));

  const runtimeDebugReportJson = createMemo(() => `${JSON.stringify(runtimeDebugReport(), null, 2)}\n`);

  const copyRuntimeDebugReport = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setDebugReportStatus("Clipboard is unavailable in this environment.");
      return;
    }
    try {
      await navigator.clipboard.writeText(runtimeDebugReportJson());
      setDebugReportStatus("Copied runtime report JSON.");
    } catch (error) {
      setDebugReportStatus(error instanceof Error ? error.message : "Failed to copy runtime report.");
    }
  };

  const exportRuntimeDebugReport = () => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      setDebugReportStatus("Export is unavailable in this environment.");
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
      setDebugReportStatus("Exported runtime report JSON.");
    } catch (error) {
      setDebugReportStatus(error instanceof Error ? error.message : "Failed to export runtime report.");
    }
  };

  const revealWorkspaceConfig = async () => {
    if (!isTauriRuntime() || revealConfigBusy()) return;
    const path = workspaceConfigPath();
    if (!path) {
      setConfigActionStatus("Select an active worker before revealing config.");
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
      setConfigActionStatus("Revealed workspace config.");
    } catch (error) {
      setConfigActionStatus(error instanceof Error ? error.message : "Failed to reveal workspace config.");
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
      setConfigActionStatus(error instanceof Error ? error.message : "Failed to reset app config.");
    } finally {
      setResetConfigBusy(false);
    }
  };

  const runSandboxDebugProbe = async () => {
    if (!isTauriRuntime() || sandboxProbeBusy()) return;
    setSandboxProbeBusy(true);
    setSandboxProbeStatus(null);
    try {
      const report = await sandboxDebugProbe();
      setSandboxProbeResult(report);
      if (report.ready) {
        setSandboxProbeStatus("Sandbox probe succeeded. Export the debug report for support.");
      } else {
        setSandboxProbeStatus(report.error?.trim() || "Sandbox probe completed with errors.");
      }
    } catch (error) {
      setSandboxProbeStatus(error instanceof Error ? error.message : "Sandbox probe failed.");
    } finally {
      setSandboxProbeBusy(false);
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
      <div class="flex flex-wrap gap-2 rounded-2xl border border-gray-6/40 bg-gray-1/40 px-3 py-2">
        <div class="flex flex-wrap gap-2">
          <For each={availableTabs()}>
            {(tab) => (
              <button
                class={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
                  activeTab() === tab
                    ? "bg-gray-12/10 text-white border-gray-6/30"
                    : "text-gray-10 border-gray-6/50 hover:text-gray-12 hover:bg-gray-2/40"
                }`}
                onClick={() => props.setSettingsTab(tab)}
              >
                {resolveSettingsTabLabel(tab)}
              </button>
            )}
          </For>
        </div>
      </div>

      <Switch>
        <Match when={activeTab() === "general"}>
          <div class="space-y-6">
            <Show when={props.developerMode}>
              <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4">
                <div class="flex items-start justify-between gap-4">
                  <div>
                    <div class="flex items-center gap-2">
                      <PlugZap size={16} class="text-gray-11" />
                      <div class="text-sm font-medium text-gray-12">AI access</div>
                    </div>
                    <div class="text-xs text-gray-9 mt-1">Provider and model assignment is managed by the platform admin.</div>
                  </div>
                  <div class={`text-xs px-2 py-1 rounded-full border ${aiAccessStatusStyle()}`}>
                    {aiAccessStatusLabel()}
                  </div>
                </div>

                <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 px-4 py-3 space-y-3">
                  <div class="text-xs text-gray-10">{props.aiAccessMessage}</div>
                  <Show
                    when={props.aiAccessConfigured}
                    fallback={<div class="text-[11px] text-gray-8">Users can sign in, but prompts stay blocked until an admin assigns access.</div>}
                  >
                    <div class="grid gap-3 md:grid-cols-3">
                      <div class="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2">
                        <div class="text-[11px] uppercase tracking-wide text-gray-8">Provider</div>
                        <div class="text-sm font-medium text-gray-12 mt-1">{props.aiAccessProviderLabel ?? "Not assigned"}</div>
                      </div>
                      <div class="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2">
                        <div class="text-[11px] uppercase tracking-wide text-gray-8">Default model</div>
                        <div class="text-sm font-medium text-gray-12 mt-1">{props.aiAccessDefaultModelLabel ?? "Not assigned"}</div>
                      </div>
                      <div class="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2">
                        <div class="text-[11px] uppercase tracking-wide text-gray-8">Allowed models</div>
                        <div class="text-sm font-medium text-gray-12 mt-1">{aiAccessAllowedModelsSummary()}</div>
                      </div>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">Run preferences</div>
                <div class="text-xs text-gray-10">User-level display and thinking controls still apply to runs.</div>
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
                  {props.showThinking ? "On" : "Off"}
                </Button>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">Auto context compaction</div>
                  <div class="text-xs text-gray-7">Automatically compact after a run completes.</div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  disabled
                >
                  Always on
                </Button>
              </div>

              <div class="bg-gray-1 p-3 rounded-xl border border-gray-6 space-y-2">
                <div>
                  <div class="text-sm text-gray-12">{translate("session.thinking_effort")}</div>
                  <div class="text-xs text-gray-7">Default thinking mode for new sessions.</div>
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
                    <Show when={updateState() === "checking" || updateState() === "downloading"}>
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

        <Match when={activeTab() === "extensions"}>
          <ExtensionsOverview workspaces={props.workspaces} />
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
                        This workspace
                      </span>
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
                        <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 px-3 py-3 space-y-3">
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
                              class="text-xs h-8 py-0 px-3 shrink-0"
                              onClick={() => void handleUnarchiveArchivedSession(item.sessionId)}
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
              <div class="text-sm font-medium text-gray-12">Connection</div>
              <div class="text-xs text-gray-9">{props.headerStatus}</div>
              <div class="text-xs text-gray-8 font-mono break-all">{props.baseUrl}</div>
              <div class="space-y-2 rounded-xl border border-gray-6/70 bg-gray-1/50 p-3">
                <div class="text-xs text-gray-11">Browser sign-in endpoint</div>
                <div class="text-[11px] text-gray-8">
                  Used by the desktop sign-in flow and handoff exchange. Leave blank and Save to use the default.
                </div>
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
                    Save
                  </Button>
                </div>
                <div class="text-[11px] text-gray-8">
                  Active endpoint: <span class="font-mono break-all text-gray-10">{activeDenApiBase()}</span>
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
                  <div class="text-xs text-gray-11">Keep me signed in</div>
                  <div class="text-[11px] text-gray-8">If off, Veslo asks for sign-in on each launch.</div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-9 py-0 px-3 shrink-0"
                  onClick={props.toggleDenKeepSignedIn}
                  disabled={props.busy}
                >
                  {props.denKeepSignedIn ? "On" : "Off"}
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
                  {props.vesloReconnectBusy ? "Reconnecting..." : "Reconnect server"}
                </button>
                <Show when={isLocalEngineRunning()}>
                  <button
                    type="button"
                    class={compactOutlineActionClass}
                    onClick={handleRestartLocalServer}
                    disabled={props.busy || vesloRestartBusy()}
                  >
                    <RefreshCcw size={14} class={`text-dls-secondary ${vesloRestartBusy() ? "animate-spin" : ""}`} />
                    {vesloRestartBusy() ? "Restarting..." : "Restart local server"}
                  </button>
                </Show>
                <Show when={isLocalEngineRunning()}>
                  <button
                    type="button"
                    class={compactDangerActionClass}
                    onClick={props.stopHost}
                    disabled={props.busy}
                  >
                    <CircleAlert size={14} />
                    Stop local server
                  </button>
                </Show>
                <Show when={!isLocalEngineRunning() && props.vesloServerStatus === "connected"}>
                  <button
                    type="button"
                    class={compactOutlineActionClass}
                    onClick={props.stopHost}
                    disabled={props.busy}
                  >
                    Disconnect server
                  </button>
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
                        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
                          <div class="space-y-0.5">
                            <div class="text-sm text-gray-12">{translate("settings.automatic_checks_label")}</div>
                            <div class="text-xs text-gray-7">{translate("settings.automatic_checks_hint")}</div>
                          </div>
                          <button
                            class={`min-w-[70px] px-4 py-1.5 rounded-full text-xs font-medium border shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition-colors ${
                              props.updateAutoCheck
                                ? "bg-gray-12/12 text-gray-12 border-gray-6/30"
                                : "bg-gray-1/70 text-gray-10 border-gray-6/60 hover:text-gray-12 hover:bg-gray-2/70"
                            }`}
                            onClick={props.toggleUpdateAutoCheck}
                          >
                            {props.updateAutoCheck ? translate("settings.on") : translate("settings.off")}
                          </button>
                        </div>

                        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
                          <div class="space-y-0.5">
                            <div class="text-sm text-gray-12">{translate("settings.auto_update_label")}</div>
                            <div class="text-xs text-gray-7">{translate("settings.auto_update_hint")}</div>
                          </div>
                          <button
                            class={`min-w-[70px] px-4 py-1.5 rounded-full text-xs font-medium border shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition-colors ${
                              props.updateAutoDownload
                                ? "bg-gray-12/12 text-gray-12 border-gray-6/30"
                                : "bg-gray-1/70 text-gray-10 border-gray-6/60 hover:text-gray-12 hover:bg-gray-2/70"
                            }`}
                            onClick={props.toggleUpdateAutoDownload}
                          >
                            {props.updateAutoDownload ? translate("settings.on") : translate("settings.off")}
                          </button>
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

          </div>
        </Match>

        <Match when={activeTab() === "debug"}>
          <Show when={props.developerMode}>
            <section>
              <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider mb-4">Developer</h3>

              <div class="space-y-4">
                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">Runtime debug report</div>
                      <div class="text-xs text-gray-10">Readable diagnostics snapshot with one-click export.</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Button variant="outline" class="text-xs h-8 py-0 px-3" onClick={copyRuntimeDebugReport}>
                        <Copy size={13} class="mr-1.5" />
                        Copy JSON
                      </Button>
                      <Button variant="secondary" class="text-xs h-8 py-0 px-3" onClick={exportRuntimeDebugReport}>
                        <Download size={13} class="mr-1.5" />
                        Export
                      </Button>
                    </div>
                  </div>
                  <div class="grid gap-2 md:grid-cols-2 text-xs text-gray-11">
                    <div>Desktop app: {appVersionLabel()}</div>
                    <div>Commit: {appCommitLabel()}</div>
                    <div>Orchestrator: {orchestratorVersionLabel()}</div>
                    <div>OpenCode: {opencodeVersionLabel()}</div>
                    <div>Veslo server: {vesloServerVersionLabel()}</div>
                    <div>OpenCodeRouter: {opencodeRouterVersionLabel()}</div>
                  </div>
                  <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto bg-gray-1 border border-gray-6 rounded-lg p-3">
                    {runtimeDebugReportJson()}
                  </pre>
                  <Show when={debugReportStatus()}>
                    {(status) => <div class="text-xs text-gray-10">{status()}</div>}
                  </Show>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">Sandbox probe</div>
                      <div class="text-xs text-gray-10">
                        Runs a temporary Docker sandbox startup check and captures inspect/log output.
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      class="text-xs h-8 py-0 px-3"
                      onClick={runSandboxDebugProbe}
                      disabled={!isTauriRuntime() || sandboxProbeBusy() || props.anyActiveRuns}
                      title={
                        !isTauriRuntime()
                          ? "Sandbox probe requires desktop app"
                          : props.anyActiveRuns
                            ? "Stop active runs before probing"
                            : ""
                      }
                    >
                      {sandboxProbeBusy() ? "Running probe..." : "Run sandbox probe"}
                    </Button>
                  </div>
                  <Show when={sandboxProbeResult()}>
                    {(result) => (
                      <div class="text-xs text-gray-11 space-y-1">
                        <div>Run ID: <span class="font-mono">{result().runId}</span></div>
                        <div>Result: {result().ready ? "ready" : "error"}</div>
                        <Show when={result().error}>
                          {(err) => <div class="text-red-11">{err()}</div>}
                        </Show>
                      </div>
                    )}
                  </Show>
                  <Show when={sandboxProbeStatus()}>
                    {(status) => <div class="text-xs text-gray-10">{status()}</div>}
                  </Show>
                  <div class="text-[11px] text-gray-7">
                    Use <strong>Export</strong> in Runtime debug report above to save this probe output with logs.
                  </div>
                </div>

                <Show when={!CLOUD_ONLY_MODE}>
                  <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                    <div class="text-sm font-medium text-gray-12">Workspace config</div>
                    <div class="text-xs text-gray-10">Reveal or reset `.opencode/veslo.json` defaults for this app workspace.</div>
                    <div class="text-[11px] text-gray-7 font-mono break-all">{workspaceConfigPath() || "No active worker."}</div>
                    <div class="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={revealWorkspaceConfig}
                        disabled={!isTauriRuntime() || revealConfigBusy() || !workspaceConfigPath()}
                        title={!isTauriRuntime() ? "Reveal config requires the desktop app" : ""}
                      >
                        <FolderOpen size={13} class="mr-1.5" />
                        {revealConfigBusy() ? "Opening..." : "Reveal config"}
                      </Button>
                      <Button
                        variant="danger"
                        class="text-xs h-8 py-0 px-3"
                        onClick={resetAppConfigDefaults}
                        disabled={resetConfigBusy() || props.anyActiveRuns}
                        title={props.anyActiveRuns ? "Stop active runs before resetting config" : ""}
                      >
                        {resetConfigBusy() ? "Resetting..." : "Reset config defaults"}
                      </Button>
                    </div>
                    <Show when={configActionStatus()}>
                      {(status) => <div class="text-xs text-gray-10">{status()}</div>}
                    </Show>
                  </div>
                </Show>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">OpenCode cache</div>
                    <div class="text-xs text-gray-7">
                      Repairs cached data used to start the engine. Safe to run.
                    </div>
                    <Show when={props.cacheRepairResult}>
                      <div class="text-xs text-gray-11 mt-2">{props.cacheRepairResult}</div>
                    </Show>
                  </div>
                  <Button
                    variant="secondary"
                    class="text-xs h-8 py-0 px-3 shrink-0"
                    onClick={props.repairOpencodeCache}
                    disabled={props.cacheRepairBusy || !isTauriRuntime()}
                    title={isTauriRuntime() ? "" : "Cache repair requires the desktop app"}
                  >
                    {props.cacheRepairBusy ? "Repairing cache" : "Repair cache"}
                  </Button>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">Veslo Docker containers</div>
                    <div class="text-xs text-gray-7">
                      Force-remove Docker containers launched by Veslo (sandbox + local dev stacks).
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
                        ? "Docker cleanup requires the desktop app"
                        : props.anyActiveRuns
                          ? "Stop active runs before cleanup"
                          : ""
                    }
                  >
                    {props.dockerCleanupBusy ? "Removing containers..." : "Delete containers"}
                  </Button>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="text-sm font-medium text-gray-12">Startup</div>

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
                      Reconnect
                    </Button>
                  </div>

                  <p class="text-xs text-gray-7">
                    This build is cloud-only. Local host mode is disabled.
                  </p>
                </div>

                <Show when={isTauriRuntime() && props.developerMode && !CLOUD_ONLY_MODE}>
                  <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                    <div>
                      <div class="text-sm font-medium text-gray-12">Engine</div>
                      <div class="text-xs text-gray-10">Choose how OpenCode runs locally.</div>
                    </div>

                    <div class="space-y-3">
                      <div class="text-xs text-gray-10">Engine source</div>
                      <div class={props.developerMode ? "grid grid-cols-3 gap-2" : "grid grid-cols-2 gap-2"}>
                        <Button
                          variant={props.engineSource === "sidecar" ? "secondary" : "outline"}
                          onClick={() => props.setEngineSource("sidecar")}
                          disabled={props.busy}
                        >
                          Bundled (recommended)
                        </Button>
                        <Button
                          variant={props.engineSource === "path" ? "secondary" : "outline"}
                          onClick={() => props.setEngineSource("path")}
                          disabled={props.busy}
                        >
                          System install (PATH)
                        </Button>
                        <Show when={props.developerMode}>
                          <Button
                            variant={props.engineSource === "custom" ? "secondary" : "outline"}
                            onClick={() => props.setEngineSource("custom")}
                            disabled={props.busy}
                          >
                            Custom binary
                          </Button>
                        </Show>
                      </div>
                      <div class="text-[11px] text-gray-7">
                        Bundled engine is the most reliable option. Use System install only if you manage OpenCode yourself.
                      </div>
                    </div>

                    <Show when={props.developerMode && props.engineSource === "custom"}>
                      <div class="space-y-2">
                        <div class="text-xs text-gray-10">Custom OpenCode binary</div>
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
                            Choose
                          </Button>
                          <Button
                            variant="outline"
                            class="text-xs h-10 px-3 shrink-0"
                            onClick={() => props.setEngineCustomBinPath("")}
                            disabled={props.busy || !props.engineCustomBinPath.trim()}
                            title={!props.engineCustomBinPath.trim() ? "No custom path set" : "Clear"}
                          >
                            Clear
                          </Button>
                        </div>
                        <div class="text-[11px] text-gray-7">
                          Use this to point Veslo at a local OpenCode build (e.g. your fork). Applies next time the engine starts or reloads.
                        </div>
                      </div>
                    </Show>

                    <Show when={props.developerMode}>
                      <div class="space-y-3">
                        <div class="text-xs text-gray-10">Engine runtime</div>
                        <div class="grid grid-cols-2 gap-2">
                          <Button
                            variant={props.engineRuntime === "direct" ? "secondary" : "outline"}
                            onClick={() => props.setEngineRuntime("direct")}
                            disabled={props.busy}
                          >
                            Direct (OpenCode)
                          </Button>
                          <Button
                            variant={props.engineRuntime === "veslo-orchestrator" ? "secondary" : "outline"}
                            onClick={() => props.setEngineRuntime("veslo-orchestrator")}
                            disabled={props.busy}
                          >
                            Veslo Orchestrator
                          </Button>
                        </div>
                        <div class="text-[11px] text-gray-7">Applies the next time the engine starts or reloads.</div>
                      </div>
                    </Show>
                  </div>
                </Show>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-gray-12">Reset & Recovery</div>
                    <div class="text-xs text-gray-10">Clear data or restart the setup flow.</div>
                  </div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-gray-12">Reset onboarding</div>
                      <div class="text-xs text-gray-7">Clears Veslo preferences and restarts the app.</div>
                    </div>
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={() => props.openResetModal("onboarding")}
                      disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
                      title={props.anyActiveRuns ? "Stop active runs to reset" : ""}
                    >
                      Reset
                    </Button>
                  </div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-gray-12">Reset app data</div>
                      <div class="text-xs text-gray-7">More aggressive. Clears Veslo cache + app data.</div>
                    </div>
                    <Button
                      variant="danger"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={() => props.openResetModal("all")}
                      disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
                      title={props.anyActiveRuns ? "Stop active runs to reset" : ""}
                    >
                      Reset
                    </Button>
                  </div>

                  <div class="text-xs text-gray-7">
                    Requires typing <span class="font-mono text-gray-11">RESET</span> and will restart the app.
                  </div>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-gray-12">Devtools</div>
                    <div class="text-xs text-gray-10">Sidecar health, capabilities, and audit trail.</div>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">Service restarts</div>
                      <div class="text-xs text-gray-10">Restart specific host services without leaving this screen.</div>
                    </div>
                    <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                      <Button
                        variant="secondary"
                        onClick={handleRestartLocalServer}
                        disabled={props.busy || vesloRestartBusy() || !isTauriRuntime()}
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw class={`w-3.5 h-3.5 mr-1.5 ${vesloRestartBusy() ? "animate-spin" : ""}`} />
                        {vesloRestartBusy() ? "Restarting..." : "Restart orchestrator"}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleOpenCodeRestart}
                        disabled={opencodeRestarting() || !isTauriRuntime()}
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw class={`w-3.5 h-3.5 mr-1.5 ${opencodeRestarting() ? "animate-spin" : ""}`} />
                        {opencodeRestarting() ? "Restarting..." : "Restart OpenCode"}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleVesloServerRestart}
                        disabled={vesloServerRestarting() || !isTauriRuntime()}
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw class={`w-3.5 h-3.5 mr-1.5 ${vesloServerRestarting() ? "animate-spin" : ""}`} />
                        {vesloServerRestarting() ? "Restarting..." : "Restart Veslo server"}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleOpenCodeRouterRestart}
                        disabled={opencodeRouterRestarting() || !isTauriRuntime()}
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw class={`w-3.5 h-3.5 mr-1.5 ${opencodeRouterRestarting() ? "animate-spin" : ""}`} />
                        {opencodeRouterRestarting() ? "Restarting..." : "Restart OpenCodeRouter"}
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
                        <div class="text-sm font-medium text-gray-12">Versions</div>
                        <div class="text-xs text-gray-10">Sidecar + desktop build info.</div>
                      </div>
                        <div class="space-y-1">
                          <div class="text-[11px] text-gray-7 font-mono truncate">Desktop app: {appVersionLabel()}</div>
                          <div class="text-[11px] text-gray-7 font-mono truncate">Commit: {appCommitLabel()}</div>
                          <div class="text-[11px] text-gray-7 font-mono truncate">Orchestrator: {orchestratorVersionLabel()}</div>
                          <div class="text-[11px] text-gray-7 font-mono truncate">OpenCode: {opencodeVersionLabel()}</div>
                          <div class="text-[11px] text-gray-7 font-mono truncate">
                            Veslo server: {vesloServerVersionLabel()}
                          </div>
                          <div class="text-[11px] text-gray-7 font-mono truncate">OpenCodeRouter: {opencodeRouterVersionLabel()}</div>
                        </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">OpenCode engine</div>
                          <div class="text-xs text-gray-10">Local execution sidecar.</div>
                        </div>
                        <div class={`text-xs px-2 py-1 rounded-full border ${engineStatusStyle()}`}>
                          {engineStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.engineInfo?.baseUrl ?? "Base URL unavailable"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.engineInfo?.projectDir ?? "No project directory"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">PID: {props.engineInfo?.pid ?? "—"}</div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">Last stdout</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {engineStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">Last stderr</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {engineStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="font-product type-ui-md font-medium text-gray-12">Orchestrator daemon</div>
                          <div class="font-reading type-ui-sm text-gray-10">Workspace orchestration layer.</div>
                        </div>
                        <div class={`font-product type-ui-xs px-2 py-1 rounded-full border ${orchestratorStatusStyle()}`}>
                          {orchestratorStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.orchestratorStatus?.dataDir ?? "Data directory unavailable"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          Daemon: {props.orchestratorStatus?.daemon?.baseUrl ?? "—"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          OpenCode: {props.orchestratorStatus?.opencode?.baseUrl ?? "—"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          Version: {props.orchestratorStatus?.cliVersion ?? "—"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          Sidecar: {orchestratorSidecarSummary()}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate" title={orchestratorBinaryPath()}>
                          Opencode binary: {formatOrchestratorBinary(props.orchestratorStatus?.binaries?.opencode ?? null)}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          Active workspace: {props.orchestratorStatus?.activeId ?? "—"}
                        </div>
                      </div>
                      <Show when={props.orchestratorStatus?.lastError}>
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">Last error</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {props.orchestratorStatus?.lastError}
                          </pre>
                        </div>
                      </Show>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="font-product type-ui-md font-medium text-gray-12">OpenCode SDK</div>
                          <div class="font-reading type-ui-sm text-gray-10">UI connection diagnostics.</div>
                        </div>
                        <div class={`font-product type-ui-xs px-2 py-1 rounded-full border ${opencodeConnectStatusStyle()}`}>
                          {opencodeConnectStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.opencodeConnectStatus?.baseUrl ?? "Base URL unavailable"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.opencodeConnectStatus?.directory ?? "No project directory"}
                        </div>
                        <div class="font-product type-ui-xs text-gray-7">
                          Last attempt: {opencodeConnectTimestamp() ?? "—"}
                        </div>
                        <Show when={props.opencodeConnectStatus?.reason}>
                          <div class="font-product type-ui-xs text-gray-7">Reason: {props.opencodeConnectStatus?.reason}</div>
                        </Show>
                        <Show when={props.opencodeConnectStatus?.metrics}>
                          {(metrics) => (
                            <div class="font-product type-ui-xs pt-1 space-y-1 text-gray-7">
                              <Show when={metrics().healthyMs != null}>
                                <div>Healthy: {Math.round(metrics().healthyMs as number)}ms</div>
                              </Show>
                              <Show when={metrics().loadSessionsMs != null}>
                                <div>Load sessions: {Math.round(metrics().loadSessionsMs as number)}ms</div>
                              </Show>
                              <Show when={metrics().pendingPermissionsMs != null}>
                                <div>
                                  Pending permissions: {Math.round(metrics().pendingPermissionsMs as number)}ms
                                </div>
                              </Show>
                              <Show when={metrics().providersMs != null}>
                                <div>Providers: {Math.round(metrics().providersMs as number)}ms</div>
                              </Show>
                              <Show when={metrics().totalMs != null}>
                                <div>Total: {Math.round(metrics().totalMs as number)}ms</div>
                              </Show>
                            </div>
                          )}
                        </Show>
                      </div>
                      <Show when={props.opencodeConnectStatus?.error}>
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">Last error</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {props.opencodeConnectStatus?.error}
                          </pre>
                        </div>
                      </Show>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="font-product type-ui-md font-medium text-gray-12">Veslo server</div>
                          <div class="font-reading type-ui-sm text-gray-10">Config and approvals sidecar.</div>
                        </div>
                        <div class={`font-product type-ui-xs px-2 py-1 rounded-full border ${vesloStatusStyle()}`}>
                          {vesloStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {(props.vesloServerHostInfo?.baseUrl ?? props.vesloServerUrl) || "Base URL unavailable"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">PID: {props.vesloServerHostInfo?.pid ?? "—"}</div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">Last stdout</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {vesloStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">Last stderr</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {vesloStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="font-product type-ui-md font-medium text-gray-12">OpenCodeRouter sidecar</div>
                          <div class="font-reading type-ui-sm text-gray-10">Bridge runtime (currently hidden from end-user UI).</div>
                        </div>
                        <div class={`font-product type-ui-xs px-2 py-1 rounded-full border ${opencodeRouterStatusStyle()}`}>
                          {opencodeRouterStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.opencodeRouterInfo?.opencodeUrl?.trim() || "OpenCode URL unavailable"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          {props.opencodeRouterInfo?.workspacePath?.trim() || "No worker directory"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">
                          Health port: {props.opencodeRouterInfo?.healthPort ?? "—"}
                        </div>
                        <div class="font-mono type-ui-xs text-gray-7 truncate">PID: {props.opencodeRouterInfo?.pid ?? "—"}</div>
                      </div>
                      <div class="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          onClick={handleOpenCodeRouterRestart}
                          disabled={opencodeRouterRestarting() || !isTauriRuntime()}
                          class="text-xs px-3 py-1.5"
                        >
                          <RefreshCcw class={`w-3.5 h-3.5 mr-1.5 ${opencodeRouterRestarting() ? "animate-spin" : ""}`} />
                          {opencodeRouterRestarting() ? "Restarting..." : "Restart"}
                        </Button>
                        <Show when={props.opencodeRouterInfo?.running}>
                          <Button
                            variant="ghost"
                            onClick={handleOpenCodeRouterStop}
                            disabled={opencodeRouterRestarting()}
                            class="text-xs px-3 py-1.5"
                          >
                            Stop
                          </Button>
                        </Show>
                      </div>
                      <Show when={opencodeRouterRestartError()}>
                        <div class="font-product type-ui-sm text-red-11 bg-red-3/50 border border-red-6 rounded-lg p-2">
                          {opencodeRouterRestartError()}
                        </div>
                      </Show>
                      <div class="grid gap-2">
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">Last stdout</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {opencodeRouterStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="font-product type-ui-xs text-gray-9 mb-1">Last stderr</div>
                          <pre class="font-mono type-ui-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {opencodeRouterStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="font-product type-ui-md font-medium text-gray-12">Veslo server diagnostics</div>
                      <div class="font-mono type-ui-xs text-gray-8 truncate">
                        {props.vesloServerDiagnostics?.version ?? "—"}
                      </div>
                    </div>
                    <Show
                      when={props.vesloServerDiagnostics}
                      fallback={<div class="font-product type-ui-sm text-gray-9">Diagnostics unavailable.</div>}
                    >
                      {(diag) => (
                        <div class="font-product type-ui-sm grid md:grid-cols-2 gap-2 text-gray-11">
                          <div>Started: {formatUptime(diag().uptimeMs)}</div>
                          <div>Read-only: {diag().readOnly ? "true" : "false"}</div>
                          <div>
                            Approval: {diag().approval.mode} ({diag().approval.timeoutMs}ms)
                          </div>
                          <div>Workspaces: {diag().workspaceCount}</div>
                          <div>Active workspace: {diag().activeWorkspaceId ?? "—"}</div>
                          <div>Config path: {diag().server.configPath ?? "default"}</div>
                          <div>Token source: {diag().tokenSource.client}</div>
                          <div>Host token source: {diag().tokenSource.host}</div>
                        </div>
                      )}
                    </Show>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="font-product type-ui-md font-medium text-gray-12">Veslo server capabilities</div>
                      <div class="font-mono type-ui-xs text-gray-8 truncate">
                        {props.vesloServerWorkspaceId ? `Worker ${props.vesloServerWorkspaceId}` : "Worker unresolved"}
                      </div>
                    </div>
                    <Show
                      when={props.vesloServerCapabilities}
                      fallback={<div class="font-product type-ui-sm text-gray-9">Capabilities unavailable. Connect with a client token.</div>}
                    >
                      {(caps) => (
                        <div class="font-product type-ui-sm grid md:grid-cols-2 gap-2 text-gray-11">
                          <div>Skills: {formatCapability(caps().skills)}</div>
                          <div>Plugins: {formatCapability(caps().plugins)}</div>
                          <div>MCP: {formatCapability(caps().mcp)}</div>
                          <div>Commands: {formatCapability(caps().commands)}</div>
                          <div>Config: {formatCapability(caps().config)}</div>
                          <div>Proxy (OpenCodeRouter): {caps().proxy?.opencodeRouter ? "enabled" : "disabled"}</div>
                          <div>
                            Browser tools: {(() => {
                              const browser = caps().toolProviders?.browser;
                              if (!browser?.enabled) return "disabled";
                              return `${browser.mode} · ${browser.placement}`;
                            })()}
                          </div>
                          <div>
                            File tools: {(() => {
                              const files = caps().toolProviders?.files;
                              if (!files) return "Unavailable";
                              const parts = [files.injection ? "inbox on" : "inbox off", files.outbox ? "outbox on" : "outbox off"];
                              return parts.join(" · ");
                            })()}
                          </div>
                          <div>
                            Sandbox: {(() => {
                              const sandbox = caps().sandbox;
                              return sandbox
                                ? `${sandbox.backend} (${sandbox.enabled ? "on" : "off"})`
                                : "Unavailable";
                            })()}
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>

                  <div class="grid md:grid-cols-2 gap-4">
                    <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                      <div class="text-xs text-gray-10 mb-2">Pending permissions</div>
                      <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                        {props.safeStringify(props.pendingPermissions)}
                      </pre>
                    </div>
                    <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                      <div class="text-xs text-gray-10 mb-2">Recent events</div>
                      <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                        {props.safeStringify(props.events)}
                      </pre>
                    </div>
                  </div>

                  <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                    <div class="flex items-center justify-between gap-3 mb-2">
                      <div class="text-xs text-gray-10">Workspace debug events</div>
                      <Button
                        variant="outline"
                        class="text-xs h-7 py-0 px-2 shrink-0"
                        onClick={props.clearWorkspaceDebugEvents}
                        disabled={props.busy}
                      >
                        Clear
                      </Button>
                    </div>
                    <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                      {props.safeStringify(props.workspaceDebugEvents)}
                    </pre>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-sm font-medium text-gray-12">Audit log</div>
                      <div class={`text-xs px-2 py-1 rounded-full border ${vesloAuditStatusStyle()}`}>
                        {vesloAuditStatusLabel()}
                      </div>
                    </div>
                    <Show when={props.vesloAuditError}>
                      <div class="text-xs text-red-11">{props.vesloAuditError}</div>
                    </Show>
                    <Show
                      when={props.vesloAuditEntries.length > 0}
                      fallback={<div class="text-xs text-gray-9">No audit entries yet.</div>}
                    >
                      <div class="divide-y divide-gray-6/50">
                        <For each={props.vesloAuditEntries}>
                          {(entry) => (
                            <div class="flex items-start justify-between gap-4 py-2">
                              <div class="min-w-0">
                                <div class="text-sm text-gray-12 truncate">{entry.summary}</div>
                                <div class="text-[11px] text-gray-9 truncate">
                                  {entry.action} · {entry.target} · {formatActor(entry)}
                                </div>
                              </div>
                              <div class="text-[11px] text-gray-9 whitespace-nowrap">
                                {entry.timestamp ? formatRelativeTime(entry.timestamp) : "—"}
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
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
