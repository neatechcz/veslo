import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type {
  DashboardTab,
  McpServerEntry,
  McpStatusMap,
  OpencodeConnectStatus,
  PluginScope,
  SettingsTab,
  SessionArchiveItem,
  ScheduledJob,
  SidebarSubagentDecoration,
  HubMcpCard,
  HubSkillCard,
  SkillCard,
  StartupPreference,
  LoadedSessionPrefetchInterestChangeHandler,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
  View,
} from "../types";
import type { McpDirectoryInfo } from "../constants";
import {
  formatRelativeTime,
  getWorkspaceTaskLoadErrorDisplay,
  isTauriRuntime,
  isWindowsPlatform,
  normalizeDirectoryPath,
} from "../utils";
import {
  buildVesloConnectInviteUrl,
  buildVesloWorkspaceBaseUrl,
  createVesloServerClient,
  parseVesloWorkspaceIdFromUrl,
} from "../lib/veslo-server";
import type {
  VesloAuditEntry,
  VesloSoulHeartbeatEntry,
  VesloSoulStatus,
  VesloServerClient,
  VesloServerCapabilities,
  VesloServerDiagnostics,
  VesloWorkspaceExport,
  VesloServerSettings,
  VesloServerStatus,
} from "../lib/veslo-server";
import {
  type EngineInfo,
  type OpenCodeRouterInfo,
  type OrchestratorStatus,
  type VesloServerInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { acquireBlankNativeWindowTitleLease } from "../lib/native-window-title-lease";
import { DEFAULT_VESLO_PUBLISHER_BASE_URL, publishVesloBundleJson } from "../lib/publisher";

import Button from "../components/button";
import ExtensionsView from "./extensions";
import ScheduledTasksView from "./scheduled";
import SoulView from "./soul";
import ConfigView from "./config";
import SettingsView from "./settings";
import SkillsView from "./skills";
import SidebarStatusControls from "../components/sidebar-status-controls";
import ShareWorkspaceModal from "../components/share-workspace-modal";
import SidebarAdvancedNav from "../components/session/sidebar-advanced-nav";
import SidebarDashboardNav from "../components/session/sidebar-dashboard-nav";
import WorkspaceSessionList from "../components/session/workspace-session-list";
import TitlebarMenuToggles from "../components/titlebar-menu-toggles";
import {
  clampLeftSidebarWidth,
  readLeftSidebarWidth,
  writeLeftSidebarWidth,
} from "../components/layout/left-sidebar-width-prefs";
import { openSessionWithWorkspaceActivation } from "./session-navigation";
import {
  resolveDashboardTabSelectionAction,
  resolveLeftMenuAction,
  shouldReturnToSessionOnEscape,
} from "./dashboard-menu-navigation";
import {
  ArrowLeft,
  Box,
  ChevronDown,
  ChevronRight,
  Circle,
  History,
  HeartPulse,
  Loader2,
  MoreHorizontal,
  Plus,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Zap,
} from "lucide-solid";
import { currentLocale, t } from "../../i18n";
import type { Language } from "../../i18n";

export type DashboardViewProps = {
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  onOpenFeedback: () => void;
  view: View;
  setView: (view: View, sessionId?: string) => void;
  startupPreference: StartupPreference | null;
  baseUrl: string;
  clientConnected: boolean;
  authenticatedUser: string | null;
  onLogout: () => Promise<void> | void;
  onSignIn: () => Promise<void> | void;
  busy: boolean;
  busyHint: string | null;
  busyLabel: string | null;
  newTaskDisabled: boolean;
  headerStatus: string;
  error: string | null;
  vesloServerStatus: VesloServerStatus;
  vesloServerUrl: string;
  vesloServerClient: VesloServerClient | null;
  vesloReconnectBusy: boolean;
  reconnectVesloServer: () => Promise<boolean>;
  vesloServerSettings: VesloServerSettings;
  vesloServerHostInfo: VesloServerInfo | null;
  vesloServerCapabilities: VesloServerCapabilities | null;
  vesloServerDiagnostics: VesloServerDiagnostics | null;
  vesloServerWorkspaceId: string | null;
  vesloAuditEntries: VesloAuditEntry[];
  vesloAuditStatus: "idle" | "loading" | "error";
  vesloAuditError: string | null;
  opencodeConnectStatus: OpencodeConnectStatus | null;
  engineInfo: EngineInfo | null;
  engineDoctorVersion: string | null;
  orchestratorStatus: OrchestratorStatus | null;
  opencodeRouterInfo: OpenCodeRouterInfo | null;
  updateVesloServerSettings: (next: VesloServerSettings) => void;
  resetVesloServerSettings: () => void;
  testVesloServerConnection: (next: VesloServerSettings) => Promise<boolean>;
  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;
  workspaceAutoReloadAvailable: boolean;
  workspaceAutoReloadEnabled: boolean;
  setWorkspaceAutoReloadEnabled: (value: boolean) => void | Promise<void>;
  workspaceAutoReloadResumeEnabled: boolean;
  setWorkspaceAutoReloadResumeEnabled: (value: boolean) => void | Promise<void>;
  activeWorkspaceDisplay: WorkspaceInfo;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  recoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean;
  openCreateWorkspace: () => void;
  openCreateRemoteWorkspace: () => void;
  openNewSessionWithDirectory: () => void;
  openDirectorySessionFromPicker: () => void;
  openPendingDirectoryDraftInWorkspace: (workspaceId: string) => void;
  importWorkspaceConfig: () => void;
  importingWorkspaceConfig: boolean;
  exportWorkspaceConfig: (workspaceId?: string) => void;
  exportWorkspaceBusy: boolean;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  workspaceSessionPagingById: Record<string, { hasMore: boolean; loadingMore: boolean }>;
  subagentDecorationsBySessionId: Record<string, SidebarSubagentDecoration>;
  archivedSessionIds: string[];
  archiveSession: (workspaceId: string, sessionId: string) => Promise<void> | void;
  unarchiveSession: (workspaceId: string, sessionId: string) => Promise<void> | void;
  loadMoreWorkspaceSidebarSessions: (workspaceId: string) => Promise<void> | void;
  selectedSessionId: string | null;
  lastWorkspaceSessionId: string | null;
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean;
  openRenameWorkspace: (workspaceId: string) => void;
  editWorkspaceConnection: (workspaceId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
  stopSandbox: (workspaceId: string) => void;
  scheduledJobs: ScheduledJob[];
  scheduledJobsSource: "local" | "remote";
  scheduledJobsSourceReady: boolean;
  schedulerPluginInstalled: boolean;
  scheduledJobsStatus: string | null;
  scheduledJobsBusy: boolean;
  scheduledJobsUpdatedAt: number | null;
  refreshScheduledJobs: (options?: { force?: boolean }) => void;
  deleteScheduledJob: (name: string) => Promise<void> | void;
  soulStatusByWorkspaceId: Record<string, VesloSoulStatus | null>;
  activeSoulStatus: VesloSoulStatus | null;
  activeSoulHeartbeats: VesloSoulHeartbeatEntry[];
  soulStatusBusy: boolean;
  soulHeartbeatsBusy: boolean;
  soulError: string | null;
  refreshSoulData: (options?: { force?: boolean }) => void;
  runSoulPrompt: (prompt: string) => void;
  activeWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  refreshSkills: (options?: { force?: boolean }) => void;
  refreshHubSkills: (options?: { force?: boolean }) => void;
  refreshPlugins: (scopeOverride?: PluginScope) => void;
  refreshMcpServers: () => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  hubMcpCards: HubMcpCard[];
  hubMcpStatus: string | null;
  skillsAccessHint?: string | null;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  importLocalSkill: () => void;
  installSkillCreator: () => Promise<{ ok: boolean; message: string }>;
  installHubSkill: (name: string) => Promise<{ ok: boolean; message: string }>;
  refreshHubMcp: () => void;
  installHubMcp: (name: string) => Promise<{ ok: boolean; message: string }>;
  revealSkillsFolder: () => void;
  uninstallSkill: (name: string) => void;
  readSkill: (name: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkill: (input: { name: string; content: string; description?: string }) => void;
  pluginsAccessHint?: string | null;
  canEditPlugins: boolean;
  canUseGlobalPluginScope: boolean;
  pluginScope: PluginScope;
  setPluginScope: (scope: PluginScope) => void;
  pluginConfigPath: string | null;
  pluginList: string[];
  pluginInput: string;
  setPluginInput: (value: string) => void;
  pluginStatus: string | null;
  activePluginGuide: string | null;
  setActivePluginGuide: (value: string | null) => void;
  isPluginInstalled: (name: string, aliases?: string[]) => boolean;
  suggestedPlugins: Array<{
    name: string;
    packageName: string;
    description: string;
    tags: string[];
    aliases?: string[];
    installMode?: "simple" | "guided";
    steps?: Array<{
      title: string;
      description: string;
      command?: string;
      url?: string;
      path?: string;
      note?: string;
    }>;
  }>;
  addPlugin: (pluginNameOverride?: string) => void;
  removePlugin: (pluginName: string) => void;
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  setSelectedMcp: (value: string | null) => void;
  quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => void;
  authorizeMcp: (entry: McpServerEntry) => void;
  logoutMcpAuth: (name: string) => Promise<void> | void;
  removeMcp: (name: string) => void;
  showMcpReloadBanner: boolean;
  mcpReloadBlocked: boolean;
  reloadMcpEngine: () => void;
  createSessionAndOpen: () => void;
  setPrompt: (value: string) => void;
  selectSession: (sessionId: string) => Promise<void> | void;
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
  updateAutoCheck: boolean;
  toggleUpdateAutoCheck: () => void;
  updateAutoDownload: boolean;
  toggleUpdateAutoDownload: () => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  denKeepSignedIn: boolean;
  toggleDenKeepSignedIn: () => void;
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
  engineSource: "path" | "sidecar" | "custom";
  setEngineSource: (value: "path" | "sidecar" | "custom") => void;
  engineCustomBinPath: string;
  setEngineCustomBinPath: (value: string) => void;
  engineRuntime: "direct" | "veslo-orchestrator";
  setEngineRuntime: (value: "direct" | "veslo-orchestrator") => void;
  isWindows: boolean;
  developerMode: boolean;
  stopHost: () => void;
  restartLocalServer: () => Promise<boolean>;
  openResetModal: (mode: "onboarding" | "all") => void;
  resetModalBusy: boolean;
  onResetStartupPreference: () => void;
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
  sessionArchives: SessionArchiveItem[];
  onUnarchiveArchivedSession: (sessionId: string) => Promise<void> | void;
};

type SidebarDockedVisibility = {
  left: boolean;
  right: boolean;
};

const SIDEBAR_DOCKED_VISIBILITY_KEY = "veslo.global.sidebar.docked.v1";
const LEGACY_SIDEBAR_DOCKED_VISIBILITY_KEY = "veslo.session.sidebar.docked.v1";
const DEFAULT_SIDEBAR_DOCKED_VISIBILITY: SidebarDockedVisibility = {
  left: true,
  right: true,
};

const readSidebarDockedVisibility = (): SidebarDockedVisibility => {
  if (typeof window === "undefined") return { ...DEFAULT_SIDEBAR_DOCKED_VISIBILITY };
  try {
    const raw = window.localStorage.getItem(SIDEBAR_DOCKED_VISIBILITY_KEY);
    const legacyRaw = !raw ? window.localStorage.getItem(LEGACY_SIDEBAR_DOCKED_VISIBILITY_KEY) : null;
    const value = raw ?? legacyRaw;
    if (!value) return { ...DEFAULT_SIDEBAR_DOCKED_VISIBILITY };
    const parsed = JSON.parse(value) as Partial<SidebarDockedVisibility> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SIDEBAR_DOCKED_VISIBILITY };
    const normalized = {
      left: typeof parsed.left === "boolean" ? parsed.left : DEFAULT_SIDEBAR_DOCKED_VISIBILITY.left,
      right: typeof parsed.right === "boolean" ? parsed.right : DEFAULT_SIDEBAR_DOCKED_VISIBILITY.right,
    };
    if (!raw && legacyRaw) {
      window.localStorage.setItem(SIDEBAR_DOCKED_VISIBILITY_KEY, JSON.stringify(normalized));
    }
    return normalized;
  } catch {
    return { ...DEFAULT_SIDEBAR_DOCKED_VISIBILITY };
  }
};

const writeSidebarDockedVisibility = (value: SidebarDockedVisibility) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SIDEBAR_DOCKED_VISIBILITY_KEY, JSON.stringify(value));
  } catch {
    // ignore
  }
};

