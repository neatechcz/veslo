import { createMemo, type Accessor, type Setter } from "solid-js";

import type { Agent, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client";

import { currentLocale, t, type Language } from "../i18n";
import { CLOUD_ONLY_MODE } from "./lib/cloud-policy";
import { unwrap } from "./lib/opencode";
import { normalizeModelVariant } from "./lib/model-variant";
import { isTauriRuntime, isWindowsPlatform, preferredSessionWorkspaceRoot } from "./utils";
import type { ErrorSeverity } from "./lib/error-reporter";
import type { EngineSourcePreference } from "./lib/engine-source";
import type { ManagedAiAccessProfile } from "./lib/ai-access";
import type { DocumentRuntimeStatusPayload } from "./lib/document-runtime";
import type { McpServersRefreshOptions } from "./lib/mcp-server-refresh";
import type { SessionSubmitResult } from "./lib/session-send-contract";
import type { SidebarSessionActivity } from "./context/sidebar-session-activity-projection";
import type { SkillMutationTarget } from "./lib/skill-inventory";
import type { SessionCapabilitiesSnapshot } from "./lib/session-capabilities";
import type { UiConversationRef } from "./lib/ui-conversation-scope";
import type { OpencodeConfigFile } from "./lib/tauri-types";
import type {
  EngineDoctorResult,
  EngineInfo,
  OpenCodeRouterInfo,
  OrchestratorStatus,
  PendingSessionDraftSummary,
  UpdaterEnvironment,
  VesloServerInfo,
  WorkspaceInfo,
} from "./lib/tauri";
import type {
  VesloServerCapabilities,
  VesloServerClient,
  VesloServerConnectionSnapshot,
  VesloServerDiagnostics,
  VesloServerSettings,
  VesloServerStatus,
  VesloSkillImportCandidate,
  VesloSkillRegistryAuthContext,
} from "./lib/veslo-server";
import type {
  ArtifactItem,
  ComposerDraft,
  ComposerTargetOption,
  ComposerTargetSwitchResult,
  DashboardTab,
  EngineRuntime,
  HubMcpCard,
  HubSkillCard,
  HubSkillInstallTarget,
  McpServerEntry,
  McpStatusMap,
  MessageGroup,
  MessageWithParts,
  OnboardingStep,
  OpencodeConnectStatus,
  OpencodeEvent,
  PendingPermission,
  PendingQuestion,
  PluginScope,
  ReloadTrigger,
  ResetVesloMode,
  SessionArchiveItem,
  SessionErrorTurn,
  SettingsTab,
  SidebarSubagentDecoration,
  SkillCard,
  SkillFileEntry,
  SkillInstance,
  SkillInventoryItem,
  SkillSaveResult,
  StartupPreference,
  SuggestedPlugin,
  TodoItem,
  View,
  WorkspaceDisplay,
  WorkspaceSessionGroup,
} from "./types";
import type { ThemeMode } from "./theme";
import type { OnboardingViewProps } from "./pages/onboarding";
import type { DashboardViewProps } from "./pages/dashboard";
import type { SessionViewProps } from "./pages/session";
import type { ArtifactFamily } from "./components/session/artifact-family-model";
import type { UnreadSessionMap } from "./components/session/session-unread-model";
import type { SidebarSessionOpenTarget } from "./components/session/workspace-session-list-model";
import type { McpDirectoryInfo } from "./constants";
import type { ConversationAbortTarget } from "./context/conversation-service";
import type { createComposerTargetController } from "./context/composer-target-controller";
import type { SessionArchiveTarget } from "./context/session-archive-store";
import type { SessionCapabilitiesLoadStatus } from "./context/session-capabilities-store";
import type { SessionRunDiagnostic } from "./context/session-lifecycle-recovery";
import type { ReconnectNotice, ReconnectState } from "./context/session-reconnect";
import type { SelectedSessionHistoryUnavailable } from "./context/session-selection-controller";
import type { SessionStore } from "./context/session";
import type { WorkspaceBusyMap } from "./context/workspace-debug";
import type { WorkspaceActivationOptions } from "./context/workspace-types";
import type { WorkspaceStore } from "./context/workspace";
import type { createPendingSessionDraftController } from "./context/pending-session-draft-controller";
import type { createScheduledAutomationStore } from "./pages/scheduled-automation-store";
import type { SessionCreationWorkflowCreateOptions } from "./pages/session-creation-workflow";
import type { SessionBrowseScope } from "./pages/session-navigation";
import type {
  SessionMutationCommand,
  SessionMutationCommandListScope,
  SessionMutationReplaceOptions,
} from "./pages/session-mutation-workflow";
import type { SessionSendWorkflowSendOptions } from "./pages/session-send-workflow";
import type { createSoulDataStore } from "./pages/soul-data-store";

export type DashboardViewAdapterProps = Omit<DashboardViewProps, "onOpenFeedback">;
export type SessionViewAdapterProps = Omit<SessionViewProps, "onOpenFeedback">;

type DashboardWorkspaceType = "local" | "remote" | string | null | undefined;
const STATUS_SEPARATOR = ` ${String.fromCharCode(183)} `;

type RefreshOptions = { force?: boolean };
type RefreshAction = (optionsOverride?: RefreshOptions) => Promise<void>;
type ScheduledAutomationStore = ReturnType<typeof createScheduledAutomationStore>;
type SoulDataStore = ReturnType<typeof createSoulDataStore>;
type PendingSessionDraftController = ReturnType<typeof createPendingSessionDraftController>;
type ComposerTargetController = ReturnType<typeof createComposerTargetController>;
type ManagedSkillMutationTarget = SkillMutationTarget & {
  registry?: SkillInstance["registry"];
  restoreTarget?: SkillInstance["restoreTarget"];
};
type McpInstallResult = {
  ok: boolean;
  message: string;
  entry?: HubMcpCard | null;
};
type DownloadUpdateOptions = {
  automatic?: boolean;
  retryAttempt?: number;
  refreshBeforeDownload?: boolean;
};
type ActiveReloadBlockingSession = {
  id: string;
  title: string;
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};
type SidebarSectionsState = {
  progress: boolean;
  artifacts: boolean;
  context: boolean;
  plugins: boolean;
  mcp: boolean;
  skills: boolean;
  authorizedFolders: boolean;
};

export type HeaderConnectedVersionInput = {
  connectedVersion?: string | null;
  developerMode: boolean;
  appVersion?: string | null;
  vesloServerDiagnosticsVersion?: string | null;
};

export function resolveHeaderConnectedVersion(input: HeaderConnectedVersionInput): string | null {
  const fallbackVersion = input.connectedVersion?.trim() ?? "";
  if (!input.developerMode) {
    return fallbackVersion || null;
  }

  const vesloVersion = input.appVersion?.trim() || input.vesloServerDiagnosticsVersion?.trim() || "";
  if (!vesloVersion) {
    return fallbackVersion || null;
  }

  const normalizedVersion = vesloVersion.startsWith("v") ? vesloVersion : `v${vesloVersion}`;
  return `Veslo ${normalizedVersion}`;
}

export type HeaderStatusInput = {
  clientConnected: boolean;
  headerConnectedVersion: string | null;
  sseConnected: boolean;
  connectedLabel: string;
  disconnectedLabel: string;
  liveLabel: string;
};

export function resolveHeaderStatus(input: HeaderStatusInput): string {
  if (!input.clientConnected || !input.headerConnectedVersion) return input.disconnectedLabel;
  const bits = [`${input.connectedLabel}${STATUS_SEPARATOR}${input.headerConnectedVersion}`];
  if (input.sseConnected) bits.push(input.liveLabel);
  return bits.join(STATUS_SEPARATOR);
}

export type BusyHintInput = {
  busy: boolean;
  busyLabel?: string | null;
  busySeconds: number;
  translateBusyLabel: (key: string) => string;
};

export function resolveBusyHint(input: BusyHintInput): string | null {
  if (!input.busy || !input.busyLabel) return null;
  const label = input.translateBusyLabel(input.busyLabel);
  return input.busySeconds > 0 ? `${label}${STATUS_SEPARATOR}${input.busySeconds}s` : label;
}

export type LocalHostLabelInput = {
  engine?: { hostname?: string | null; port?: number | string | null } | null;
  baseUrl: string;
  fallback?: string;
};

export function resolveLocalHostLabel(input: LocalHostLabelInput): string {
  const info = input.engine;
  if (info?.hostname && info?.port) {
    return `${info.hostname}:${info.port}`;
  }

  try {
    return new URL(input.baseUrl).host;
  } catch {
    return input.fallback ?? "localhost:4096";
  }
}

export type DashboardViewAccessInput = {
  workspaceType: DashboardWorkspaceType;
  vesloServerStatus: VesloServerStatus | string;
  vesloServerCanWriteSkills: boolean;
  vesloServerCanWritePlugins: boolean;
  tauriRuntime: boolean;
};

export type DashboardViewAccess = {
  canUseDesktopTools: boolean;
  canInstallSkillCreator: boolean;
  canEditPlugins: boolean;
  canUseGlobalPluginScope: boolean;
  skillsAccessHint: string | null;
  pluginsAccessHint: string | null;
};

export function resolveDashboardViewAccess(input: DashboardViewAccessInput): DashboardViewAccess {
  const isRemoteWorkspace = input.workspaceType === "remote";
  const canUseDesktopTools = input.tauriRuntime && !isRemoteWorkspace;
  const canInstallSkillCreator = isRemoteWorkspace ? input.vesloServerCanWriteSkills : input.tauriRuntime;
  const canEditPlugins = isRemoteWorkspace ? input.vesloServerCanWritePlugins : input.tauriRuntime;
  const canUseGlobalPluginScope = !isRemoteWorkspace && input.tauriRuntime;
  const skillsAccessHint = isRemoteWorkspace
    ? input.vesloServerStatus === "disconnected"
      ? "Veslo server unavailable. Add the server URL/token in Advanced to manage skills."
      : input.vesloServerStatus === "limited"
        ? "Veslo server needs a host token to install/update skills. Add it in Advanced and reconnect."
        : input.vesloServerCanWriteSkills
          ? null
          : "Veslo server is read-only for skills. Add a host token in Advanced to enable installs."
    : null;
  const pluginsAccessHint = isRemoteWorkspace
    ? input.vesloServerStatus === "disconnected"
      ? "Veslo server unavailable. Plugins are read-only."
      : input.vesloServerStatus === "limited"
        ? "Veslo server needs a token to edit plugins."
        : input.vesloServerCanWritePlugins
          ? null
          : "Veslo server is read-only for plugins."
    : null;

  return {
    canUseDesktopTools,
    canInstallSkillCreator,
    canEditPlugins,
    canUseGlobalPluginScope,
    skillsAccessHint,
    pluginsAccessHint,
  };
}

export type AppViewPropsScope = {
  connectedVersion: Accessor<string | null>;
  developerMode: () => boolean;
  appVersion: Accessor<string | null>;
  vesloServerDiagnostics: Accessor<VesloServerDiagnostics | null>;
  routedClient: (workspaceId?: string) => OpencodeClient | null;
  sseConnected: Accessor<boolean>;
  busy: Accessor<boolean>;
  busyLabel: Accessor<string | null>;
  busySeconds: Accessor<number>;
  engine: Accessor<EngineInfo | null>;
  baseUrl: Accessor<string>;
  startupPreference: Accessor<StartupPreference | null>;
  onboardingStep: Accessor<OnboardingStep>;
  rememberStartupChoice: Accessor<boolean>;
  clientDirectory: Accessor<string>;
  vesloServerSettings: Accessor<VesloServerSettings>;
  newAuthorizedDir: Accessor<string>;
  workspaceStore: WorkspaceStore;
  engineDoctorResult: Accessor<EngineDoctorResult | null>;
  engineDoctorCheckedAt: Accessor<number | null>;
  engineInstallLogs: Accessor<string | null>;
  error: Accessor<string | null>;
  migrationRepairUnavailableReason: Accessor<string | null>;
  showRemoteActions: Accessor<boolean>;
  setClientDirectory: Setter<string>;
  updateVesloServerSettings: (next: VesloServerSettings) => void;
  setLocale: (newLocale: Language) => void;
  setTab: (nextTab: DashboardTab) => void;
  setView: (next: View, sessionId?: string) => void;
  setThemeMode: Setter<ThemeMode>;
  startDesktopBrowserSignIn: () => Promise<void>;
  resumeDesktopBrowserSignIn: () => Promise<void>;
  authCompleteExchangeBusy: () => boolean;
  denKeepSignedIn: Accessor<boolean>;
  setDenKeepSignedInPreference: (value: boolean) => void;
  themeMode: Accessor<ThemeMode>;
  activeWorkspaceDisplay: Accessor<WorkspaceDisplay>;
  vesloServerStatus: Accessor<VesloServerStatus>;
  vesloServerConnectionSnapshot: Accessor<VesloServerConnectionSnapshot>;
  vesloServerCanWriteSkills: Accessor<boolean>;
  vesloServerSkillRegistryAvailable: Accessor<boolean>;
  skillRegistryMaterializationAuthContext: () => VesloSkillRegistryAuthContext;
  vesloServerCanWritePlugins: Accessor<boolean>;
  tab: Accessor<DashboardTab>;
  settingsTab: Accessor<SettingsTab>;
  setSettingsTab: Setter<SettingsTab>;
  currentView: Accessor<View>;
  setSessionBrowseScope: (scope: SessionBrowseScope) => void;
  authenticatedUser: () => string | null;
  logoutLocalDenAuth: () => Promise<void>;
  newTaskDisabled: Accessor<boolean>;
  sessionStore: SessionStore;
  vesloServerUrl: Accessor<string>;
  hydratedVesloServerClient: Accessor<VesloServerClient | null>;
  vesloReconnectBusy: Accessor<boolean>;
  reconnectVesloServer: () => Promise<boolean>;
  vesloServerHostInfo: Accessor<VesloServerInfo | null>;
  devtoolsCapabilities: Accessor<VesloServerCapabilities | null>;
  resolvedDevtoolsWorkspaceId: Accessor<string | null>;
  opencodeConnectStatus: Accessor<OpencodeConnectStatus | null>;
  orchestratorStatusState: Accessor<OrchestratorStatus | null>;
  opencodeRouterInfoState: Accessor<OpenCodeRouterInfo | null>;
  resetVesloServerSettings: () => void;
  testVesloServerConnection: (next: VesloServerSettings) => Promise<boolean>;
  canReloadWorkspace: Accessor<boolean>;
  reloadWorkspaceEngine: () => Promise<boolean>;
  refreshWorkspaceConfigForPath: (workspacePath?: string) => Promise<void>;
  scheduledAutomationStore: ScheduledAutomationStore;
  soulDataStore: SoulDataStore;
  reloadBusy: Accessor<boolean>;
  reloadError: Accessor<string | null>;
  readyEngineWorkspaceIds: Accessor<Set<string>>;
  handleActivateWorkspace: (
    workspaceId: string | undefined,
    activationOptions: WorkspaceActivationOptions,
  ) => Promise<boolean>;
  openCreateRemoteWorkspace: () => void;
  openNewSessionWithDirectory: () => Promise<boolean>;
  pendingSessionDraftController: PendingSessionDraftController;
  sidebarWorkspaceGroups: Accessor<WorkspaceSessionGroup[]>;
  unreadSessionIds: Accessor<UnreadSessionMap>;
  workspaceSessionPagingById: Accessor<Record<string, { hasMore: boolean; loadingMore: boolean }>>;
  subagentDecorationsBySessionId: () => Record<string, SidebarSubagentDecoration>;
  archivedSessionIds: Accessor<string[]>;
  activeSessionStatusById: Accessor<Record<string, string>>;
  sidebarSessionActivityByRowKey: Accessor<Record<string, SidebarSessionActivity>>;
  conversationRunDiagnosticsBySessionKey: () => Record<string, SessionRunDiagnostic>;
  busySessionByWorkspaceId: Accessor<WorkspaceBusyMap>;
  archiveSidebarSessionAndClearActive: (
    workspaceId: string,
    sessionId: string,
    target?: SidebarSessionOpenTarget | null,
  ) => Promise<void>;
  reportError: (error: unknown, context: string, severity?: ErrorSeverity) => void;
  setError: Setter<string | null>;
  safeStringify: (value: unknown) => string;
  unarchiveSession: (
    workspaceId: string,
    sessionId: string,
    workspaceIdentityHint?: string | null,
    target?: SessionArchiveTarget | null,
  ) => Promise<void>;
  loadMoreWorkspaceSidebarSessions: (workspaceId: string) => Promise<void>;
  activeSessionId: Accessor<string | null>;
  activeWorkspaceLastSessionId: () => string | null;
  openRenameWorkspace: (workspaceId: string) => void;
  openWorkspaceConnectionSettings: (workspaceId: string) => void;
  refreshSkills: RefreshAction;
  refreshSkillInventory: RefreshAction;
  refreshSkillImportCandidates: RefreshAction;
  refreshHubSkills: RefreshAction;
  refreshPlugins: (scopeOverride?: PluginScope, optionsOverride?: { debug?: boolean }) => Promise<void>;
  skills: Accessor<SkillCard[]>;
  skillsStatus: Accessor<string | null>;
  skillInventory: Accessor<SkillInventoryItem[]>;
  skillInventoryStatus: Accessor<string | null>;
  skillImportCandidates: Accessor<VesloSkillImportCandidate[]>;
  skillImportStatus: Accessor<string | null>;
  hubSkills: Accessor<HubSkillCard[]>;
  hubSkillsStatus: Accessor<string | null>;
  installSkillCreator: () => Promise<{ ok: boolean; message: string }>;
  installHubSkill: (name: string, target: HubSkillInstallTarget) => Promise<{ ok: boolean; message: string }>;
  uninstallSkill: (name: string) => Promise<void>;
  readSkill: (name: string, instancePath?: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkill: (input: { name: string; path?: string; content: string; description?: string }) => Promise<SkillSaveResult>;
  readSkillInstanceFiles: (target: SkillMutationTarget) => Promise<{ files: SkillFileEntry[] } | null>;
  readSkillInstance: (target: SkillMutationTarget) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkillInstance: (target: SkillMutationTarget, content: string) => Promise<SkillSaveResult>;
  setSkillInstanceEnabled: (target: SkillMutationTarget, enabled: boolean) => Promise<SkillSaveResult>;
  deleteSkillInstance: (target: SkillMutationTarget) => Promise<void>;
  removeSkillInstance: (target: ManagedSkillMutationTarget) => Promise<SkillSaveResult>;
  batchRemoveSkillInstances: (targets: ManagedSkillMutationTarget[]) => Promise<SkillSaveResult>;
  restoreSkillInstance: (target: ManagedSkillMutationTarget) => Promise<SkillSaveResult>;
  copySkillInstanceToGlobal: (
    target: SkillMutationTarget,
    optionsOverride?: { deleteSource?: boolean },
  ) => Promise<SkillSaveResult>;
  copySkillInstanceToWorkspace: (target: SkillMutationTarget, workspaceId: string) => Promise<SkillSaveResult>;
  importSkillCandidates: (candidateIds: string[]) => Promise<SkillSaveResult>;
  pluginScope: Accessor<PluginScope>;
  setPluginScope: Setter<PluginScope>;
  pluginConfigPath: Accessor<string | null>;
  pluginConfig: Accessor<OpencodeConfigFile | null>;
  pluginList: Accessor<string[]>;
  pluginInput: Accessor<string>;
  setPluginInput: Setter<string>;
  pluginStatus: Accessor<string | null>;
  activePluginGuide: Accessor<string | null>;
  setActivePluginGuide: Setter<string | null>;
  isPluginInstalledByName: (pluginName: string, aliases?: string[]) => boolean;
  localizedSuggestedPlugins: Accessor<SuggestedPlugin[]>;
  addPlugin: (pluginNameOverride?: string) => Promise<void>;
  removePlugin: (pluginName: string) => Promise<void>;
  createSessionAndOpen: (
    initialTitle?: string,
    options?: SessionCreationWorkflowCreateOptions,
  ) => Promise<string | undefined>;
  setPrompt: (value: string) => void;
  selectSession: (sessionID: string) => Promise<void>;
  managedAiAccessBusy: Accessor<boolean>;
  managedAiAccess: Accessor<ManagedAiAccessProfile | null>;
  managedAiAccessMessage: Accessor<string>;
  managedAiAccessProviderLabel: Accessor<string | null>;
  managedAiAccessEffectiveModelLabel: Accessor<string | null>;
  showThinking: Accessor<boolean>;
  setShowThinking: Setter<boolean>;
  sessionModelSelectorEnabled: Accessor<boolean>;
  setSessionModelSelectorEnabled: Setter<boolean>;
  hideTitlebar: Accessor<boolean>;
  setHideTitlebar: Setter<boolean>;
  maxEngines: Accessor<number>;
  setMaxEngines: Setter<number>;
  idleSuspendMs: Accessor<number>;
  setIdleSuspendMs: Setter<number>;
  formatModelVariantLabel: (value: string | null) => string;
  modelVariant: Accessor<string | null>;
  setModelVariant: Setter<string | null>;
  updateAutoDownload: Accessor<boolean>;
  setUpdateAutoDownload: Setter<boolean>;
  setUpdateAutoCheck: Setter<boolean>;
  updateStatus: Accessor<DashboardViewProps["updateStatus"]>;
  updateEnv: Accessor<UpdaterEnvironment | null>;
  checkForUpdates: (optionsCheck?: { quiet?: boolean }) => Promise<void>;
  downloadUpdate: (optionsDownload?: DownloadUpdateOptions) => Promise<void>;
  retryUpdateDownload: () => Promise<void>;
  installUpdateAndRestart: () => Promise<void>;
  documentRuntimeStatus: Accessor<DocumentRuntimeStatusPayload | null>;
  documentRuntimeRepairBusy: Accessor<boolean>;
  repairDocumentRuntime: () => Promise<void>;
  anyActiveRuns: Accessor<boolean>;
  engineSource: Accessor<EngineSourcePreference>;
  updateEngineSource: (value: EngineSourcePreference, options?: { explicit?: boolean }) => void;
  engineCustomBinPath: Accessor<string>;
  setEngineCustomBinPath: Setter<string>;
  engineRuntime: Accessor<EngineRuntime>;
  setEngineRuntime: Setter<EngineRuntime>;
  stopHost: () => Promise<void>;
  restartLocalServer: () => Promise<boolean>;
  openResetModal: (mode: ResetVesloMode) => void;
  resetModalBusy: Accessor<boolean>;
  clearStartupPreference: () => void;
  setStartupPreference: Setter<StartupPreference | null>;
  setRememberStartupChoice: Setter<boolean>;
  toggleDenKeepSignedIn: () => void;
  pendingPermissions: () => PendingPermission[];
  events: () => OpencodeEvent[];
  repairOpencodeCache: () => Promise<void>;
  cacheRepairBusy: Accessor<boolean>;
  cacheRepairResult: Accessor<string | null>;
  cleanupVesloDockerContainers: () => Promise<void>;
  dockerCleanupBusy: () => boolean;
  dockerCleanupResult: () => string | null;
  resetAppConfigDefaults: () => Promise<{ ok: boolean; message: string }>;
  notionStatus: Accessor<"connected" | "disconnected" | "error" | "connecting">;
  notionStatusDetail: Accessor<string | null>;
  notionError: Accessor<string | null>;
  notionBusy: Accessor<boolean>;
  connectNotion: () => Promise<void>;
  sessionArchives: Accessor<SessionArchiveItem[]>;
  mcpServers: Accessor<McpServerEntry[]>;
  mcpStatus: Accessor<string | null>;
  mcpLastUpdatedAt: Accessor<number | null>;
  mcpStatuses: Accessor<McpStatusMap>;
  mcpConnectingName: Accessor<string | null>;
  selectedMcp: Accessor<string | null>;
  setSelectedMcp: Setter<string | null>;
  localizedMcpQuickConnect: Accessor<McpDirectoryInfo[]>;
  hubMcpCards: Accessor<HubMcpCard[]>;
  hubMcpStatus: Accessor<string | null>;
  refreshHubMcp: RefreshAction;
  installHubMcpAndActivate: (name: string) => Promise<McpInstallResult>;
  connectMcp: (entry: McpDirectoryInfo) => Promise<void>;
  authorizeMcp: (entry: McpServerEntry) => Promise<void>;
  logoutMcpAuth: (name: string) => Promise<void>;
  removeMcp: (name: string) => Promise<void>;
  refreshMcpServers: (refreshOptions?: McpServersRefreshOptions) => Promise<void>;
  activePendingDraftKey: Accessor<string | null>;
  activePendingDraftMeta: Accessor<PendingSessionDraftSummary | null>;
  composerTargetController: ComposerTargetController;
  resolveSelectedSessionBrowseScope: (sessionId: string) => SessionBrowseScope | null;
  resolveSessionDirectory: (session: Pick<Session, "id" | "directory">) => string;
  selectedSession: () => Session | null;
  activeUiConversationRef: Accessor<UiConversationRef>;
  activeWorkspaceHasRoutingEntry: () => boolean;
  sessionsLoadedForActiveWorkspace: () => boolean;
  chooseFolderForCurrentSession: () => Promise<boolean>;
  engineReady: Accessor<boolean>;
  vesloServerWorkspaceId: Accessor<string | null>;
  sidebarPluginList: Accessor<string[]>;
  sidebarPluginStatus: Accessor<string | null>;
  sessionCapabilitiesSnapshot: Accessor<SessionCapabilitiesSnapshot | null>;
  sessionCapabilitiesStatus: Accessor<SessionCapabilitiesLoadStatus>;
  sessionCapabilitiesError: Accessor<string | null>;
  reloadRequired: Accessor<boolean>;
  reloadTrigger: Accessor<ReloadTrigger | null>;
  reloadCopy: Accessor<{ title: string; body: string }>;
  activeReloadBlockingSessions: Accessor<ActiveReloadBlockingSession[]>;
  forceStopActiveSessionsAndReload: () => Promise<void>;
  clearReloadRequired: () => void;
  sendPrompt: (draft: ComposerDraft, options: SessionSendWorkflowSendOptions) => Promise<SessionSubmitResult>;
  replaceUserMessage: (
    messageID: string,
    draft: ComposerDraft,
    options: SessionMutationReplaceOptions,
  ) => Promise<SessionSubmitResult>;
  clearComposerDraftForSession: (sessionId: string | null | undefined) => void;
  abortSession: (sessionId?: string, target?: ConversationAbortTarget) => Promise<void>;
  undoLastUserMessage: () => Promise<void>;
  redoLastUserMessage: () => Promise<void>;
  submitCurrentSessionCompaction: (sessionIdOverride?: string) => Promise<void>;
  lastPromptSent: Accessor<string>;
  lastPromptSentModelOverride: Accessor<import("./types").ModelRef | null>;
  clearLastPromptModelOverride: () => void;
  retryLastPrompt: () => void;
  selectedSessionDisplayTitle: Accessor<string | null>;
  visibleMessages: Accessor<MessageWithParts[]>;
  activeTodos: Accessor<TodoItem[]>;
  groupMessageParts: (
    parts: Part[],
    messageId: string,
    options?: { showThinking?: boolean },
  ) => MessageGroup[];
  summarizeStep: (part: Part) => {
    title: string;
    detail?: string;
    isSkill?: boolean;
    skillName?: string;
    toolCategory?: string;
    status?: string;
  };
  expandedStepIds: Accessor<Set<string>>;
  setExpandedStepIds: Setter<Set<string>>;
  expandedTimelineSectionIds: Accessor<Set<string>>;
  setExpandedTimelineSectionIds: Setter<Set<string>>;
  expandedTimelineDetailIds: Accessor<Set<string>>;
  setExpandedTimelineDetailIds: Setter<Set<string>>;
  expandedSidebarSections: Accessor<SidebarSectionsState>;
  setExpandedSidebarSections: Setter<SidebarSectionsState>;
  activeArtifacts: Accessor<ArtifactItem[]>;
  activeArtifactFamilies: Accessor<ArtifactFamily[]>;
  activeWorkingFiles: Accessor<string[]>;
  activeAuthorizedDirs: Accessor<string[]>;
  activeComposerBusy: Accessor<boolean>;
  prompt: Accessor<string>;
  composerDraft: Accessor<ComposerDraft>;
  setComposerDraft: (draft: ComposerDraft) => void;
  activePermissionMemo: Accessor<PendingPermission | null>;
  permissionReplyBusy: Accessor<boolean>;
  respondPermissionForAppViewProps: (
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => Promise<void>;
  respondPermissionAndRemember: (
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => Promise<void>;
  activeQuestion: () => PendingQuestion | null;
  questionReplyBusy: Accessor<boolean>;
  respondQuestion: (requestID: string, answers: string[][]) => Promise<void>;
  tryNotionPromptVisible: Accessor<boolean>;
  notionIsActive: Accessor<boolean>;
  managedAiAccessBlockedReason: Accessor<string | null>;
  listAgents: () => Promise<Agent[]>;
  listCommands: (scope?: SessionMutationCommandListScope) => Promise<SessionMutationCommand[]>;
  selectedSessionAgent: Accessor<string | null>;
  setSessionAgent: (sessionID: string, agent: string | null) => void;
  saveSessionExport: (sessionID: string) => Promise<string>;
  selectedSessionHistoryUnavailable: () => SelectedSessionHistoryUnavailable | null;
  selectedSessionHistoryRetrying: () => boolean;
  retryUnavailableHistory: (sessionId: string) => Promise<void>;
  retryAcceptedRunForSession: (sessionId: string, workspaceId?: string | null) => number;
  retryTerminalTranscriptRecoveryForSession: (sessionId: string, workspaceId?: string | null) => number;
  selectedSessionHasEarlierMessages: () => boolean;
  selectedSessionLoadingEarlierMessages: () => boolean;
  loadEarlierMessages: (sessionID: string, chunk?: number) => Promise<void>;
  workspaceProjectDir: Accessor<string>;
  deleteSessionById: (sessionID: string, workspaceID?: string) => Promise<void>;
  setTryNotionPromptVisible: Setter<boolean>;
  setNotionSkillInstalled: Setter<boolean>;
  visibleSelectedSessionStatus: Accessor<string>;
  renameSessionTitle: (sessionID: string, title: string) => Promise<void>;
  sessionReconnectNotice: Accessor<ReconnectNotice | null>;
  setSessionReconnectNotice: Setter<ReconnectNotice | null>;
  sessionReconnectState: Accessor<ReconnectState | null>;
};

export type AppViewPropsAdapter = {
  onboardingProps: () => OnboardingViewProps;
  dashboardProps: () => DashboardViewAdapterProps;
  sessionProps: () => SessionViewAdapterProps;
};

export function shouldShowSessionReloadBanner(input: {
  reloadRequired: boolean;
  reloadTrigger: ReloadTrigger | null;
  activeReloadBlockingSessionCount: number;
}): boolean {
  return input.reloadRequired &&
    (input.reloadTrigger?.type === "skill" || input.activeReloadBlockingSessionCount > 0);
}

export function createAppViewProps(deps: AppViewPropsScope): AppViewPropsAdapter {
  const {
    connectedVersion,
    developerMode,
    appVersion,
    vesloServerDiagnostics,
    routedClient,
    sseConnected,
    busy,
    busyLabel,
    busySeconds,
    engine,
    baseUrl,
    startupPreference,
    onboardingStep,
    rememberStartupChoice,
    clientDirectory,
    vesloServerSettings,
    newAuthorizedDir,
    workspaceStore,
    engineDoctorResult,
    engineDoctorCheckedAt,
    engineInstallLogs,
    error,
    migrationRepairUnavailableReason,
    showRemoteActions,
    setClientDirectory,
    updateVesloServerSettings,
    setLocale,
    setTab,
    setView,
    setThemeMode,
    startDesktopBrowserSignIn,
    resumeDesktopBrowserSignIn,
    authCompleteExchangeBusy,
    denKeepSignedIn,
    setDenKeepSignedInPreference,
    themeMode,
    activeWorkspaceDisplay,
    vesloServerStatus,
    vesloServerConnectionSnapshot,
    vesloServerCanWriteSkills,
    vesloServerSkillRegistryAvailable,
    skillRegistryMaterializationAuthContext,
    vesloServerCanWritePlugins,
    tab,
    settingsTab,
    setSettingsTab,
    currentView,
    setSessionBrowseScope,
    authenticatedUser,
    logoutLocalDenAuth,
    newTaskDisabled,
    sessionStore,
    vesloServerUrl,
    hydratedVesloServerClient,
    vesloReconnectBusy,
    reconnectVesloServer,
    vesloServerHostInfo,
    devtoolsCapabilities,
    resolvedDevtoolsWorkspaceId,
    opencodeConnectStatus,
    orchestratorStatusState,
    opencodeRouterInfoState,
    resetVesloServerSettings,
    testVesloServerConnection,
    canReloadWorkspace,
    reloadWorkspaceEngine,
    refreshWorkspaceConfigForPath,
    scheduledAutomationStore,
    soulDataStore,
    reloadBusy,
    reloadError,
    readyEngineWorkspaceIds,
    handleActivateWorkspace,
    openCreateRemoteWorkspace,
    openNewSessionWithDirectory,
    pendingSessionDraftController,
    sidebarWorkspaceGroups,
    unreadSessionIds,
    workspaceSessionPagingById,
    subagentDecorationsBySessionId,
    archivedSessionIds,
    activeSessionStatusById,
    sidebarSessionActivityByRowKey,
    conversationRunDiagnosticsBySessionKey,
    busySessionByWorkspaceId,
    archiveSidebarSessionAndClearActive,
    reportError,
    setError,
    safeStringify,
    unarchiveSession,
    loadMoreWorkspaceSidebarSessions,
    activeSessionId,
    activeWorkspaceLastSessionId,
    openRenameWorkspace,
    openWorkspaceConnectionSettings,
    refreshSkills,
    refreshSkillInventory,
    refreshSkillImportCandidates,
    refreshHubSkills,
    refreshPlugins,
    skills,
    skillsStatus,
    skillInventory,
    skillInventoryStatus,
    skillImportCandidates,
    skillImportStatus,
    hubSkills,
    hubSkillsStatus,
    installSkillCreator,
    installHubSkill,
    uninstallSkill,
    readSkill,
    saveSkill,
    readSkillInstanceFiles,
    readSkillInstance,
    saveSkillInstance,
    setSkillInstanceEnabled,
    deleteSkillInstance,
    removeSkillInstance,
    batchRemoveSkillInstances,
    restoreSkillInstance,
    copySkillInstanceToGlobal,
    copySkillInstanceToWorkspace,
    importSkillCandidates,
    pluginScope,
    setPluginScope,
    pluginConfigPath,
    pluginConfig,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    isPluginInstalledByName,
    localizedSuggestedPlugins,
    addPlugin,
    removePlugin,
    createSessionAndOpen,
    setPrompt,
    selectSession,
    managedAiAccessBusy,
    managedAiAccess,
    managedAiAccessMessage,
    managedAiAccessProviderLabel,
    managedAiAccessEffectiveModelLabel,
    showThinking,
    setShowThinking,
    sessionModelSelectorEnabled,
    setSessionModelSelectorEnabled,
    hideTitlebar,
    setHideTitlebar,
    maxEngines,
    setMaxEngines,
    idleSuspendMs,
    setIdleSuspendMs,
    formatModelVariantLabel,
    modelVariant,
    setModelVariant,
    updateAutoDownload,
    setUpdateAutoDownload,
    setUpdateAutoCheck,
    updateStatus,
    updateEnv,
    checkForUpdates,
    downloadUpdate,
    retryUpdateDownload,
    installUpdateAndRestart,
    documentRuntimeStatus,
    documentRuntimeRepairBusy,
    repairDocumentRuntime,
    anyActiveRuns,
    engineSource,
    updateEngineSource,
    engineCustomBinPath,
    setEngineCustomBinPath,
    engineRuntime,
    setEngineRuntime,
    stopHost,
    restartLocalServer,
    openResetModal,
    resetModalBusy,
    clearStartupPreference,
    setStartupPreference,
    setRememberStartupChoice,
    toggleDenKeepSignedIn,
    pendingPermissions,
    events,
    repairOpencodeCache,
    cacheRepairBusy,
    cacheRepairResult,
    cleanupVesloDockerContainers,
    dockerCleanupBusy,
    dockerCleanupResult,
    resetAppConfigDefaults,
    notionStatus,
    notionStatusDetail,
    notionError,
    notionBusy,
    connectNotion,
    sessionArchives,
    mcpServers,
    mcpStatus,
    mcpLastUpdatedAt,
    mcpStatuses,
    mcpConnectingName,
    selectedMcp,
    setSelectedMcp,
    localizedMcpQuickConnect,
    hubMcpCards,
    hubMcpStatus,
    refreshHubMcp,
    installHubMcpAndActivate,
    connectMcp,
    authorizeMcp,
    logoutMcpAuth,
    removeMcp,
    refreshMcpServers,
    activePendingDraftKey,
    activePendingDraftMeta,
    composerTargetController,
    resolveSelectedSessionBrowseScope,
    resolveSessionDirectory,
    selectedSession,
    activeUiConversationRef,
    activeWorkspaceHasRoutingEntry,
    sessionsLoadedForActiveWorkspace,
    chooseFolderForCurrentSession,
    engineReady,
    vesloServerWorkspaceId,
    sidebarPluginList,
    sidebarPluginStatus,
    sessionCapabilitiesSnapshot,
    sessionCapabilitiesStatus,
    sessionCapabilitiesError,
    reloadRequired,
    reloadTrigger,
    reloadCopy,
    activeReloadBlockingSessions,
    forceStopActiveSessionsAndReload,
    clearReloadRequired,
    sendPrompt,
    replaceUserMessage,
    clearComposerDraftForSession,
    abortSession,
    undoLastUserMessage,
    redoLastUserMessage,
    submitCurrentSessionCompaction,
    lastPromptSent,
    lastPromptSentModelOverride,
    clearLastPromptModelOverride,
    retryLastPrompt,
    selectedSessionDisplayTitle,
    visibleMessages,
    activeTodos,
    groupMessageParts,
    summarizeStep,
    expandedStepIds,
    setExpandedStepIds,
    expandedTimelineSectionIds,
    setExpandedTimelineSectionIds,
    expandedTimelineDetailIds,
    setExpandedTimelineDetailIds,
    expandedSidebarSections,
    setExpandedSidebarSections,
    activeArtifacts,
    activeArtifactFamilies,
    activeWorkingFiles,
    activeAuthorizedDirs,
    activeComposerBusy,
    prompt,
    composerDraft,
    setComposerDraft,
    activePermissionMemo,
    permissionReplyBusy,
    respondPermissionForAppViewProps,
    respondPermissionAndRemember,
    activeQuestion,
    questionReplyBusy,
    respondQuestion,
    tryNotionPromptVisible,
    notionIsActive,
    managedAiAccessBlockedReason,
    listAgents,
    listCommands,
    selectedSessionAgent,
    setSessionAgent,
    saveSessionExport,
    selectedSessionHistoryUnavailable,
    selectedSessionHistoryRetrying,
    retryUnavailableHistory,
    retryAcceptedRunForSession,
    retryTerminalTranscriptRecoveryForSession,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    loadEarlierMessages,
    workspaceProjectDir,
    deleteSessionById,
    setTryNotionPromptVisible,
    setNotionSkillInstalled,
    visibleSelectedSessionStatus,
    renameSessionTitle,
    sessionReconnectNotice,
    setSessionReconnectNotice,
    sessionReconnectState,
  } = deps;

  const headerConnectedVersion = createMemo(() =>
    resolveHeaderConnectedVersion({
      connectedVersion: connectedVersion(),
      developerMode: developerMode(),
      appVersion: appVersion(),
      vesloServerDiagnosticsVersion: vesloServerDiagnostics()?.version ?? null,
    }),
  );

  const headerStatus = createMemo(() =>
    resolveHeaderStatus({
      clientConnected: Boolean(routedClient()),
      headerConnectedVersion: headerConnectedVersion(),
      sseConnected: sseConnected(),
      connectedLabel: t("status.connected", currentLocale()),
      disconnectedLabel: t("status.disconnected", currentLocale()),
      liveLabel: t("status.live", currentLocale()),
    }),
  );

  const busyHint = createMemo(() =>
    resolveBusyHint({
      busy: busy(),
      busyLabel: busyLabel(),
      busySeconds: busySeconds(),
      translateBusyLabel: (key) => t(key, currentLocale()),
    }),
  );

  const localHostLabel = createMemo(() =>
    resolveLocalHostLabel({
      engine: engine(),
      baseUrl: baseUrl(),
    }),
  );

  const onboardingProps = () => ({
    startupPreference: startupPreference(),
    onboardingStep: onboardingStep(),
    language: currentLocale(),
    rememberStartupChoice: rememberStartupChoice(),
    busy: busy(),
    clientDirectory: clientDirectory(),
    vesloHostUrl: vesloServerSettings().urlOverride ?? "",
    vesloToken: vesloServerSettings().token ?? "",
    newAuthorizedDir: newAuthorizedDir(),
    authorizedDirs: workspaceStore.authorizedDirs(),
    activeWorkspacePath: workspaceStore.activeWorkspacePath(),
    workspaces: workspaceStore.workspaces(),
    localHostLabel: localHostLabel(),
    engineRunning: Boolean(engine()?.running),
    developerMode: developerMode(),
    engineBaseUrl: engine()?.baseUrl ?? null,
    engineDoctorFound: engineDoctorResult()?.found ?? null,
    engineDoctorSupportsServe: engineDoctorResult()?.supportsServe ?? null,
    engineDoctorVersion: engineDoctorResult()?.version ?? null,
    engineDoctorResolvedPath: engineDoctorResult()?.resolvedPath ?? null,
    engineDoctorNotes: engineDoctorResult()?.notes ?? [],
    engineDoctorServeHelpStdout: engineDoctorResult()?.serveHelpStdout ?? null,
    engineDoctorServeHelpStderr: engineDoctorResult()?.serveHelpStderr ?? null,
    engineDoctorCheckedAt: engineDoctorCheckedAt(),
    engineInstallLogs: engineInstallLogs(),
    error: error(),
    canRepairMigration: workspaceStore.canRepairOpencodeMigration(),
    migrationRepairUnavailableReason: migrationRepairUnavailableReason(),
    migrationRepairBusy: workspaceStore.migrationRepairBusy(),
    migrationRepairResult: workspaceStore.migrationRepairResult(),
    isWindows: isWindowsPlatform(),
    showRemoteActions: showRemoteActions(),
    onClientDirectoryChange: setClientDirectory,
    onVesloHostUrlChange: (value: string) =>
      updateVesloServerSettings({
        ...vesloServerSettings(),
        urlOverride: value,
      }),
    onVesloTokenChange: (value: string) =>
      updateVesloServerSettings({
        ...vesloServerSettings(),
        token: value,
      }),
    onSelectStartup: workspaceStore.onSelectStartup,
    onSetLanguage: setLocale,
    onConfirmLanguage: async () => {
      setLocale(currentLocale());
      await workspaceStore.onConfirmLanguage();
    },
    onRememberStartupToggle: workspaceStore.onRememberStartupToggle,
    onStartHost: workspaceStore.onStartHost,
    onRepairMigration: workspaceStore.onRepairOpencodeMigration,
    onCreateWorkspace: workspaceStore.createWorkspaceFlow,
    onPickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
    onImportWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
    onAttachHost: workspaceStore.onAttachHost,
    onConnectClient: workspaceStore.onConnectClient,
    onBackToWelcome: workspaceStore.onBackToWelcome,
    onSetAuthorizedDir: workspaceStore.setNewAuthorizedDir,
    onAddAuthorizedDir: workspaceStore.addAuthorizedDir,
    onAddAuthorizedDirFromPicker: () =>
      workspaceStore.addAuthorizedDirFromPicker({ persistToWorkspace: true }),
    onRemoveAuthorizedDir: workspaceStore.removeAuthorizedDirAtIndex,
    onRefreshEngineDoctor: async () => {
      workspaceStore.setEngineInstallLogs(null);
      await workspaceStore.refreshEngineDoctor();
    },
    onInstallEngine: workspaceStore.onInstallEngine,
    onShowSearchNotes: () => {
      const notes =
        workspaceStore.engineDoctorResult()?.notes?.join("\n") ?? "";
      workspaceStore.setEngineInstallLogs(notes || null);
    },
    onOpenSettings: () => {
      setTab("settings");
      setView("dashboard");
    },
    themeMode: themeMode(),
    setThemeMode,
    onSignInWithBrowser: startDesktopBrowserSignIn,
    onResumeBrowserSignIn: resumeDesktopBrowserSignIn,
    authExchangeBusy: authCompleteExchangeBusy(),
    keepSignedIn: denKeepSignedIn(),
    onKeepSignedInChange: setDenKeepSignedInPreference,
  } satisfies OnboardingViewProps);

  const dashboardProps = () => {
    const workspaceType = activeWorkspaceDisplay().workspaceType;
    const vesloStatus = vesloServerStatus();
    const vesloConnection = vesloServerConnectionSnapshot();
    const dashboardAccess = resolveDashboardViewAccess({
      workspaceType,
      vesloServerStatus: vesloStatus,
      vesloServerCanWriteSkills: vesloServerCanWriteSkills(),
      vesloServerCanWritePlugins: vesloServerCanWritePlugins(),
      tauriRuntime: isTauriRuntime(),
    });
    const {
      canUseDesktopTools,
      canInstallSkillCreator,
      canEditPlugins,
      canUseGlobalPluginScope,
      skillsAccessHint,
      pluginsAccessHint,
    } = dashboardAccess;

    return {
      tab: tab(),
      setTab,
      settingsTab: settingsTab(),
      setSettingsTab,
      view: currentView(),
      setView,
      setSessionBrowseScope,
      startupPreference: startupPreference(),
      baseUrl: baseUrl(),
      clientConnected: Boolean(routedClient()),
      authenticatedUser: authenticatedUser(),
      onLogout: logoutLocalDenAuth,
      onSignIn: startDesktopBrowserSignIn,
      busy: busy(),
      busyHint: busyHint(),
      busyLabel: busyLabel(),
      newTaskDisabled: newTaskDisabled(),
      pendingPermissionCountByWs: sessionStore.pendingPermissionCountByWs(),
      headerStatus: headerStatus(),
      error: error(),
      vesloServerStatus: vesloStatus,
      vesloServerConnection: vesloConnection,
      vesloServerCanWriteSkills: vesloServerCanWriteSkills(),
      vesloServerSkillRegistryAvailable: vesloServerSkillRegistryAvailable(),
      vesloServerUrl: vesloServerUrl(),
      vesloServerClient: hydratedVesloServerClient(),
      vesloReconnectBusy: vesloReconnectBusy(),
      reconnectVesloServer,
      vesloServerSettings: vesloServerSettings(),
      vesloServerHostInfo: vesloServerHostInfo(),
      vesloServerCapabilities: devtoolsCapabilities(),
      vesloServerDiagnostics: vesloServerDiagnostics(),
      vesloServerWorkspaceId: resolvedDevtoolsWorkspaceId(),
      opencodeConnectStatus: opencodeConnectStatus(),
      engineInfo: workspaceStore.engine(),
      orchestratorStatus: orchestratorStatusState(),
      opencodeRouterInfo: opencodeRouterInfoState(),
      engineDoctorVersion: workspaceStore.engineDoctorResult()?.version ?? null,
      updateVesloServerSettings,
      resetVesloServerSettings,
      testVesloServerConnection,
      canReloadWorkspace: canReloadWorkspace(),
      reloadWorkspaceEngine: async () => {
        await reloadWorkspaceEngine();
      },
      reloadScheduledAutomationsSource: scheduledAutomationStore.reloadScheduledJobsSource,
      reloadBusy: reloadBusy(),
      reloadError: reloadError(),
      activeWorkspaceDisplay: activeWorkspaceDisplay(),
      workspaces: workspaceStore.workspaces(),
      activeWorkspaceId: workspaceStore.activeWorkspaceId(),
      activeUiConversationRef: activeUiConversationRef(),
      connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
      workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
      readyEngineWorkspaceIds: readyEngineWorkspaceIds(),
      activateWorkspace: handleActivateWorkspace,
      testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
      recoverWorkspace: workspaceStore.recoverWorkspace,
      openCreateWorkspace: () => {
        if (CLOUD_ONLY_MODE) {
          openCreateRemoteWorkspace();
          return;
        }
        workspaceStore.setCreateWorkspaceOpen(true);
      },
      openCreateRemoteWorkspace,
      openNewSessionWithDirectory,
      openDirectorySessionFromPicker: () => {
        void pendingSessionDraftController.openDirectorySessionFromPicker();
      },
      openPendingDirectoryDraftInWorkspace: (workspaceId: string) => {
        void pendingSessionDraftController.openPendingDirectoryDraftInWorkspace(workspaceId);
      },
      importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
      importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
      exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
      exportWorkspaceBusy: workspaceStore.exportingWorkspaceConfig(),
      workspaceSessionGroups: sidebarWorkspaceGroups(),
      unreadSessionIds: unreadSessionIds(),
      workspaceSessionPagingById: workspaceSessionPagingById(),
      subagentDecorationsBySessionId: subagentDecorationsBySessionId(),
      archivedSessionIds: archivedSessionIds(),
      sessionStatusById: activeSessionStatusById(),
      sidebarSessionActivityByRowKey: sidebarSessionActivityByRowKey(),
      busySessionByWorkspaceId: busySessionByWorkspaceId(),
      archiveSession: (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) =>
        archiveSidebarSessionAndClearActive(workspaceId, sessionId, target).catch((error: unknown) => {
          reportError(error, "sessionArchives.archiveSidebar");
          setError(error instanceof Error ? error.message : safeStringify(error));
        }),
      unarchiveSession: (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) =>
        unarchiveSession(workspaceId, sessionId, undefined, target).catch((error: unknown) => {
          reportError(error, "sessionArchives.unarchiveSidebar");
          setError(error instanceof Error ? error.message : safeStringify(error));
        }),
      loadMoreWorkspaceSidebarSessions,
      isPrivateWorkspacePath: workspaceStore.isPrivateWorkspacePath,
      selectedSessionId: activeSessionId(),
      lastWorkspaceSessionId: activeWorkspaceLastSessionId(),
      openRenameWorkspace,
      editWorkspaceConnection: openWorkspaceConnectionSettings,
      forgetWorkspace: workspaceStore.forgetWorkspace,
      automationItems: scheduledAutomationStore.automationItems(),
      automationWorkspaces: scheduledAutomationStore.automationWorkspaces(),
      defaultAutomationWorkspaceId: scheduledAutomationStore.defaultAutomationWorkspaceId(),
      scheduledJobs: scheduledAutomationStore.scheduledJobs(),
      scheduledJobsSource: scheduledAutomationStore.scheduledJobsSource(),
      scheduledJobsSourceReady: scheduledAutomationStore.scheduledJobsSourceReady(),
      scheduledJobsStatus: scheduledAutomationStore.scheduledJobsStatus(),
      scheduledJobsBusy: scheduledAutomationStore.scheduledJobsBusy(),
      scheduledJobsUpdatedAt: scheduledAutomationStore.scheduledJobsUpdatedAt(),
      refreshScheduledJobs: (options?: { force?: boolean }) =>
        scheduledAutomationStore.refreshScheduledJobs(options).catch((e: unknown) => reportError(e, "scheduled.refresh")),
      createAutomation: scheduledAutomationStore.createAutomation,
      updateAutomation: scheduledAutomationStore.updateAutomation,
      deleteAutomation: scheduledAutomationStore.deleteAutomation,
      runAutomation: scheduledAutomationStore.runAutomation,
      soulOverview: soulDataStore.soulOverview(),
      soulOverviewError: soulDataStore.soulOverviewError(),
      soulOverviewBusy: soulDataStore.soulOverviewBusy(),
      soulClient: soulDataStore.soulClient(),
      soulServerConnected: soulDataStore.soulServerConnected(),
      soulAuthContext: soulDataStore.soulAuthContext(),
      skillRegistryAuthContext: skillRegistryMaterializationAuthContext(),
      soulWorkspaceMap: soulDataStore.soulWorkspaceMap(),
      soulError: soulDataStore.soulError(),
      refreshSoulData: (options?: { force?: boolean }) => soulDataStore.refreshSoulData(options).catch((e: unknown) => reportError(e, "soul.refresh")),
      activeWorkspaceRoot: workspaceStore.activeWorkspaceRoot().trim(),
      isRemoteWorkspace: workspaceStore.activeWorkspaceDisplay().workspaceType === "remote",
      refreshSkills: (options?: { force?: boolean }) => refreshSkills(options).catch((e: unknown) => reportError(e, "skills.refresh")),
      refreshSkillInventory: (options?: { force?: boolean }) =>
        refreshSkillInventory(options).catch((e: unknown) => reportError(e, "skills.refreshInventory")),
      refreshSkillImportCandidates: (options?: { force?: boolean }) =>
        refreshSkillImportCandidates(options).catch((e: unknown) => reportError(e, "skills.refreshImportCandidates")),
      refreshHubSkills: (options?: { force?: boolean }) => refreshHubSkills(options).catch((e: unknown) => reportError(e, "skills.refreshHub")),
      refreshPlugins: (scopeOverride?: PluginScope) =>
        refreshPlugins(scopeOverride).catch((e: unknown) => reportError(e, "plugins.refresh")),
      skills: skills(),
      skillsStatus: skillsStatus(),
      skillInventory: skillInventory(),
      skillInventoryStatus: skillInventoryStatus(),
      skillImportCandidates: skillImportCandidates(),
      skillImportStatus: skillImportStatus(),
      hubSkills: hubSkills(),
      hubSkillsStatus: hubSkillsStatus(),
      skillsAccessHint,
      canInstallSkillCreator,
      canUseDesktopTools,
      installSkillCreator,
      installHubSkill,
      uninstallSkill,
      readSkill,
      saveSkill,
      readSkillInstanceFiles,
      readSkillInstance,
      saveSkillInstance,
      setSkillInstanceEnabled,
      deleteSkillInstance,
      removeSkillInstance,
      batchRemoveSkillInstances,
      restoreSkillInstance,
      copySkillInstanceToGlobal,
      copySkillInstanceToWorkspace,
      importSkillCandidates,
      pluginsAccessHint,
      canEditPlugins,
      canUseGlobalPluginScope,
      pluginScope: pluginScope(),
      setPluginScope,
      pluginConfigPath: pluginConfigPath() ?? pluginConfig()?.path ?? null,
      pluginList: pluginList(),
      pluginInput: pluginInput(),
      setPluginInput,
      pluginStatus: pluginStatus(),
      activePluginGuide: activePluginGuide(),
      setActivePluginGuide,
      isPluginInstalled: isPluginInstalledByName,
      suggestedPlugins: localizedSuggestedPlugins(),
      addPlugin,
      removePlugin,
      createSessionAndOpen,
      setPrompt,
      selectSession: selectSession,
      aiAccessBusy: managedAiAccessBusy(),
      aiAccessConfigured: Boolean(managedAiAccess()),
      aiAccessMessage: managedAiAccessMessage(),
      aiAccessProviderLabel: managedAiAccessProviderLabel(),
      aiAccessEffectiveModelLabel: managedAiAccessEffectiveModelLabel(),
      showThinking: showThinking(),
      toggleShowThinking: () => setShowThinking((v: boolean) => !v),
      sessionModelSelectorEnabled: sessionModelSelectorEnabled(),
      toggleSessionModelSelector: () => setSessionModelSelectorEnabled((v: boolean) => {
        const next = !v;
        if (!next) clearLastPromptModelOverride();
        return next;
      }),
      hideTitlebar: hideTitlebar(),
      toggleHideTitlebar: () => setHideTitlebar((v: boolean) => !v),
      maxEngines: maxEngines(),
      setMaxEngines: (n: number) => setMaxEngines(Math.max(1, Math.min(64, Math.floor(n)))),
      idleSuspendMs: idleSuspendMs(),
      setIdleSuspendMs: (ms: number) => setIdleSuspendMs(Math.max(0, Math.floor(ms))),
      modelVariantLabel: formatModelVariantLabel(modelVariant()),
      modelVariant: normalizeModelVariant(modelVariant()) ?? "none",
      setModelVariant: (value: string) => setModelVariant(value),
      updateAutoDownload: updateAutoDownload(),
      toggleUpdateAutoDownload: () =>
        setUpdateAutoDownload((v: boolean) => {
          const next = !v;
          if (next) {
            setUpdateAutoCheck(true);
          }
          return next;
        }),
      updateStatus: updateStatus(),
      updateEnv: updateEnv(),
      appVersion: appVersion(),
      checkForUpdates: () => checkForUpdates(),
      downloadUpdate: () => downloadUpdate(),
      retryUpdateDownload: () => retryUpdateDownload(),
      installUpdateAndRestart,
      documentRuntimeStatus: documentRuntimeStatus(),
      documentRuntimeRepairBusy: documentRuntimeRepairBusy(),
      repairDocumentRuntime,
      anyActiveRuns: anyActiveRuns(),
      engineSource: engineSource(),
      setEngineSource: (value: EngineSourcePreference) => updateEngineSource(value, { explicit: true }),
      engineCustomBinPath: engineCustomBinPath(),
      setEngineCustomBinPath,
      engineRuntime: engineRuntime(),
      setEngineRuntime,
      isWindows: isWindowsPlatform(),
      developerMode: developerMode(),
      stopHost,
      restartLocalServer,
      openResetModal,
      resetModalBusy: resetModalBusy(),
      onResetStartupPreference: () => {
        clearStartupPreference();
        setStartupPreference(null);
        setRememberStartupChoice(false);
      },
      themeMode: themeMode(),
      setThemeMode,
      denKeepSignedIn: denKeepSignedIn(),
      toggleDenKeepSignedIn,
      pendingPermissions: pendingPermissions(),
      events: events(),
      workspaceDebugEvents: workspaceStore.workspaceDebugEvents(),
      clearWorkspaceDebugEvents: workspaceStore.clearWorkspaceDebugEvents,
      safeStringify,
      repairOpencodeMigration: workspaceStore.repairOpencodeMigration,
      migrationRepairBusy: workspaceStore.migrationRepairBusy(),
      migrationRepairResult: workspaceStore.migrationRepairResult(),
      migrationRepairAvailable: workspaceStore.canRepairOpencodeMigration(),
      migrationRepairUnavailableReason: migrationRepairUnavailableReason(),
      repairOpencodeCache,
      cacheRepairBusy: cacheRepairBusy(),
      cacheRepairResult: cacheRepairResult(),
      cleanupVesloDockerContainers,
      dockerCleanupBusy: dockerCleanupBusy(),
      dockerCleanupResult: dockerCleanupResult(),
      resetAppConfigDefaults,
      notionStatus: notionStatus(),
      notionStatusDetail: notionStatusDetail(),
      notionError: notionError(),
      notionBusy: notionBusy(),
      connectNotion,
      sessionArchives: sessionArchives(),
      onUnarchiveArchivedSession: (
        workspaceId: string,
        sessionId: string,
        workspaceIdentity?: string | null,
        directory?: string | null,
      ) => {
        const target = directory?.trim() ? { directory } : undefined;
        return unarchiveSession(workspaceId, sessionId, workspaceIdentity, target).catch((error: unknown) => {
          reportError(error, "sessionArchives.unarchiveSettings");
          setError(error instanceof Error ? error.message : safeStringify(error));
        });
      },
      mcpServers: mcpServers(),
      mcpStatus: mcpStatus(),
      mcpLastUpdatedAt: mcpLastUpdatedAt(),
      mcpStatuses: mcpStatuses(),
      mcpConnectingName: mcpConnectingName(),
      selectedMcp: selectedMcp(),
      setSelectedMcp,
      quickConnect: localizedMcpQuickConnect(),
      hubMcpCards: hubMcpCards(),
      hubMcpStatus: hubMcpStatus(),
      refreshHubMcp: (options?: { force?: boolean }) =>
        refreshHubMcp(options).catch((e: unknown) => reportError(e, "skills.refreshHubMcp")),
      installHubMcp: (name: string) => installHubMcpAndActivate(name).catch((e: unknown) => {
        reportError(e, "skills.installHubMcp");
        return { ok: false, message: e instanceof Error ? e.message : safeStringify(e) };
      }),
      connectMcp,
      authorizeMcp,
      logoutMcpAuth,
      removeMcp,
      refreshMcpServers,
      showMcpReloadBanner: false,
      mcpReloadBlocked: anyActiveRuns(),
      reloadMcpEngine: () => reloadWorkspaceEngine(),
      language: currentLocale(),
      setLanguage: setLocale,
    } satisfies DashboardViewAdapterProps;
  };

  const searchWorkspaceFiles = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const activeClient = routedClient();
    if (!activeClient) return [];
    try {
      const directory = workspaceProjectDir().trim();
      const result = unwrap(
        await activeClient.find.files({
          query: trimmed,
          dirs: "true",
          limit: 50,
          directory: directory || undefined,
        }),
      );
      return result as string[];
    } catch {
      return [];
    }
  };

  const sessionProps = () => ({
    selectedSessionId: activeSessionId(),
    activePendingDraftKey: activePendingDraftKey(),
    activePendingDraftMeta: activePendingDraftMeta(),
    composerTargetOptions: composerTargetController.composerTargetOptions(),
    activeComposerTargetId: composerTargetController.activeComposerTargetId(),
    switchComposerTarget: composerTargetController.switchComposerTarget,
    setView,
    setSessionBrowseScope,
    tab: tab(),
    setTab,
    setSettingsTab,
    activeWorkspaceDisplay: activeWorkspaceDisplay(),
    activeWorkspaceRoot:
      (activeSessionId() ? resolveSelectedSessionBrowseScope(activeSessionId()!)?.workspaceRoot : null) ||
      preferredSessionWorkspaceRoot(
        resolveSessionDirectory(selectedSession() ?? { id: "", directory: "" }),
        workspaceStore.activeWorkspaceRoot().trim(),
      ),
    workspaces: workspaceStore.workspaces(),
    workspacesHydrated: workspaceStore.workspacesHydrated(),
    activeWorkspaceId: workspaceStore.activeWorkspaceId(),
    activeUiConversationRef: activeUiConversationRef(),
    activeWorkspaceHasRoutingEntry: activeWorkspaceHasRoutingEntry(),
    activeWorkspaceSessionsLoaded: sessionsLoadedForActiveWorkspace(),
    connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
    workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
    readyEngineWorkspaceIds: readyEngineWorkspaceIds(),
    activateWorkspace: handleActivateWorkspace,
    testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
    recoverWorkspace: workspaceStore.recoverWorkspace,
    editWorkspaceConnection: openWorkspaceConnectionSettings,
    forgetWorkspace: workspaceStore.forgetWorkspace,
    openCreateWorkspace: () => {
      if (CLOUD_ONLY_MODE) {
        openCreateRemoteWorkspace();
        return;
      }
      workspaceStore.setCreateWorkspaceOpen(true);
    },
    openCreateRemoteWorkspace,
    openNewSessionWithDirectory,
    openDirectorySessionFromPicker: () => {
      void pendingSessionDraftController.openDirectorySessionFromPicker();
    },
    openPendingDirectoryDraftInWorkspace: (workspaceId: string) => {
      void pendingSessionDraftController.openPendingDirectoryDraftInWorkspace(workspaceId);
    },
    canChooseSessionFolder:
      (() => {
        if (!isTauriRuntime()) return false;
        const sessionId = activeSessionId();
        if (!sessionId) return false;
        if (workspaceStore.activeWorkspaceDisplay().workspaceType !== "local") return false;
        const session = selectedSession();
        const sourceRoot = preferredSessionWorkspaceRoot(
          session ? resolveSessionDirectory(session) : "",
          workspaceStore.activeWorkspaceRoot().trim(),
        );
        return workspaceStore.isPrivateWorkspacePath(sourceRoot);
      })(),
    chooseFolderForCurrentSession,
    showRemoteActions: showRemoteActions(),
    importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
    exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
    exportWorkspaceBusy: workspaceStore.exportingWorkspaceConfig(),
    engineReady: engineReady(),
    clientConnected: Boolean(routedClient()),
    authenticatedUser: authenticatedUser(),
    onLogout: logoutLocalDenAuth,
    onSignIn: startDesktopBrowserSignIn,
    vesloServerStatus: vesloServerStatus(),
    vesloServerConnection: vesloServerConnectionSnapshot(),
    startupPreference: startupPreference(),
    hideTitlebar: hideTitlebar(),
    vesloServerClient: hydratedVesloServerClient(),
    vesloServerSettings: vesloServerSettings(),
    vesloServerHostInfo: vesloServerHostInfo(),
    vesloServerWorkspaceId: vesloServerWorkspaceId(),
    engineInfo: workspaceStore.engine(),
    stopHost,
    headerStatus: headerStatus(),
    busyHint: busyHint(),
    updateStatus: updateStatus(),
    updateEnv: updateEnv(),
    updateAutoDownload: updateAutoDownload(),
    anyActiveRuns: anyActiveRuns(),
    downloadUpdate: () => downloadUpdate(),
    retryUpdateDownload: () => retryUpdateDownload(),
    installUpdateAndRestart,
    activePlugins: sidebarPluginList(),
    activePluginStatus: sidebarPluginStatus(),
    mcpServers: mcpServers(),
    mcpStatuses: mcpStatuses(),
    mcpStatus: mcpStatus(),
    skills: skills(),
    skillsStatus: skillsStatus(),
    sessionCapabilities: sessionCapabilitiesSnapshot(),
    sessionCapabilitiesStatus: sessionCapabilitiesStatus(),
    sessionCapabilitiesError: sessionCapabilitiesError(),
    showSkillReloadBanner: shouldShowSessionReloadBanner({
      reloadRequired: reloadRequired(),
      reloadTrigger: reloadTrigger(),
      activeReloadBlockingSessionCount: activeReloadBlockingSessions().length,
    }),
    reloadBannerTitle: reloadCopy().title,
    reloadBannerBody: reloadCopy().body,
    reloadBannerBlocked: activeReloadBlockingSessions().length > 0,
    reloadBannerActiveCount: activeReloadBlockingSessions().length,
    canReloadWorkspace: canReloadWorkspace() || activeReloadBlockingSessions().length > 0,
    reloadWorkspaceEngine: async () => {
      await reloadWorkspaceEngine();
    },
    refreshWorkspaceConfig: refreshWorkspaceConfigForPath,
    forceStopActiveConversations: forceStopActiveSessionsAndReload,
    dismissReloadBanner: clearReloadRequired,
    reloadBusy: reloadBusy(),
    reloadError: reloadError(),
    createSessionAndOpen: createSessionAndOpen,
    sendPromptAsync: sendPrompt,
    replaceUserMessageAsync: replaceUserMessage,
    clearComposerDraftForSession,
    abortSession: abortSession,
    sessionRevertMessageId: selectedSession()?.revert?.messageID ?? null,
    undoLastUserMessage: undoLastUserMessage,
    redoLastUserMessage: redoLastUserMessage,
    compactSession: submitCurrentSessionCompaction,
    lastPromptSent: lastPromptSent(),
    retryLastPrompt: retryLastPrompt,
    clearLastPromptModelOverride,
    sessionModelSelectorEnabled: sessionModelSelectorEnabled(),
    selectableSessionModels: managedAiAccess()?.selectableModels ?? [],
    newTaskDisabled: newTaskDisabled(),
    pendingPermissionCountByWs: sessionStore.pendingPermissionCountByWs(),
    workspaceSessionGroups: sidebarWorkspaceGroups(),
    unreadSessionIds: unreadSessionIds(),
    workspaceSessionPagingById: workspaceSessionPagingById(),
    subagentDecorationsBySessionId: subagentDecorationsBySessionId(),
    archivedSessionIds: archivedSessionIds(),
    archiveSession: (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) =>
      archiveSidebarSessionAndClearActive(workspaceId, sessionId, target).catch((error: unknown) => {
        reportError(error, "sessionArchives.archiveSidebar");
        setError(error instanceof Error ? error.message : safeStringify(error));
      }),
    unarchiveSession: (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) =>
      unarchiveSession(workspaceId, sessionId, undefined, target).catch((error: unknown) => {
        reportError(error, "sessionArchives.unarchiveSidebar");
        setError(error instanceof Error ? error.message : safeStringify(error));
      }),
    loadMoreWorkspaceSidebarSessions,
    isPrivateWorkspacePath: workspaceStore.isPrivateWorkspacePath,
    openRenameWorkspace,
    selectSession: selectSession,
    selectedSessionTitle: selectedSessionDisplayTitle(),
    messages: visibleMessages(),
    todos: activeTodos(),
    busyLabel: busyLabel(),
    developerMode: developerMode(),
    showThinking: showThinking(),
    groupMessageParts,
    summarizeStep,
    expandedStepIds: expandedStepIds(),
    setExpandedStepIds: setExpandedStepIds,
    expandedTimelineSectionIds: expandedTimelineSectionIds(),
    setExpandedTimelineSectionIds: setExpandedTimelineSectionIds,
    expandedTimelineDetailIds: expandedTimelineDetailIds(),
    setExpandedTimelineDetailIds: setExpandedTimelineDetailIds,
    expandedSidebarSections: expandedSidebarSections(),
    setExpandedSidebarSections: setExpandedSidebarSections,
    artifacts: activeArtifacts(),
    artifactFamilies: activeArtifactFamilies(),
    workingFiles: activeWorkingFiles(),
    authorizedDirs: activeAuthorizedDirs(),
    busy: activeComposerBusy(),
    prompt: prompt(),
    setPrompt: setPrompt,
    reconnectNotice: sessionReconnectNotice(),
    reconnectState: sessionReconnectState?.() ?? null,
    clearReconnectNotice: () => setSessionReconnectNotice(null),
    composerDraft: composerDraft(),
    setComposerDraft: setComposerDraft,
    activePermission: activePermissionMemo(),
    permissionReplyBusy: permissionReplyBusy(),
    respondPermission: respondPermissionForAppViewProps,
    respondPermissionAndRemember: respondPermissionAndRemember,
    activeQuestion: activeQuestion(),
    questionReplyBusy: questionReplyBusy(),
    respondQuestion: respondQuestion,
    safeStringify: safeStringify,
    showTryNotionPrompt: tryNotionPromptVisible() && notionIsActive(),
    aiAccessBlockedReason: managedAiAccessBlockedReason(),
    listAgents: listAgents,
    listCommands: listCommands,
    selectedSessionAgent: selectedSessionAgent(),
    setSessionAgent: setSessionAgent,
    saveSession: saveSessionExport,
    sessionStatusById: activeSessionStatusById(),
    sidebarSessionActivityByRowKey: sidebarSessionActivityByRowKey(),
    conversationRunDiagnosticsBySessionKey: conversationRunDiagnosticsBySessionKey(),
    busySessionByWorkspaceId: busySessionByWorkspaceId(),
    historyUnavailable: selectedSessionHistoryUnavailable(),
    historyUnavailableRetrying: selectedSessionHistoryRetrying(),
    retryUnavailableHistory,
    retryAcceptedRunForSession,
    retryTerminalTranscriptRecoveryForSession,
    hasEarlierMessages: selectedSessionHasEarlierMessages(),
    loadingEarlierMessages: selectedSessionLoadingEarlierMessages(),
    loadEarlierMessages,
    searchFiles: searchWorkspaceFiles,
    deleteSession: deleteSessionById,
    onTryNotionPrompt: () => {
      setPrompt("setup my crm");
      setTryNotionPromptVisible(false);
      setNotionSkillInstalled(true);
      try {
        window.localStorage.setItem("veslo.notionSkillInstalled", "1");
      } catch {
        // ignore
      }
    },
    sessionStatus: visibleSelectedSessionStatus(),
    renameSession: renameSessionTitle,
    error: error(),
  } satisfies SessionViewAdapterProps);


  return {
    onboardingProps,
    dashboardProps,
    sessionProps,
  };
}
