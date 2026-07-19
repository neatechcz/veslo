import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type {
  DashboardTab,
  McpServerEntry,
  McpStatusMap,
  OpencodeConnectStatus,
  PluginInventoryCard,
  PluginScope,
  SettingsTab,
  SessionArchiveItem,
  SidebarSubagentDecoration,
  HubMcpCard,
  HubSkillCard,
  HubSkillInstallTarget,
  SkillCard,
  SkillFileEntry,
  SkillInventoryItem,
  SkillSaveResult,
  StartupPreference,
  ScheduledJob,
  LoadedSessionPrefetchInterestChangeHandler,
  AutomationWorkspaceSummary,
  VesloAutomationCreatePayload,
  VesloAutomationUpdatePayload,
  WorkspaceAutomationItem,
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
import { parseVesloWorkspaceIdFromUrl } from "../lib/veslo-server";
import { reportError } from "../lib/error-reporter";
import type { UiConversationRef } from "../lib/ui-conversation-scope";
import type {
  VesloSoulAuthContext,
  VesloSoulOverviewResponse,
  VesloServerClient,
  VesloServerCapabilities,
  VesloServerConnectionSnapshot,
  VesloServerDiagnostics,
  VesloServerSettings,
  VesloServerStatus,
  VesloSkillImportCandidate,
  VesloSkillRegistryAuthContext,
} from "../lib/veslo-server";
import {
  type EngineInfo,
  type OpenCodeRouterInfo,
  type OrchestratorStatus,
  type VesloServerInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { acquireBlankNativeWindowTitleLease } from "../lib/native-window-title-lease";
import { DEFAULT_VESLO_PUBLISHER_BASE_URL } from "../lib/publisher";
import type { SkillMutationTarget } from "../lib/skill-inventory";

import Button from "../components/button";
import DashboardTabRail, { shouldShowDashboardTabRail } from "../components/dashboard-tab-rail";
import ExtensionsView from "./extensions";
import PluginsView from "./plugins";
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
import type { SidebarSessionActivity } from "../context/sidebar-session-activity-projection";
import type { SidebarSessionOpenTarget } from "../components/session/workspace-session-list-model";
import TitlebarMenuToggles from "../components/titlebar-menu-toggles";
import {
  clampLeftSidebarWidth,
  readLeftSidebarWidth,
  writeLeftSidebarWidth,
} from "../components/layout/left-sidebar-width-prefs";
import {
  readGlobalSidebarDockedPrefs,
  writeGlobalSidebarDockedPrefs,
} from "../components/layout/global-sidebar-prefs";
import { openSidebarSessionFromList, type SessionBrowseScope } from "./session-navigation";
import type { WorkspaceActivationOptions } from "../context/workspace-types";
import type { WorkspaceBusyMap } from "../context/workspace-debug";
import type { DocumentRuntimeStatusPayload } from "../lib/document-runtime";
import {
  resolveDashboardTabSelectionAction,
  resolveLeftMenuAction,
  shouldReturnToSessionOnEscape,
} from "./dashboard-menu-navigation";
import { resolveDashboardUpdatePillModel } from "./dashboard-update-pill-model";
import { createWorkspaceShareController } from "./workspace-share-controller";
import {
  ArrowLeft,
  Box,
  ChevronDown,
  ChevronRight,
  Circle,
  Cpu,
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
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../i18n";
import type { UpdateDownloadRetryInfo } from "../context/updater";
import { createDashboardTabRefreshController } from "./dashboard-tab-refresh-controller";

function createLeftSidebarResizeCleanup(input: {
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  previousUserSelect: string;
  previousCursor: string;
}): () => void {
  return () => {
    window.removeEventListener("pointermove", input.onPointerMove);
    window.removeEventListener("pointerup", input.onPointerUp);
    window.removeEventListener("pointercancel", input.onPointerCancel);
    document.body.style.userSelect = input.previousUserSelect;
    document.body.style.cursor = input.previousCursor;
  };
}

export type DashboardViewProps = {
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  onOpenFeedback: () => void;
  view: View;
  setView: (view: View, sessionId?: string) => void;
  setSessionBrowseScope: (scope: SessionBrowseScope) => void;
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
  pendingPermissionCountByWs?: Record<string, number>;
  headerStatus: string;
  error: string | null;
  vesloServerStatus: VesloServerStatus;
  vesloServerConnection: VesloServerConnectionSnapshot;
  vesloServerCanWriteSkills: boolean;
  vesloServerSkillRegistryAvailable: boolean;
  vesloServerUrl: string;
  vesloServerClient: VesloServerClient | null;
  vesloReconnectBusy: boolean;
  reconnectVesloServer: () => Promise<boolean>;
  vesloServerSettings: VesloServerSettings;
  vesloServerHostInfo: VesloServerInfo | null;
  vesloServerCapabilities: VesloServerCapabilities | null;
  vesloServerDiagnostics: VesloServerDiagnostics | null;
  vesloServerWorkspaceId: string | null;
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
  reloadScheduledAutomationsSource: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;
  activeWorkspaceDisplay: WorkspaceInfo;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  activeUiConversationRef?: UiConversationRef;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  readyEngineWorkspaceIds?: Set<string>;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  recoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean;
  openCreateWorkspace: () => void;
  openCreateRemoteWorkspace: () => void;
  openNewSessionWithDirectory: () => Promise<boolean | void> | boolean | void;
  openDirectorySessionFromPicker: () => void;
  openPendingDirectoryDraftInWorkspace: (workspaceId: string) => void;
  importWorkspaceConfig: () => void;
  importingWorkspaceConfig: boolean;
  exportWorkspaceConfig: (workspaceId?: string) => void;
  exportWorkspaceBusy: boolean;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  unreadSessionIds: Record<string, true>;
  workspaceSessionPagingById: Record<string, { hasMore: boolean; loadingMore: boolean }>;
  subagentDecorationsBySessionId: Record<string, SidebarSubagentDecoration>;
  archivedSessionIds: string[];
  sessionStatusById: Record<string, string>;
  sidebarSessionActivityByRowKey: Record<string, SidebarSessionActivity>;
  busySessionByWorkspaceId?: WorkspaceBusyMap;
  archiveSession: (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) => Promise<void> | void;
  unarchiveSession: (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) => Promise<void> | void;
  loadMoreWorkspaceSidebarSessions: (workspaceId: string) => Promise<void> | void;
  selectedSessionId: string | null;
  lastWorkspaceSessionId: string | null;
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean;
  openRenameWorkspace: (workspaceId: string) => void;
  editWorkspaceConnection: (workspaceId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
  automationItems: WorkspaceAutomationItem[];
  automationWorkspaces: AutomationWorkspaceSummary[];
  defaultAutomationWorkspaceId: string | null;
  scheduledJobs: ScheduledJob[];
  scheduledJobsSource: "local" | "remote";
  scheduledJobsSourceReady: boolean;
  scheduledJobsStatus: string | null;
  scheduledJobsBusy: boolean;
  scheduledJobsUpdatedAt: number | null;
  refreshScheduledJobs: (options?: { force?: boolean }) => Promise<void>;
  createAutomation: (workspaceId: string, payload: VesloAutomationCreatePayload) => Promise<void> | void;
  updateAutomation: (workspaceId: string, automationId: string, payload: VesloAutomationUpdatePayload) => Promise<void> | void;
  deleteAutomation: (workspaceId: string, automationId: string) => Promise<void> | void;
  runAutomation: (workspaceId: string, automationId: string) => Promise<void> | void;
  soulOverview: VesloSoulOverviewResponse | null;
  soulOverviewError: string | null;
  soulOverviewBusy: boolean;
  soulClient: VesloServerClient | null;
  soulServerConnected: boolean;
  soulAuthContext: VesloSoulAuthContext;
  skillRegistryAuthContext: VesloSkillRegistryAuthContext;
  soulWorkspaceMap: Record<string, string>;
  soulError: string | null;
  refreshSoulData: (options?: { force?: boolean }) => Promise<void>;
  activeWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshSkillInventory: (options?: { force?: boolean }) => Promise<void>;
  refreshSkillImportCandidates: (options?: { force?: boolean }) => Promise<void>;
  refreshHubSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshPlugins: (scopeOverride?: PluginScope, optionsOverride?: { debug?: boolean }) => Promise<void>;
  refreshMcpServers: () => Promise<void>;
  skills: SkillCard[];
  skillsStatus: string | null;
  skillInventory: SkillInventoryItem[];
  skillInventoryStatus: string | null;
  skillImportCandidates: VesloSkillImportCandidate[];
  skillImportStatus: string | null;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  hubMcpCards: HubMcpCard[];
  hubMcpStatus: string | null;
  skillsAccessHint?: string | null;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  installSkillCreator: () => Promise<{ ok: boolean; message: string }>;
  installHubSkill: (name: string, target: HubSkillInstallTarget) => Promise<{ ok: boolean; message: string }>;
  refreshHubMcp: (options?: { force?: boolean }) => void;
  installHubMcp: (name: string) => Promise<{ ok: boolean; message: string }>;
  uninstallSkill: (name: string) => void;
  readSkill: (name: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkill: (input: { name: string; path?: string; content: string; description?: string }) => Promise<SkillSaveResult>;
  readSkillInstanceFiles: (target: SkillMutationTarget) => Promise<{ files: SkillFileEntry[] } | null>;
  readSkillInstance: (target: SkillMutationTarget) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkillInstance: (target: SkillMutationTarget, content: string) => Promise<SkillSaveResult>;
  setSkillInstanceEnabled: (target: SkillMutationTarget, enabled: boolean) => Promise<SkillSaveResult>;
  deleteSkillInstance: (target: SkillMutationTarget) => Promise<void>;
  removeSkillInstance: (target: SkillMutationTarget) => Promise<SkillSaveResult>;
  batchRemoveSkillInstances: (targets: SkillMutationTarget[]) => Promise<SkillSaveResult>;
  restoreSkillInstance: (target: SkillMutationTarget) => Promise<SkillSaveResult>;
  copySkillInstanceToGlobal: (target: SkillMutationTarget, options?: { deleteSource?: boolean }) => Promise<SkillSaveResult>;
  copySkillInstanceToWorkspace: (target: SkillMutationTarget, workspaceId: string) => Promise<SkillSaveResult>;
  importSkillCandidates: (candidateIds: string[]) => Promise<SkillSaveResult>;
  pluginsAccessHint?: string | null;
  canEditPlugins: boolean;
  canUseGlobalPluginScope: boolean;
  pluginScope: PluginScope;
  setPluginScope: (scope: PluginScope) => void;
  pluginConfigPath: string | null;
  pluginInventory?: PluginInventoryCard[];
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
  setPluginEnabled?: (pluginId: string, enabled: boolean) => Promise<void>;
  removeManagedPlugin?: (pluginId: string) => Promise<void>;
  restoreManagedPlugin?: (pluginId: string) => Promise<void>;
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
  aiAccessEffectiveModelLabel: string | null;
  showThinking: boolean;
  toggleShowThinking: () => void;
  sessionModelSelectorEnabled: boolean;
  toggleSessionModelSelector: () => void;
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
    retry?: UpdateDownloadRetryInfo;
  } | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  appVersion: string | null;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  retryUpdateDownload: () => void;
  installUpdateAndRestart: () => void;
  documentRuntimeStatus: DocumentRuntimeStatusPayload | null;
  documentRuntimeRepairBusy: boolean;
  repairDocumentRuntime: () => void;
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
  onUnarchiveArchivedSession: (
    workspaceId: string,
    sessionId: string,
    workspaceIdentity?: string | null,
    directory?: string | null,
  ) => Promise<void> | void;
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
        return t("nav.plugins", currentLocale());
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
    t("workspace.fallback_worker", currentLocale());
  const workspaceKindLabel = (workspace: WorkspaceInfo) =>
    workspace.workspaceType === "remote" ? "Remote" : "Local";

  const openSessionFromList = (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) => {
    void openSidebarSessionFromList({
      workspaceSessionGroups: props.workspaceSessionGroups,
      activeWorkspaceId: props.activeWorkspaceId,
      getActiveWorkspaceId: () => props.activeWorkspaceId,
      workspaceId,
      sessionId,
      target,
      activateWorkspace: props.activateWorkspace,
      setSessionBrowseScope: props.setSessionBrowseScope,
      selectSession: props.selectSession,
      setView: props.setView,
      reportError,
      sourceContext: "dashboard",
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

    void client.prefetchSessionTranscripts(serverWorkspaceId, interest, { appWorkspaceId: workspaceId }).catch((error) => {
      console.warn("[dashboard.loaded-session-prefetch] failed", {
        workspaceId,
        serverWorkspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(null);
  const [leftSidebarWidth, setLeftSidebarWidth] = createSignal(readLeftSidebarWidth());
  const [leftSidebarResizing, setLeftSidebarResizing] = createSignal(false);
  const [sidebarDockedVisibility, setSidebarDockedVisibility] = createSignal(
    readGlobalSidebarDockedPrefs(),
  );

  const leftSidebarVisible = createMemo(() => sidebarDockedVisibility().left);
  const rightSidebarVisible = createMemo(() => sidebarDockedVisibility().right);

  const toggleSidebarMenu = (side: "left" | "right") => {
    setSidebarDockedVisibility((current) => {
      const next =
        side === "left"
          ? { left: !current.left, right: current.right }
          : { left: current.left, right: !current.right };
      writeGlobalSidebarDockedPrefs(next);
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

    leftSidebarResizeCleanup = createLeftSidebarResizeCleanup({
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      previousUserSelect,
      previousCursor,
    });
  };

  onCleanup(() => stopLeftSidebarResize(false));

  createDashboardTabRefreshController({
    tab: () => props.tab,
    developerMode: () => props.developerMode,
    refreshSkillInventory: (options) => props.refreshSkillInventory(options),
    refreshSkills: (options) => props.refreshSkills(options),
    refreshPlugins: (scope, options) => props.refreshPlugins(scope, options),
    refreshMcpServers: () => props.refreshMcpServers(),
    refreshScheduledJobs: (options) => props.refreshScheduledJobs(options),
    refreshSoulData: (options) => props.refreshSoulData(options),
  });

  const runtimeAvailableWithoutClient = createMemo(() => {
    void props.clientConnected;
    void props.vesloServerStatus;
    void props.activeWorkspaceDisplay;
    return false;
  });

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

  const showDashboardTabRail = createMemo(() => shouldShowDashboardTabRail(props.tab));

  const handleSettingsButtonClick = () => {
    handleDashboardTabSelection("settings", "general");
  };

  const openSoulForWorkspace = (workspaceId?: string) => {
    const id = (workspaceId ?? props.activeWorkspaceId).trim();
    if (!id) return;
    void (async () => {
      if (id !== props.activeWorkspaceId) {
        const activated = await Promise.resolve(props.activateWorkspace(id, { origin: "dashboard:open-soul-workspace" }));
        if (!activated) return;
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

  const shareController = createWorkspaceShareController({
    shareWorkspaceId,
    workspaces: () => props.workspaces,
    workspaceLabel,
    t: (key) => t(key, currentLocale()),
    serverHostInfo: () => props.vesloServerHostInfo,
    serverSettings: () => props.vesloServerSettings,
    engineRuntime: () => props.engineInfo?.runtime ?? null,
    isDesktopRuntime: () => isTauriRuntime(),
    exportWorkspaceBusy: () => props.exportWorkspaceBusy,
    remoteTokenMissingPlaceholder: () => t("share.set_token_in_advanced", currentLocale()),
  });
  const shareWorkspace = shareController.shareWorkspace;
  const shareWorkspaceName = shareController.shareWorkspaceName;
  const shareWorkspaceDetail = shareController.shareWorkspaceDetail;
  const shareFields = shareController.shareFields;
  const shareNote = shareController.shareNote;
  const shareServiceDisabledReason = shareController.shareServiceDisabledReason;
  const exportDisabledReason = shareController.exportDisabledReason;
  const shareWorkspaceProfileBusy = shareController.shareWorkspaceProfileBusy;
  const shareWorkspaceProfileUrl = shareController.shareWorkspaceProfileUrl;
  const shareWorkspaceProfileError = shareController.shareWorkspaceProfileError;
  const shareSkillsSetBusy = shareController.shareSkillsSetBusy;
  const shareSkillsSetUrl = shareController.shareSkillsSetUrl;
  const shareSkillsSetError = shareController.shareSkillsSetError;
  const publishWorkspaceProfileLink = shareController.publishWorkspaceProfileLink;
  const publishSkillsSetLink = shareController.publishSkillsSetLink;

  const updatePillModel = createMemo(() => resolveDashboardUpdatePillModel({
    anyActiveRuns: props.anyActiveRuns,
    copy: {
      available: t("settings.sidebar_update_available", currentLocale()),
      downloadFailed: t("settings.update_download_failed", currentLocale()),
      downloading: t("settings.update_downloading", currentLocale()),
      downloadUpdate: t("settings.sidebar_download_update", currentLocale()),
      installing: t("settings.update_installing", currentLocale()),
      installUpdate: t("settings.sidebar_install_update", currentLocale()),
      preparing: t("settings.sidebar_update_preparing", currentLocale()),
      ready: t("settings.sidebar_update_ready", currentLocale()),
      retryDownload: t("settings.retry_update_download", currentLocale()),
      retryingDownload: t("settings.update_retrying_download", currentLocale()),
      stopRunsToUpdate: t("settings.stop_runs_to_update", currentLocale()),
    },
    isDesktopRuntime: isTauriRuntime(),
    updateAutoDownload: props.updateAutoDownload,
    updateStatus: props.updateStatus,
  }));
  const showUpdatePill = createMemo(() => updatePillModel().show);
  const updatePillLabel = createMemo(() => updatePillModel().label);
  const updatePillActionLabel = createMemo(() => updatePillModel().actionLabel);
  const updatePillActionDisabled = createMemo(() => updatePillModel().actionDisabled);
  const updatePillActionTitle = createMemo(() => updatePillModel().actionTitle);
  const updatePillButtonTone = createMemo(() => updatePillModel().buttonTone);
  const updatePillBorderTone = createMemo(() => updatePillModel().borderTone);
  const updatePillDotTone = createMemo(() => updatePillModel().dotTone);
  const updatePillVersionTone = createMemo(() => updatePillModel().versionTone);
  const updatePillTitle = createMemo(() => updatePillModel().title);

  const handleUpdatePillClick = () => {
    const action = updatePillModel().clickAction;
    if (action === "retry") {
      props.retryUpdateDownload();
      return;
    }
    if (action === "download") {
      props.downloadUpdate();
      return;
    }
    if (action === "install") {
      props.installUpdateAndRestart();
      return;
    }
    if (action === "open-settings") {
      openSettings("advanced");
    }
  };

  const leftMenuAction = createMemo(() =>
    resolveLeftMenuAction({
      tab: props.tab,
      selectedSessionId: props.selectedSessionId,
      lastWorkspaceSessionId: props.lastWorkspaceSessionId,
    }),
  );
  const leftMenuLabel = createMemo(() =>
    leftMenuAction().kind === "return-to-session" ? t("session.return_to_session", currentLocale()) : t("sidebar.toggle_left_menu", currentLocale()),
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
    const sessionId = props.selectedSessionId?.trim() || props.lastWorkspaceSessionId?.trim();
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
            onClick={() => props.onOpenFeedback()}
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
                  when={props.updateStatus?.state === "downloading" || props.updateStatus?.state === "installing"}
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
                        handleUpdatePillClick();
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
                unreadSessionIds={props.unreadSessionIds}
                archivedSessionIds={props.archivedSessionIds}
                activeWorkspaceId={props.activeWorkspaceId}
                selectedSessionId={props.selectedSessionId}
                selectedSessionKey={props.activeUiConversationRef?.key ?? null}
                sidebarSessionActivityByRowKey={props.sidebarSessionActivityByRowKey}
                allowSelectedParentExpansion={false}
                connectingWorkspaceId={props.connectingWorkspaceId}
                pendingPermissionCountByWs={props.pendingPermissionCountByWs}
                workspaceConnectionStateById={props.workspaceConnectionStateById}
                readyEngineWorkspaceIds={props.readyEngineWorkspaceIds}
                newTaskDisabled={props.newTaskDisabled}
                importingWorkspaceConfig={props.importingWorkspaceConfig}
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
          />
        </div>
          <SidebarStatusControls
            clientConnected={props.clientConnected}
            vesloServerConnection={props.vesloServerConnection}
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
            aria-label={__vesloT("ui.literal.resize_left_sidebar_1nybbn", __vesloCurrentLocale())}
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
          <Show when={showDashboardTabRail()}>
            <DashboardTabRail
              activeDashboardTab={props.tab}
              activeSettingsTab={props.settingsTab}
              onOpenSettingsTab={openSettings}
              onOpenDashboardTab={handleDashboardTabSelection}
              showDeveloperSettings={props.developerMode}
            />
          </Show>

          <Switch>
            <Match when={props.tab === "scheduled"}>
              <ScheduledTasksView
                automationItems={props.automationItems}
                automationWorkspaces={props.automationWorkspaces}
                defaultAutomationWorkspaceId={props.defaultAutomationWorkspaceId}
                source={props.scheduledJobsSource}
                sourceReady={props.scheduledJobsSourceReady}
                status={props.scheduledJobsStatus}
                busy={props.scheduledJobsBusy}
                lastUpdatedAt={props.scheduledJobsUpdatedAt}
                refreshJobs={props.refreshScheduledJobs}
                createAutomation={props.createAutomation}
                updateAutomation={props.updateAutomation}
                deleteAutomation={props.deleteAutomation}
                runAutomation={props.runAutomation}
                newTaskDisabled={props.newTaskDisabled}
                reloadWorkspaceEngine={props.reloadScheduledAutomationsSource}
                reloadBusy={props.reloadBusy}
                canReloadWorkspace={props.canReloadWorkspace}
              />
            </Match>
            <Match when={props.tab === "soul"}>
              <SoulView
                soulOverview={props.soulOverview}
                soulOverviewError={props.soulOverviewError}
                soulOverviewBusy={props.soulOverviewBusy}
                client={props.soulClient}
                serverConnected={props.soulServerConnected}
                authContext={props.soulAuthContext}
                refresh={props.refreshSoulData}
                workspaces={props.workspaces}
                activeWorkspaceId={props.activeWorkspaceId}
                soulWorkspaceMap={props.soulWorkspaceMap}
                busySessionByWorkspaceId={props.busySessionByWorkspaceId}
                reloadWorkspaceEngine={props.reloadWorkspaceEngine}
                isPrivateWorkspacePath={props.isPrivateWorkspacePath}
              />
            </Match>
            <Match when={props.tab === "skills"}>
              <SkillsView
                workspaceName={props.activeWorkspaceDisplay.name}
                activeWorkspaceId={props.activeWorkspaceId}
                activeWorkspaceRoot={props.activeWorkspaceRoot}
                isRemoteWorkspace={props.isRemoteWorkspace}
                isPrivateWorkspacePath={props.isPrivateWorkspacePath}
                busy={props.busy}
                vesloServerStatus={props.vesloServerStatus}
                vesloServerClient={props.vesloServerClient}
                vesloServerCanWriteSkills={props.vesloServerCanWriteSkills}
                vesloServerSkillRegistryAvailable={props.vesloServerSkillRegistryAvailable}
                skillRegistryAuthContext={props.skillRegistryAuthContext}
                canInstallSkillCreator={props.canInstallSkillCreator}
                canUseDesktopTools={props.canUseDesktopTools}
                accessHint={props.skillsAccessHint}
                refreshSkills={props.refreshSkills}
                refreshSkillInventory={props.refreshSkillInventory}
                refreshSkillImportCandidates={props.refreshSkillImportCandidates}
                refreshHubSkills={props.refreshHubSkills}
                skills={props.skills}
                skillsStatus={props.skillsStatus}
                skillInventory={props.skillInventory}
                skillInventoryStatus={props.skillInventoryStatus}
                skillImportCandidates={props.skillImportCandidates}
                skillImportStatus={props.skillImportStatus}
                hubSkills={props.hubSkills}
                hubSkillsStatus={props.hubSkillsStatus}
                workspaces={props.workspaces}
                installSkillCreator={props.installSkillCreator}
                installHubSkill={props.installHubSkill}
                uninstallSkill={props.uninstallSkill}
                readSkill={props.readSkill}
                saveSkill={props.saveSkill}
                readSkillInstanceFiles={props.readSkillInstanceFiles}
                readSkillInstance={props.readSkillInstance}
                saveSkillInstance={props.saveSkillInstance}
                setSkillInstanceEnabled={props.setSkillInstanceEnabled}
                deleteSkillInstance={props.deleteSkillInstance}
                removeSkillInstance={props.removeSkillInstance}
                batchRemoveSkillInstances={props.batchRemoveSkillInstances}
                restoreSkillInstance={props.restoreSkillInstance}
                copySkillInstanceToGlobal={props.copySkillInstanceToGlobal}
                copySkillInstanceToWorkspace={props.copySkillInstanceToWorkspace}
                importSkillCandidates={props.importSkillCandidates}
                createSessionAndOpen={props.createSessionAndOpen}
                setPrompt={props.setPrompt}
              />
            </Match>

            <Match when={props.tab === "plugins"}>
              <PluginsView
                busy={props.busy}
                developerMode={props.developerMode}
                activeWorkspaceRoot={props.activeWorkspaceRoot}
                canEditPlugins={props.canEditPlugins}
                canUseGlobalScope={props.canUseGlobalPluginScope}
                accessHint={props.pluginsAccessHint}
                pluginScope={props.pluginScope}
                setPluginScope={props.setPluginScope}
                pluginConfigPath={props.pluginConfigPath}
                pluginInventory={props.pluginInventory ?? []}
                pluginList={props.pluginList}
                pluginInput={props.pluginInput}
                setPluginInput={props.setPluginInput}
                pluginStatus={props.pluginStatus}
                activePluginGuide={props.activePluginGuide}
                setActivePluginGuide={props.setActivePluginGuide}
                isPluginInstalled={props.isPluginInstalled}
                suggestedPlugins={props.suggestedPlugins}
                refreshPlugins={props.refreshPlugins}
                addPlugin={props.addPlugin}
                setPluginEnabled={props.setPluginEnabled}
                removeManagedPlugin={props.removeManagedPlugin}
                restoreManagedPlugin={props.restoreManagedPlugin}
                removePlugin={props.removePlugin}
              />
            </Match>

            <Match when={props.tab === "mcp"}>
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
                  onOpenDashboardTab={(nextTab) => handleDashboardTabSelection(nextTab)}
                  vesloServerStatus={props.vesloServerStatus}
                  vesloServerUrl={props.vesloServerUrl}
                  vesloReconnectBusy={props.vesloReconnectBusy}
                  reconnectVesloServer={props.reconnectVesloServer}
                  vesloServerHostInfo={props.vesloServerHostInfo}
                  vesloServerCapabilities={props.vesloServerCapabilities}
                  vesloServerDiagnostics={props.vesloServerDiagnostics}
                  vesloServerWorkspaceId={props.vesloServerWorkspaceId}
                  activeWorkspaceRoot={props.activeWorkspaceRoot}
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
                  aiAccessEffectiveModelLabel={props.aiAccessEffectiveModelLabel}
                  showThinking={props.showThinking}
                  toggleShowThinking={props.toggleShowThinking}
                  sessionModelSelectorEnabled={props.sessionModelSelectorEnabled}
                  toggleSessionModelSelector={props.toggleSessionModelSelector}
                  hideTitlebar={props.hideTitlebar}
                  toggleHideTitlebar={props.toggleHideTitlebar}
                  maxEngines={props.maxEngines}
                  setMaxEngines={props.setMaxEngines}
                  idleSuspendMs={props.idleSuspendMs}
                  setIdleSuspendMs={props.setIdleSuspendMs}
                  modelVariantLabel={props.modelVariantLabel}
                  modelVariant={props.modelVariant}
                  setModelVariant={props.setModelVariant}
                  language={props.language}
                  setLanguage={props.setLanguage}
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
                  retryUpdateDownload={props.retryUpdateDownload}
                  installUpdateAndRestart={props.installUpdateAndRestart}
                  documentRuntimeStatus={props.documentRuntimeStatus}
                  documentRuntimeRepairBusy={props.documentRuntimeRepairBusy}
                  repairDocumentRuntime={props.repairDocumentRuntime}
                  anyActiveRuns={props.anyActiveRuns}
                  onResetStartupPreference={props.onResetStartupPreference}
                  openResetModal={props.openResetModal}
                  resetModalBusy={props.resetModalBusy}
                  pendingPermissions={props.pendingPermissions}
                  events={props.events}
                  workspaceDebugEvents={props.workspaceDebugEvents}
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
                    {props.cacheRepairBusy ? __vesloT("dashboard.repairing_cache", __vesloCurrentLocale()) : __vesloT("dashboard.repair_cache", __vesloCurrentLocale())}
                  </Button>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3"
                    onClick={props.stopHost}
                    disabled={props.busy}
                  >
                    {__vesloT("dashboard.retry", __vesloCurrentLocale())}</Button>
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
              class={`flex flex-col items-center gap-1 text-xs min-w-0 ${
                props.tab === "soul" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => handleDashboardTabSelection("soul")}
            >
              <HeartPulse size={18} />
              <span class="max-w-full text-center leading-tight [overflow-wrap:anywhere]">
                {t("nav.soul", currentLocale())}
              </span>
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs min-w-0 ${
                props.tab === "skills" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => handleDashboardTabSelection("skills")}
            >
              <Zap size={18} />
              <span class="max-w-full text-center leading-tight [overflow-wrap:anywhere]">
                {t("nav.skills", currentLocale())}
              </span>
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs min-w-0 ${
                props.tab === "mcp" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => handleDashboardTabSelection("mcp")}
            >
              <Box size={18} />
              <span class="max-w-full text-center leading-tight [overflow-wrap:anywhere]">
                {t("nav.extensions", currentLocale())}
              </span>
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs min-w-0 ${
                props.tab === "plugins" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => handleDashboardTabSelection("plugins")}
            >
              <Cpu size={18} />
              <span class="max-w-full text-center leading-tight [overflow-wrap:anywhere]">
                {t("nav.plugins", currentLocale())}
              </span>
            </button>
            <Show when={props.developerMode}>
              <button
                class={`flex flex-col items-center gap-1 text-xs min-w-0 ${
                  props.tab === "config" ? "text-gray-12" : "text-gray-10"
                }`}
                onClick={() => handleDashboardTabSelection("config")}
              >
                <SlidersHorizontal size={18} />
                <span class="max-w-full text-center leading-tight [overflow-wrap:anywhere]">
                  {t("nav.advanced", currentLocale())}
                </span>
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