type SharedSkillItem = {
  name: string;
  description?: string;
  content: string;
  trigger?: string;
};

type WorkspaceProfileBundleV1 = {
  schemaVersion: 1;
  type: "workspace-profile";
  name: string;
  description: string;
  workspace: VesloWorkspaceExport;
};

type SkillsSetBundleV1 = {
  schemaVersion: 1;
  type: "skills-set";
  name: string;
  description: string;
  skills: SharedSkillItem[];
  sourceWorkspace?: {
    id?: string;
    name?: string;
  };
};

export default function DashboardView(props: DashboardViewProps) {
  const title = createMemo(() => {
    switch (props.tab) {
      case "scheduled":
        return t("nav.automations", currentLocale());
      case "soul":
        return t("nav.soul", currentLocale());
      case "skills":
        return t("nav.skills", currentLocale());
      case "plugins":
        return t("nav.extensions", currentLocale());
      case "mcp":
        return t("nav.extensions", currentLocale());
      case "config":
        return t("nav.advanced", currentLocale());
      case "settings":
        return t("dashboard.settings", currentLocale());
      default:
        return t("nav.automations", currentLocale());
    }
  });
  let releaseNativeWindowTitleLease: (() => void) | null = null;

  onMount(() => {
    releaseNativeWindowTitleLease = acquireBlankNativeWindowTitleLease();
  });

  onCleanup(() => {
    releaseNativeWindowTitleLease?.();
  });

  const workspaceLabel = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.vesloWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    "Worker";
  const workspaceKindLabel = (workspace: WorkspaceInfo) =>
    workspace.workspaceType === "remote"
      ? workspace.sandboxBackend === "docker" ||
        Boolean(workspace.sandboxRunId?.trim()) ||
        Boolean(workspace.sandboxContainerName?.trim())
        ? "Sandbox"
        : "Remote"
      : "Local";

  const openSessionFromList = (workspaceId: string, sessionId: string) => {
    void openSessionWithWorkspaceActivation({
      activeWorkspaceId: props.activeWorkspaceId,
      getActiveWorkspaceId: () => props.activeWorkspaceId,
      workspaceId,
      sessionId,
      activateWorkspace: props.activateWorkspace,
      // Route-driven selection: navigate first and let the route effect own selectSession.
      openSession: (nextSessionId) => props.setView("session", nextSessionId),
    });
  };

  const resolveVesloWorkspaceId = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return null;
    const workspace =
      props.workspaces.find((item) => item.id === id) ??
      props.workspaceSessionGroups.find((group) => group.workspace.id === id)?.workspace;
    if (workspace?.workspaceType === "remote" && workspace.remoteType === "veslo") {
      return (
        workspace.vesloWorkspaceId?.trim() ||
        parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
        parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
        null
      );
    }
    return workspace?.vesloWorkspaceId?.trim() || null;
  };

  const reportLoadedSessionPrefetchInterest: LoadedSessionPrefetchInterestChangeHandler = (workspaceId, interest) => {
    const client = props.vesloServerClient;
    if (!client || props.vesloServerStatus !== "connected") return;
    const serverWorkspaceId = resolveVesloWorkspaceId(workspaceId);
    if (!serverWorkspaceId) return;

    void client.prefetchSessionTranscripts(serverWorkspaceId, interest).catch((error) => {
      console.warn("[dashboard.loaded-session-prefetch] failed", {
        workspaceId,
        serverWorkspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  // Track last refreshed tab to avoid duplicate calls
  const [lastRefreshedTab, setLastRefreshedTab] = createSignal<string | null>(null);
  const [refreshInProgress, setRefreshInProgress] = createSignal(false);
  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(null);
  const [leftSidebarWidth, setLeftSidebarWidth] = createSignal(readLeftSidebarWidth());
  const [leftSidebarResizing, setLeftSidebarResizing] = createSignal(false);
  const [sidebarDockedVisibility, setSidebarDockedVisibility] = createSignal(
    readSidebarDockedVisibility(),
  );

  const leftSidebarVisible = createMemo(() => sidebarDockedVisibility().left);
  const rightSidebarVisible = createMemo(() => sidebarDockedVisibility().right);

  const toggleSidebarMenu = (side: "left" | "right") => {
    setSidebarDockedVisibility((current) => {
      const next: SidebarDockedVisibility =
        side === "left"
          ? { left: !current.left, right: current.right }
          : { left: current.left, right: !current.right };
      writeSidebarDockedVisibility(next);
      return next;
    });
  };

  const leftSidebarStyle = createMemo(() => ({ width: `${leftSidebarWidth()}px` }));
  let leftSidebarResizeCleanup: (() => void) | null = null;
  const stopLeftSidebarResize = (persist: boolean) => {
    if (leftSidebarResizeCleanup) {
      leftSidebarResizeCleanup();
      leftSidebarResizeCleanup = null;
    }
    if (!leftSidebarResizing()) return;
    setLeftSidebarResizing(false);
    if (!persist) return;
    const normalized = writeLeftSidebarWidth(leftSidebarWidth());
    setLeftSidebarWidth(normalized);
  };

  const startLeftSidebarResize = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;
    event.preventDefault();
    event.stopPropagation();

    stopLeftSidebarResize(false);
    setLeftSidebarResizing(true);
    const initialWidth = leftSidebarWidth();
    const initialX = event.clientX;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - initialX;
      setLeftSidebarWidth(clampLeftSidebarWidth(initialWidth + delta));
    };
    const onPointerUp = () => stopLeftSidebarResize(true);
    const onPointerCancel = () => stopLeftSidebarResize(true);

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerCancel, { once: true });

    leftSidebarResizeCleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  };

  onCleanup(() => stopLeftSidebarResize(false));

  createEffect(() => {
    const currentTab = props.tab;

    // Skip if we already refreshed this tab or a refresh is in progress
    if (lastRefreshedTab() === currentTab || refreshInProgress()) {
      return;
    }

    // Track that we're refreshing this tab
    setRefreshInProgress(true);
    setLastRefreshedTab(currentTab);

    // Use a cancelled flag to prevent stale updates after navigation
    let cancelled = false;

    const doRefresh = async () => {
      try {
        if (currentTab === "skills" && !cancelled) {
          await props.refreshSkills();
        }
        if ((currentTab === "plugins" || currentTab === "mcp") && !cancelled) {
          await Promise.all([props.refreshPlugins(), props.refreshMcpServers()]);
        }
        if (currentTab === "scheduled" && !cancelled) {
          await props.refreshScheduledJobs();
        }
        if (currentTab === "soul" && !cancelled) {
          await props.refreshSoulData();
        }
      } catch {
        // Ignore errors during navigation
      } finally {
        if (!cancelled) {
          setRefreshInProgress(false);
        }
      }
    };

    doRefresh();

    onCleanup(() => {
      cancelled = true;
      setRefreshInProgress(false);
    });
  });

  const soulModeEnabled = createMemo(() => {
    const status = props.soulStatusByWorkspaceId[props.activeWorkspaceId];
    return Boolean(status?.enabled ?? props.activeSoulStatus?.enabled);
  });

  const runtimeAvailableWithoutClient = createMemo(() => {
    if (props.clientConnected) return false;
    if (props.vesloServerStatus !== "connected") return false;
    if (props.activeWorkspaceDisplay.workspaceType !== "local") return false;
    return (props.workspaceConnectionStateById[props.activeWorkspaceId]?.status ?? "idle") === "connected";
  });

  const soulNavIconClass = () => (soulModeEnabled() ? "soul-nav-icon-active" : "");

  const handleDashboardTabSelection = (nextTab: DashboardTab, nextSettingsTab?: SettingsTab) => {
    const action = resolveDashboardTabSelectionAction({
      currentTab: props.tab,
      nextTab,
      selectedSessionId: props.selectedSessionId,
      lastWorkspaceSessionId: props.lastWorkspaceSessionId,
    });

    if (action.kind === "return-to-session") {
      props.setView("session", action.sessionId);
      return;
    }

    if (nextTab === "settings" && nextSettingsTab) {
      props.setSettingsTab(nextSettingsTab);
    }

    props.setTab(nextTab);
  };

  const openSettings = (tab: SettingsTab = "general") => {
    props.setSettingsTab(tab);
    props.setTab("settings");
  };

  const handleSettingsButtonClick = () => {
    handleDashboardTabSelection("settings", "general");
  };

  const openSoulForWorkspace = (workspaceId?: string) => {
    const id = (workspaceId ?? props.activeWorkspaceId).trim();
    if (!id) return;
    void (async () => {
      if (id !== props.activeWorkspaceId) {
        await Promise.resolve(props.activateWorkspace(id));
      }
      props.setTab("soul");
    })();
  };

  const revealWorkspaceInFinder = async (workspaceId: string) => {
    const workspace = props.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "local") return;
    const target = workspace.path?.trim() ?? "";
    if (!target || !isTauriRuntime()) return;
    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      if (isWindowsPlatform()) {
        await openPath(target);
      } else {
        await revealItemInDir(target);
      }
    } catch (error) {
      console.warn("Failed to reveal workspace", error);
    }
  };

  createEffect(() => {
    if (props.developerMode) return;
    if (props.tab !== "config") return;
    props.setTab("scheduled");
  });

  const shareWorkspace = createMemo(() => {
    const id = shareWorkspaceId();
    if (!id) return null;
    return props.workspaces.find((ws) => ws.id === id) ?? null;
  });

  const shareWorkspaceName = createMemo(() => {
    const ws = shareWorkspace();
    return ws ? workspaceLabel(ws) : "";
  });

  const shareWorkspaceDetail = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "";
    if (ws.workspaceType === "remote") {
      if (ws.remoteType === "veslo") {
        const hostUrl = ws.vesloHostUrl?.trim() || ws.baseUrl?.trim() || "";
        const mounted = buildVesloWorkspaceBaseUrl(hostUrl, ws.vesloWorkspaceId);
        return mounted || hostUrl;
      }
      return ws.baseUrl?.trim() || "";
    }
    return ws.path?.trim() || "";
  });

  const [shareLocalVesloWorkspaceId, setShareLocalVesloWorkspaceId] = createSignal<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] = createSignal(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] = createSignal<string | null>(null);
  const [shareWorkspaceProfileError, setShareWorkspaceProfileError] = createSignal<string | null>(null);
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = createSignal(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = createSignal<string | null>(null);
  const [shareSkillsSetError, setShareSkillsSetError] = createSignal<string | null>(null);

  createEffect(
    on(shareWorkspaceId, () => {
      setShareWorkspaceProfileBusy(false);
      setShareWorkspaceProfileUrl(null);
      setShareWorkspaceProfileError(null);
      setShareSkillsSetBusy(false);
      setShareSkillsSetUrl(null);
      setShareSkillsSetError(null);
    }),
  );

  createEffect(() => {
    const ws = shareWorkspace();
    const baseUrl = props.vesloServerHostInfo?.baseUrl?.trim() ?? "";
    const token = props.vesloServerHostInfo?.clientToken?.trim() ?? "";
    const workspacePath = ws?.workspaceType === "local" ? ws.path?.trim() ?? "" : "";

    if (!ws || ws.workspaceType !== "local" || !workspacePath || !baseUrl || !token) {
      setShareLocalVesloWorkspaceId(null);
      return;
    }

    let cancelled = false;
    setShareLocalVesloWorkspaceId(null);

    void (async () => {
      try {
        const client = createVesloServerClient({ baseUrl, token });
        const response = await client.listWorkspaces();
        if (cancelled) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(workspacePath);
        const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
        setShareLocalVesloWorkspaceId(match?.id ?? null);
      } catch {
        if (!cancelled) setShareLocalVesloWorkspaceId(null);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const shareFields = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) {
      return [] as Array<{
        label: string;
        value: string;
        secret?: boolean;
        placeholder?: string;
        hint?: string;
      }>;
    }

    if (ws.workspaceType !== "remote") {
      const hostUrl =
        props.vesloServerHostInfo?.connectUrl?.trim() ||
        props.vesloServerHostInfo?.lanUrl?.trim() ||
        props.vesloServerHostInfo?.mdnsUrl?.trim() ||
        props.vesloServerHostInfo?.baseUrl?.trim() ||
        "";
      const mountedUrl = shareLocalVesloWorkspaceId()
        ? buildVesloWorkspaceBaseUrl(hostUrl, shareLocalVesloWorkspaceId())
        : null;
      const url = mountedUrl || hostUrl;
      const token = props.vesloServerHostInfo?.clientToken?.trim() || "";
      const inviteUrl = buildVesloConnectInviteUrl({
        workspaceUrl: url,
        token,
      });
      return [
        {
          label: "Veslo invite link",
          value: inviteUrl,
          secret: true,
          placeholder: !isTauriRuntime() ? "Desktop app required" : "Starting server...",
          hint: "One link that prefills worker URL and token.",
        },
        {
          label: "Veslo worker URL",
          value: url,
          placeholder: !isTauriRuntime() ? "Desktop app required" : "Starting server...",
          hint: mountedUrl
            ? "Use on phones or laptops connecting to this worker."
            : hostUrl
              ? "Worker URL is resolving; host URL shown as fallback."
              : undefined,
        },
        {
          label: "Access token",
          value: token,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : "Desktop app required",
          hint: mountedUrl
            ? "Use on phones or laptops connecting to this worker."
            : "Use on phones or laptops connecting to this host.",
        },
      ];
    }

    if (ws.remoteType === "veslo") {
      const hostUrl = ws.vesloHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const url = buildVesloWorkspaceBaseUrl(hostUrl, ws.vesloWorkspaceId) || hostUrl;
      const token =
        ws.vesloToken?.trim() ||
        props.vesloServerSettings.token?.trim() ||
        "";
      const inviteUrl = buildVesloConnectInviteUrl({
        workspaceUrl: url,
        token,
      });
      return [
        {
          label: "Veslo invite link",
          value: inviteUrl,
          secret: true,
          hint: "One link that prefills worker URL and token.",
        },
        {
          label: "Veslo worker URL",
          value: url,
        },
        {
          label: "Access token",
          value: token,
          secret: true,
          placeholder: token ? undefined : "Set token in Advanced",
          hint: "This token grants access to the worker on that host.",
        },
      ];
    }

    const baseUrl = ws.baseUrl?.trim() || ws.path?.trim() || "";
    const directory = ws.directory?.trim() || "";
    return [
      {
        label: "OpenCode base URL",
        value: baseUrl,
      },
      {
        label: "Directory",
        value: directory,
        placeholder: "(auto)",
      },
    ];
  });

  const shareNote = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return null;
    if (ws.workspaceType === "local" && props.engineInfo?.runtime === "direct") {
      return "Engine runtime is set to Direct. Switching local workers can restart the host and disconnect clients. The token may change after a restart.";
    }
    return null;
  });

  const shareServiceDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "Select a worker first.";
    if (ws.workspaceType === "remote" && ws.remoteType !== "veslo") {
      return "Share service links are available for Veslo workers.";
    }
    if (ws.workspaceType !== "remote") {
      const baseUrl = props.vesloServerHostInfo?.baseUrl?.trim() ?? "";
      const token = props.vesloServerHostInfo?.clientToken?.trim() ?? "";
      if (!baseUrl || !token) {
        return "Local Veslo host is not ready yet.";
      }
    } else {
      const hostUrl = ws.vesloHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const token = ws.vesloToken?.trim() || props.vesloServerSettings.token?.trim() || "";
      if (!hostUrl) return "Missing Veslo host URL.";
      if (!token) return "Missing Veslo token.";
    }
    return null;
  });

  const resolveShareExportContext = async (): Promise<{
    client: VesloServerClient;
    workspaceId: string;
    workspace: WorkspaceInfo;
  }> => {
    const ws = shareWorkspace();
    if (!ws) {
      throw new Error("Select a worker first.");
    }

    if (ws.workspaceType !== "remote") {
      const baseUrl = props.vesloServerHostInfo?.baseUrl?.trim() ?? "";
      const token = props.vesloServerHostInfo?.clientToken?.trim() ?? "";
      if (!baseUrl || !token) {
        throw new Error("Local Veslo host is not ready yet.");
      }
      const client = createVesloServerClient({ baseUrl, token });

      let workspaceId = shareLocalVesloWorkspaceId()?.trim() ?? "";
      if (!workspaceId) {
        const response = await client.listWorkspaces();
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(ws.path?.trim() ?? "");
        const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
        workspaceId = (match?.id ?? "").trim();
        setShareLocalVesloWorkspaceId(workspaceId || null);
      }

      if (!workspaceId) {
        throw new Error("Could not resolve this worker on the local Veslo host.");
      }

      return { client, workspaceId, workspace: ws };
    }

    if (ws.remoteType !== "veslo") {
      throw new Error("Share service links are available for Veslo workers.");
    }

    const hostUrl = ws.vesloHostUrl?.trim() || ws.baseUrl?.trim() || "";
    const token = ws.vesloToken?.trim() || props.vesloServerSettings.token?.trim() || "";
    if (!hostUrl || !token) {
      throw new Error("Veslo host URL and token are required.");
    }

    const client = createVesloServerClient({ baseUrl: hostUrl, token });
    let workspaceId =
      ws.vesloWorkspaceId?.trim() ||
      parseVesloWorkspaceIdFromUrl(ws.vesloHostUrl ?? "") ||
      parseVesloWorkspaceIdFromUrl(ws.baseUrl ?? "") ||
      "";

    if (!workspaceId) {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      const directoryHint = normalizeDirectoryPath(ws.directory?.trim() ?? ws.path?.trim() ?? "");
      const match = directoryHint
        ? items.find((entry) => {
            const entryPath = normalizeDirectoryPath(
              (entry.opencode?.directory ?? entry.directory ?? entry.path ?? "").trim(),
            );
            return Boolean(entryPath && entryPath === directoryHint);
          })
        : (response.activeId ? items.find((entry) => entry.id === response.activeId) : null) ??
          items[0];
      workspaceId = (match?.id ?? "").trim();
    }

    if (!workspaceId) {
      throw new Error("Could not resolve this worker on the Veslo host.");
    }

    return { client, workspaceId, workspace: ws };
  };

  const publishWorkspaceProfileLink = async () => {
    if (shareWorkspaceProfileBusy()) return;
    setShareWorkspaceProfileBusy(true);
    setShareWorkspaceProfileError(null);
    setShareWorkspaceProfileUrl(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const exported = await client.exportWorkspace(workspaceId);
      const payload: WorkspaceProfileBundleV1 = {
        schemaVersion: 1,
        type: "workspace-profile",
        name: `${workspaceLabel(workspace)} profile`,
        description: "Full Veslo workspace profile with config, MCP setup, commands, and skills.",
        workspace: exported,
      };

      const result = await publishVesloBundleJson({
        payload,
        bundleType: "workspace-profile",
        name: payload.name,
      });

      setShareWorkspaceProfileUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      setShareWorkspaceProfileError(error instanceof Error ? error.message : "Failed to publish workspace profile");
    } finally {
      setShareWorkspaceProfileBusy(false);
    }
  };

  const publishSkillsSetLink = async () => {
    if (shareSkillsSetBusy()) return;
    setShareSkillsSetBusy(true);
    setShareSkillsSetError(null);
    setShareSkillsSetUrl(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const exported = await client.exportWorkspace(workspaceId);
      const skills = Array.isArray(exported.skills) ? exported.skills : [];
      if (!skills.length) {
        throw new Error("No skills found in this workspace.");
      }

      const payload: SkillsSetBundleV1 = {
        schemaVersion: 1,
        type: "skills-set",
        name: `${workspaceLabel(workspace)} skills`,
        description: "Complete skills set from an Veslo workspace.",
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          trigger: skill.trigger,
          content: skill.content,
        })),
        sourceWorkspace: {
          id: workspaceId,
          name: workspaceLabel(workspace),
        },
      };

      const result = await publishVesloBundleJson({
        payload,
        bundleType: "skills-set",
        name: payload.name,
      });

      setShareSkillsSetUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      setShareSkillsSetError(error instanceof Error ? error.message : "Failed to publish skills set");
    } finally {
      setShareSkillsSetBusy(false);
    }
  };

  const exportDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "Export is available for local workers in the desktop app.";
    if (ws.workspaceType === "remote") return "Export is only supported for local workers.";
    if (!isTauriRuntime()) return "Export is available in the desktop app.";
    if (props.exportWorkspaceBusy) return "Export is already running.";
    return null;
  });

  const showUpdatePill = createMemo(() => {
    if (!isTauriRuntime()) return false;
    const state = props.updateStatus?.state;
    return state === "available" || state === "downloading" || state === "ready";
  });

  const updateDownloadPercent = createMemo<number | null>(() => {
    const total = props.updateStatus?.totalBytes;
    if (total == null || total <= 0) return null;
    const downloaded = props.updateStatus?.downloadedBytes ?? 0;
    const clamped = Math.max(0, Math.min(1, downloaded / total));
    return Math.floor(clamped * 100);
  });

  const updatePillLabel = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return t("settings.sidebar_update_ready", currentLocale());
    }
    if (state === "available" && props.updateAutoDownload) {
      return t("settings.sidebar_update_preparing", currentLocale());
    }
    if (state === "downloading") {
      const percent = updateDownloadPercent();
      const label = t("settings.update_downloading", currentLocale());
      return percent == null ? label : `${label} ${percent}%`;
    }
    return t("settings.sidebar_update_available", currentLocale());
  });

  const updatePillActionLabel = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "available" && !props.updateAutoDownload) return t("settings.sidebar_download_update", currentLocale());
    if (state === "ready") return t("settings.sidebar_install_update", currentLocale());
    return null;
  });

  const updatePillActionDisabled = createMemo(() => props.updateStatus?.state === "ready" && props.anyActiveRuns);

  const updatePillActionTitle = createMemo(() => {
    if (props.updateStatus?.state === "ready" && props.anyActiveRuns) {
      return t("settings.stop_runs_to_update", currentLocale());
    }
    const label = updatePillActionLabel();
    if (!label) return "";
    const version = props.updateStatus?.version ? `v${props.updateStatus.version}` : "";
    return version ? `${label} ${version}` : label;
  });

  const updatePillButtonTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns
        ? "text-amber-11 hover:text-amber-11 hover:bg-amber-3/30"
        : "text-green-11 hover:text-green-11 hover:bg-green-3/30";
    }
    if (state === "downloading") {
      return "text-blue-11 hover:text-blue-11 hover:bg-blue-3/30";
    }
    return "text-dls-secondary hover:text-emerald-11 hover:bg-emerald-3/25";
  });

  const updatePillBorderTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "border-amber-7/35" : "border-green-7/35";
    }
    if (state === "downloading") {
      return "border-blue-7/35";
    }
    return "border-dls-border";
  });

  const updatePillDotTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "text-amber-10 fill-amber-10" : "text-green-10 fill-green-10";
    }
    if (state === "downloading") {
      return "text-blue-10";
    }
    return "text-emerald-10 fill-emerald-10";
  });

  const updatePillVersionTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "text-amber-11/75" : "text-green-11/75";
    }
    if (state === "downloading") {
      return "text-blue-11/75";
    }
    return "text-dls-secondary";
  });

  const updatePillTitle = createMemo(() => {
    const version = props.updateStatus?.version ? ` v${props.updateStatus.version}` : "";
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns
        ? `${t("settings.sidebar_update_ready", currentLocale())}${version}. ${t("settings.stop_runs_to_update", currentLocale())}.`
        : `${t("settings.sidebar_update_ready", currentLocale())}${version}`;
    }
    if (state === "downloading") return `${t("settings.update_downloading", currentLocale())}${version}`;
    if (state === "available" && props.updateAutoDownload) {
      return `${t("settings.sidebar_update_preparing", currentLocale())}${version}`;
    }
    return `${t("settings.sidebar_update_available", currentLocale())}${version}`;
  });

  const handleUpdatePillClick = () => {
    const state = props.updateStatus?.state;
    if (state === "available") {
      if (!props.updateAutoDownload) {
        props.downloadUpdate();
      }
      return;
    }
    if (state === "ready" && !props.anyActiveRuns) {
      props.installUpdateAndRestart();
      return;
    }
    openSettings("advanced");
  };

  const leftMenuAction = createMemo(() =>
    resolveLeftMenuAction({
      tab: props.tab,
      selectedSessionId: props.selectedSessionId,
      lastWorkspaceSessionId: props.lastWorkspaceSessionId,
    }),
  );
  const leftMenuLabel = createMemo(() =>
    leftMenuAction().kind === "return-to-session" ? "Return to session" : "Toggle left menu",
  );
  const leftMenuActive = createMemo(() =>
    leftMenuAction().kind === "return-to-session" ? false : leftSidebarVisible(),
  );

  const handleLeftMenuToggle = () => {
    const action = leftMenuAction();
    if (action.kind === "return-to-session") {
      props.setView("session", action.sessionId);
      return;
    }

    toggleSidebarMenu("left");
  };

  const headerSettingsLabel = createMemo(() => t("dashboard.settings", currentLocale()));
  const headerBackLabel = createMemo(() => t("session.back", currentLocale()));
  const feedbackButtonLabel = createMemo(() => t("feedback.button", currentLocale()));

  const returnToSession = () => {
    const sessionId = props.selectedSessionId?.trim();
    props.setView("session", sessionId);
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!shouldReturnToSessionOnEscape({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        modalOpen: Boolean(window.document.querySelector(".fixed.inset-0.z-50")),
        targetTagName: target?.tagName ?? null,
        targetIsContentEditable: target instanceof HTMLElement ? target.isContentEditable : false,
      })) {
        return;
      }
      event.preventDefault();
      returnToSession();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <div
      data-feedback-capture-root
      class="flex h-screen w-full bg-dls-surface text-dls-text font-sans overflow-hidden"
    >
      <TitlebarMenuToggles
        leftActive={leftMenuActive()}
        rightActive={rightSidebarVisible()}
        centerContent={title()}
        rightContent={
          <button
            type="button"
            class="mr-1 inline-flex h-6 items-center rounded-md px-2.5 text-[11px] font-medium leading-6 text-gray-10 transition-colors hover:bg-gray-3/70 hover:text-gray-12 focus:outline-none focus-visible:ring-0"
            onClick={props.onOpenFeedback}
            aria-label={feedbackButtonLabel()}
            title={feedbackButtonLabel()}
          >
            {feedbackButtonLabel()}
          </button>
        }
        hideTitlebar={props.hideTitlebar}
        leftLabel={leftMenuLabel()}
        onToggleLeft={handleLeftMenuToggle}
        onToggleRight={() => toggleSidebarMenu("right")}
      />

      <Show when={leftSidebarVisible()}>
        <aside
          class={`relative hidden md:flex flex-col bg-dls-sidebar border-r border-dls-border p-4 pt-12 ${
            leftSidebarResizing() ? "cursor-col-resize" : ""
          }`}
          style={leftSidebarStyle()}
        >
          <div class="flex min-h-0 flex-1 flex-col">
          <Show when={showUpdatePill()}>
            <div
              role="status"
              class={`group mb-3 w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${updatePillButtonTone()}`}
              title={updatePillTitle()}
              aria-label={updatePillTitle()}
            >
              <Show
                when={props.updateStatus?.state === "downloading"}
                fallback={
                  <Circle
                    size={8}
                    class={`${updatePillDotTone()} shrink-0 ${props.updateStatus?.state === "available" ? "group-hover:animate-pulse" : ""}`}
                  />
                }
              >
                <Loader2 size={13} class={`animate-spin shrink-0 ${updatePillDotTone()}`} />
              </Show>
              <span class="min-w-0 flex-1 truncate text-left">{updatePillLabel()}</span>
              <Show when={props.updateStatus?.version}>
                {(version) => (
                  <span class={`shrink-0 font-mono text-[10px] ${updatePillVersionTone()}`}>v{version()}</span>
                )}
              </Show>
              <Show when={updatePillActionLabel()}>
                {(label) => (
                  <button
                    type="button"
                    class="shrink-0 rounded-md border border-dls-border bg-dls-surface/80 px-1.5 py-0.5 text-[11px] font-semibold text-dls-text transition-colors hover:bg-dls-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.24)] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={updatePillActionDisabled()}
                    title={updatePillActionTitle()}
                    aria-label={updatePillActionTitle()}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (props.updateStatus?.state === "available") {
                        if (!props.updateAutoDownload) {
                          props.downloadUpdate();
                        }
                        return;
                      }
                      if (props.updateStatus?.state === "ready" && !props.anyActiveRuns) {
                        props.installUpdateAndRestart();
                      }
                    }}
                  >
                    {label()}
                  </button>
                )}
              </Show>
            </div>
          </Show>
          <div class="min-h-0 flex-1">
            <WorkspaceSessionList
              workspaceSessionGroups={props.workspaceSessionGroups}
              workspaceSessionPagingById={props.workspaceSessionPagingById}
              subagentDecorationsBySessionId={props.subagentDecorationsBySessionId}
              archivedSessionIds={props.archivedSessionIds}
              activeWorkspaceId={props.activeWorkspaceId}
              selectedSessionId={props.selectedSessionId}
              connectingWorkspaceId={props.connectingWorkspaceId}
              workspaceConnectionStateById={props.workspaceConnectionStateById}
              newTaskDisabled={props.newTaskDisabled}
              importingWorkspaceConfig={props.importingWorkspaceConfig}
              soulStatusByWorkspaceId={props.soulStatusByWorkspaceId}
              isPrivateWorkspacePath={props.isPrivateWorkspacePath}
              onActivateWorkspace={props.activateWorkspace}
              onOpenSession={openSessionFromList}
              onOpenPendingDirectoryDraftInWorkspace={props.openPendingDirectoryDraftInWorkspace}
              onOpenRenameWorkspace={props.openRenameWorkspace}
              onShareWorkspace={(workspaceId) => setShareWorkspaceId(workspaceId)}
              onOpenSoul={openSoulForWorkspace}
              onRevealWorkspace={revealWorkspaceInFinder}
              onRecoverWorkspace={props.recoverWorkspace}
              onTestWorkspaceConnection={props.testWorkspaceConnection}
              onEditWorkspaceConnection={props.editWorkspaceConnection}
              onForgetWorkspace={props.forgetWorkspace}
              onOpenCreateWorkspace={props.openCreateWorkspace}
              onOpenCreateRemoteWorkspace={props.openCreateRemoteWorkspace}
              onImportWorkspaceConfig={props.importWorkspaceConfig}
              onQuickNewSession={props.openNewSessionWithDirectory}
              onAddDirectorySession={props.openDirectorySessionFromPicker}
              onOpenArchivedSessions={() => openSettings("archived")}
              onArchiveSession={props.archiveSession}
              onUnarchiveSession={props.unarchiveSession}
              onLoadMoreWorkspaceSessions={props.loadMoreWorkspaceSidebarSessions}
              onLoadedSessionPrefetchInterestChange={reportLoadedSessionPrefetchInterest}
            />
          </div>
          <SidebarDashboardNav
            currentTab={props.tab}
            onSelect={handleDashboardTabSelection}
            soulIconClass={soulNavIconClass()}
          />
        </div>
          <SidebarStatusControls
            clientConnected={props.clientConnected}
            vesloServerStatus={props.vesloServerStatus}
            runtimeAvailableWithoutClient={runtimeAvailableWithoutClient()}
            authenticatedUser={props.authenticatedUser}
            onOpenSettings={handleSettingsButtonClick}
            onLogout={props.onLogout}
            onSignIn={props.onSignIn}
          />
          <div
            class="absolute inset-y-0 right-0 w-2 cursor-col-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize left sidebar"
            onPointerDown={startLeftSidebarResize}
          />
        </aside>
      </Show>

      <main class="flex-1 flex flex-col overflow-hidden bg-dls-surface pt-12">
        <div class="flex-1 overflow-y-auto">
        <header class="h-14 flex items-center justify-between px-6 md:px-10 border-b border-dls-border sticky top-0 bg-dls-surface z-10">
          <div class="flex items-center gap-3">
            <Show when={showUpdatePill() && props.tab !== "settings"}>
              <button
                type="button"
                class={`md:hidden flex items-center gap-1.5 rounded-full border bg-dls-surface px-2.5 py-1 text-xs font-medium shadow-sm transition-colors active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] ${updatePillBorderTone()} ${updatePillButtonTone()}`}
                onClick={handleUpdatePillClick}
                title={updatePillTitle()}
                aria-label={updatePillTitle()}
              >
                <Show
                  when={props.updateStatus?.state === "downloading"}
                  fallback={
                    <Circle
                      size={8}
                      class={`${updatePillDotTone()} shrink-0 ${props.updateStatus?.state === "available" ? "animate-pulse" : ""}`}
                    />
                  }
                >
                  <Loader2 size={13} class={`animate-spin shrink-0 ${updatePillDotTone()}`} />
                </Show>
                <span class="text-[11px]">{updatePillLabel()}</span>
                <Show when={props.updateStatus?.version}>
                  {(version) => (
                    <span class={`hidden sm:inline font-mono text-[10px] ${updatePillVersionTone()}`}>v{version()}</span>
                  )}
                </Show>
              </button>
            </Show>
            <div class="font-product type-ui-sm px-3 py-1.5 rounded-xl bg-dls-hover text-dls-secondary font-medium">
              {props.activeWorkspaceDisplay.name}
            </div>
            <Show when={props.activeSoulStatus?.enabled}>
              <div class="font-product type-ui-xs inline-flex items-center gap-1 rounded-full border border-rose-7/40 bg-rose-3/40 px-2 py-1 text-rose-11">
                <HeartPulse size={11} />
                Soul on
              </div>
            </Show>
            <Show when={props.tab !== "settings"}>
              <h1 class="font-product type-title-sm">{title()}</h1>
            </Show>
            <Show when={props.developerMode}>
              <span class="font-product type-ui-xs text-dls-secondary">{props.headerStatus}</span>
            </Show>
            <Show when={props.busyHint}>
              <span class="font-product type-ui-xs text-dls-secondary">{props.busyHint}</span>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="font-product type-ui-xs inline-flex h-8 items-center gap-1.5 rounded-lg border border-dls-border bg-dls-surface px-2.5 font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              onClick={returnToSession}
              aria-label={headerBackLabel()}
              title={headerBackLabel()}
            >
              <ArrowLeft size={14} />
              <span class="hidden sm:inline">{headerBackLabel()}</span>
            </button>
            <button
              type="button"
              class="font-product type-ui-xs inline-flex h-8 items-center gap-1.5 rounded-lg border border-dls-border bg-dls-surface px-2.5 font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              onClick={handleSettingsButtonClick}
              aria-label={headerSettingsLabel()}
              title={headerSettingsLabel()}
            >
              <SettingsIcon size={14} />
              <span class="hidden sm:inline">{headerSettingsLabel()}</span>
            </button>
          </div>
        </header>

        <div class="p-6 md:p-10 max-w-5xl mx-auto space-y-10">
          <Switch>
            <Match when={props.tab === "scheduled"}>
              <ScheduledTasksView
                jobs={props.scheduledJobs}
                source={props.scheduledJobsSource}
                sourceReady={props.scheduledJobsSourceReady}
                status={props.scheduledJobsStatus}
                busy={props.scheduledJobsBusy}
                lastUpdatedAt={props.scheduledJobsUpdatedAt}
                refreshJobs={props.refreshScheduledJobs}
                deleteJob={props.deleteScheduledJob}
                isWindows={props.isWindows}
                activeWorkspaceRoot={props.activeWorkspaceRoot}
                createSessionAndOpen={props.createSessionAndOpen}
                setPrompt={props.setPrompt}
                newTaskDisabled={props.newTaskDisabled}
                schedulerInstalled={props.schedulerPluginInstalled}
                canEditPlugins={props.canEditPlugins}
                addPlugin={props.addPlugin}
                reloadWorkspaceEngine={props.reloadWorkspaceEngine}
                reloadBusy={props.reloadBusy}
                canReloadWorkspace={props.canReloadWorkspace}
              />
            </Match>
            <Match when={props.tab === "soul"}>
              <SoulView
                workspaceName={props.activeWorkspaceDisplay.name}
                workspaceRoot={props.activeWorkspaceRoot}
                status={props.activeSoulStatus}
                heartbeats={props.activeSoulHeartbeats}
                loading={props.soulStatusBusy}
                loadingHeartbeats={props.soulHeartbeatsBusy}
                error={props.soulError}
                newTaskDisabled={props.newTaskDisabled}
                refresh={props.refreshSoulData}
                runSoulPrompt={props.runSoulPrompt}
              />
            </Match>
            <Match when={props.tab === "skills"}>
              <SkillsView
                workspaceName={props.activeWorkspaceDisplay.name}
                busy={props.busy}
                canInstallSkillCreator={props.canInstallSkillCreator}
                canUseDesktopTools={props.canUseDesktopTools}
                accessHint={props.skillsAccessHint}
                refreshSkills={props.refreshSkills}
                refreshHubSkills={props.refreshHubSkills}
                skills={props.skills}
                skillsStatus={props.skillsStatus}
                hubSkills={props.hubSkills}
                hubSkillsStatus={props.hubSkillsStatus}
                importLocalSkill={props.importLocalSkill}
                installSkillCreator={props.installSkillCreator}
                installHubSkill={props.installHubSkill}
                revealSkillsFolder={props.revealSkillsFolder}
                uninstallSkill={props.uninstallSkill}
                readSkill={props.readSkill}
                saveSkill={props.saveSkill}
                createSessionAndOpen={props.createSessionAndOpen}
                setPrompt={props.setPrompt}
              />
            </Match>

            <Match when={props.tab === "plugins" || props.tab === "mcp"}>
              <ExtensionsView
                busy={props.busy}
                activeWorkspaceRoot={props.activeWorkspaceRoot}
                isRemoteWorkspace={props.isRemoteWorkspace}
                mcpServers={props.mcpServers}
                mcpStatus={props.mcpStatus}
                mcpLastUpdatedAt={props.mcpLastUpdatedAt}
                mcpStatuses={props.mcpStatuses}
                mcpConnectingName={props.mcpConnectingName}
                selectedMcp={props.selectedMcp}
                setSelectedMcp={props.setSelectedMcp}
                quickConnect={props.quickConnect}
                hubMcpCards={props.hubMcpCards}
                hubMcpStatus={props.hubMcpStatus}
                refreshHubMcp={props.refreshHubMcp}
                installHubMcp={props.installHubMcp}
                refreshMcpServers={props.refreshMcpServers}
                connectMcp={props.connectMcp}
                authorizeMcp={props.authorizeMcp}
                logoutMcpAuth={props.logoutMcpAuth}
                removeMcp={props.removeMcp}
                showMcpReloadBanner={props.showMcpReloadBanner}
                reloadBlocked={props.mcpReloadBlocked}
                reloadMcpEngine={props.reloadMcpEngine}
              />
            </Match>

            <Match when={props.tab === "config" && props.developerMode}>
              <ConfigView
                busy={props.busy}
                clientConnected={props.clientConnected}
                anyActiveRuns={props.anyActiveRuns}
                vesloServerStatus={props.vesloServerStatus}
                vesloServerUrl={props.vesloServerUrl}
                vesloServerSettings={props.vesloServerSettings}
                vesloServerHostInfo={props.vesloServerHostInfo}
                vesloServerWorkspaceId={props.vesloServerWorkspaceId}
                updateVesloServerSettings={props.updateVesloServerSettings}
                resetVesloServerSettings={props.resetVesloServerSettings}
                testVesloServerConnection={props.testVesloServerConnection}
                canReloadWorkspace={props.canReloadWorkspace}
                reloadWorkspaceEngine={props.reloadWorkspaceEngine}
                reloadBusy={props.reloadBusy}
                reloadError={props.reloadError}
                workspaceAutoReloadAvailable={props.workspaceAutoReloadAvailable}
                workspaceAutoReloadEnabled={props.workspaceAutoReloadEnabled}
                setWorkspaceAutoReloadEnabled={props.setWorkspaceAutoReloadEnabled}
                workspaceAutoReloadResumeEnabled={props.workspaceAutoReloadResumeEnabled}
                setWorkspaceAutoReloadResumeEnabled={props.setWorkspaceAutoReloadResumeEnabled}
                developerMode={props.developerMode}
              />
            </Match>

            <Match when={props.tab === "settings"}>
                <SettingsView
                  startupPreference={props.startupPreference}
                  baseUrl={props.baseUrl}
                  headerStatus={props.headerStatus}
                  busy={props.busy}
                  settingsTab={props.settingsTab}
                  setSettingsTab={props.setSettingsTab}
                  vesloServerStatus={props.vesloServerStatus}
                  vesloServerUrl={props.vesloServerUrl}
                  vesloReconnectBusy={props.vesloReconnectBusy}
                  reconnectVesloServer={props.reconnectVesloServer}
                  vesloServerHostInfo={props.vesloServerHostInfo}
                  vesloServerCapabilities={props.vesloServerCapabilities}
                  vesloServerDiagnostics={props.vesloServerDiagnostics}
                  vesloServerWorkspaceId={props.vesloServerWorkspaceId}
                  activeWorkspaceRoot={props.activeWorkspaceRoot}
                  vesloAuditEntries={props.vesloAuditEntries}
                  vesloAuditStatus={props.vesloAuditStatus}
                  vesloAuditError={props.vesloAuditError}
                  opencodeConnectStatus={props.opencodeConnectStatus}
                  engineInfo={props.engineInfo}
                  orchestratorStatus={props.orchestratorStatus}
                  opencodeRouterInfo={props.opencodeRouterInfo}
                  engineDoctorVersion={props.engineDoctorVersion}
                  developerMode={props.developerMode}
                  stopHost={props.stopHost}
                  restartLocalServer={props.restartLocalServer}
                  engineSource={props.engineSource}
                  setEngineSource={props.setEngineSource}
                  engineCustomBinPath={props.engineCustomBinPath}
                  setEngineCustomBinPath={props.setEngineCustomBinPath}
                  engineRuntime={props.engineRuntime}
                  setEngineRuntime={props.setEngineRuntime}
                  isWindows={props.isWindows}
                  aiAccessBusy={props.aiAccessBusy}
                  aiAccessConfigured={props.aiAccessConfigured}
                  aiAccessMessage={props.aiAccessMessage}
                  aiAccessProviderLabel={props.aiAccessProviderLabel}
                  aiAccessDefaultModelLabel={props.aiAccessDefaultModelLabel}
                  aiAccessAllowedModels={props.aiAccessAllowedModels}
                  showThinking={props.showThinking}
                  toggleShowThinking={props.toggleShowThinking}
                  autoCompactContext={props.autoCompactContext}
                  toggleAutoCompactContext={props.toggleAutoCompactContext}
                  hideTitlebar={props.hideTitlebar}
                  toggleHideTitlebar={props.toggleHideTitlebar}
                  modelVariantLabel={props.modelVariantLabel}
                  modelVariant={props.modelVariant}
                  setModelVariant={props.setModelVariant}
                  language={props.language}
                  setLanguage={props.setLanguage}
                  updateAutoCheck={props.updateAutoCheck}
                  toggleUpdateAutoCheck={props.toggleUpdateAutoCheck}
                  updateAutoDownload={props.updateAutoDownload}
                  toggleUpdateAutoDownload={props.toggleUpdateAutoDownload}
                  themeMode={props.themeMode}
                  setThemeMode={props.setThemeMode}
                  denKeepSignedIn={props.denKeepSignedIn}
                  toggleDenKeepSignedIn={props.toggleDenKeepSignedIn}
                  updateStatus={props.updateStatus}
                  updateEnv={props.updateEnv}
                  appVersion={props.appVersion}
                  checkForUpdates={props.checkForUpdates}
                  downloadUpdate={props.downloadUpdate}
                  installUpdateAndRestart={props.installUpdateAndRestart}
                  anyActiveRuns={props.anyActiveRuns}
                  onResetStartupPreference={props.onResetStartupPreference}
                  openResetModal={props.openResetModal}
                  resetModalBusy={props.resetModalBusy}
                  pendingPermissions={props.pendingPermissions}
                  events={props.events}
                  workspaceDebugEvents={props.workspaceDebugEvents}
                  sandboxCreateProgress={props.sandboxCreateProgress}
                  clearWorkspaceDebugEvents={props.clearWorkspaceDebugEvents}
                  safeStringify={props.safeStringify}
                  repairOpencodeMigration={props.repairOpencodeMigration}
                  migrationRepairBusy={props.migrationRepairBusy}
                  migrationRepairResult={props.migrationRepairResult}
                  migrationRepairAvailable={props.migrationRepairAvailable}
                  migrationRepairUnavailableReason={props.migrationRepairUnavailableReason}
                  repairOpencodeCache={props.repairOpencodeCache}
                  cacheRepairBusy={props.cacheRepairBusy}
                  cacheRepairResult={props.cacheRepairResult}
                  cleanupVesloDockerContainers={props.cleanupVesloDockerContainers}
                  dockerCleanupBusy={props.dockerCleanupBusy}
                  dockerCleanupResult={props.dockerCleanupResult}
                  resetAppConfigDefaults={props.resetAppConfigDefaults}
                  notionStatus={props.notionStatus}
                  notionStatusDetail={props.notionStatusDetail}
                  notionError={props.notionError}
                  notionBusy={props.notionBusy}
                  connectNotion={props.connectNotion}
                  sessionArchives={props.sessionArchives}
                  onUnarchiveSession={props.onUnarchiveArchivedSession}
                  workspaces={props.workspaces}
                />

            </Match>
          </Switch>
        </div>

        <Show when={props.error}>
          <div class="mx-auto max-w-5xl px-6 md:px-10 pb-24 md:pb-10">
            <div class="rounded-2xl bg-red-1/40 px-5 py-4 text-sm text-red-12 border border-red-7/20 space-y-3">
              <div>{props.error}</div>
              <Show when={props.developerMode}>
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    class="text-xs h-8 py-0 px-3"
                    onClick={props.repairOpencodeCache}
                    disabled={props.cacheRepairBusy || !props.developerMode}
                  >
                    {props.cacheRepairBusy ? "Repairing cache" : "Repair cache"}
                  </Button>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3"
                    onClick={props.stopHost}
                    disabled={props.busy}
                  >
                    Retry
                  </Button>
                  <Show when={props.cacheRepairResult}>
                    <span class="text-xs text-red-12/80">
                      {props.cacheRepairResult}
                    </span>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        <ShareWorkspaceModal
          open={Boolean(shareWorkspaceId())}
          onClose={() => setShareWorkspaceId(null)}
          workspaceName={shareWorkspaceName()}
          workspaceDetail={shareWorkspaceDetail()}
          fields={shareFields()}
          note={shareNote()}
          publisherBaseUrl={DEFAULT_VESLO_PUBLISHER_BASE_URL}
          onShareWorkspaceProfile={publishWorkspaceProfileLink}
          shareWorkspaceProfileBusy={shareWorkspaceProfileBusy()}
          shareWorkspaceProfileUrl={shareWorkspaceProfileUrl()}
          shareWorkspaceProfileError={shareWorkspaceProfileError()}
          shareWorkspaceProfileDisabledReason={shareServiceDisabledReason()}
          onShareSkillsSet={publishSkillsSetLink}
          onOpenSingleSkillShare={() => {
            setShareWorkspaceId(null);
            props.setTab("skills");
          }}
          shareSkillsSetBusy={shareSkillsSetBusy()}
          shareSkillsSetUrl={shareSkillsSetUrl()}
          shareSkillsSetError={shareSkillsSetError()}
          shareSkillsSetDisabledReason={shareServiceDisabledReason()}
          onExportConfig={
            exportDisabledReason()
              ? undefined
              : () => {
                const id = shareWorkspaceId();
                if (!id) return;
                props.exportWorkspaceConfig(id);
              }
          }
          exportDisabledReason={exportDisabledReason()}
        />
        </div>

        <nav class="md:hidden border-t border-dls-border bg-dls-surface">
          <div class={`mx-auto max-w-5xl px-4 py-3 grid gap-2 ${props.developerMode ? "grid-cols-5" : "grid-cols-4"}`}>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "scheduled" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => handleDashboardTabSelection("scheduled")}
            >
              <History size={18} />
              {t("nav.automations", currentLocale())}
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "soul" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => handleDashboardTabSelection("soul")}
            >
              <HeartPulse size={18} class={soulNavIconClass()} />
              {t("nav.soul", currentLocale())}
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "skills" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => handleDashboardTabSelection("skills")}
            >
              <Zap size={18} />
              {t("nav.skills", currentLocale())}
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "mcp" || props.tab === "plugins" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => handleDashboardTabSelection("mcp")}
            >
              <Box size={18} />
              {t("nav.extensions", currentLocale())}
            </button>
            <Show when={props.developerMode}>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  props.tab === "config" ? "text-gray-12" : "text-gray-10"
                }`}
                onClick={() => handleDashboardTabSelection("config")}
              >
                <SlidersHorizontal size={18} />
                {t("nav.advanced", currentLocale())}
              </button>
            </Show>
          </div>
        </nav>
      </main>

      <Show when={rightSidebarVisible()}>
        <aside class="w-56 hidden md:flex flex-col bg-dls-sidebar border-l border-dls-border p-4 pt-12">
          <Show when={props.developerMode}>
            <div class="space-y-1 pt-2">
              <SidebarAdvancedNav
                currentTab={props.tab}
                onSelect={() => handleDashboardTabSelection("config")}
              />
            </div>
          </Show>
        </aside>
      </Show>

    </div>
  );
}
