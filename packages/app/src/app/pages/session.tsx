import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { Agent, Part } from "@opencode-ai/sdk/v2/client";
import type {
  ArtifactItem,
  DashboardTab,
  ComposerTargetOption,
  ComposerTargetSwitchResult,
  ComposerDraft,
  MessageGroup,
  MessageWithParts,
  McpServerEntry,
  McpStatusMap,
  PendingPermission,
  PendingQuestion,
  PendingSidebarSessionMetadata,
  SettingsTab,
  SkillCard,
  SidebarSectionState,
  TodoItem,
  View,
  WorkspaceConnectionState,
  WorkspaceDisplay,
  WorkspaceSessionGroup,
  StartupPreference,
  SidebarSubagentDecoration,
  LoadedSessionPrefetchInterestChangeHandler,
} from "../types";

import { reportError } from "../lib/error-reporter";
import {
  pickDirectory,
  type EngineInfo,
  type PendingSessionDraftSummary,
  type VesloServerInfo,
  type WorkspaceInfo,
  workspaceGrantFolderAccess,
} from "../lib/tauri";
import { acquireBlankNativeWindowTitleLease } from "../lib/native-window-title-lease";
import { isAiAccessLoadingMessage, resolveActionableAiAccessBlockedReason } from "../lib/ai-access";

import {
  ChevronDown,
  Check,
  Circle,
  Cpu,
  HardDrive,
  History,
  ListTodo,
  Loader2,
  MessageCircle,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Redo2,
  Search,
  Shield,
  SlidersHorizontal,
  Undo2,
  X,
} from "lucide-solid";

import Button from "../components/button";
import ConfirmModal from "../components/confirm-modal";
import FolderAccessConsentModal from "../components/folder-access-consent-modal";
import RenameSessionModal from "../components/rename-session-modal";
import ShareWorkspaceModal from "../components/share-workspace-modal";
import { parseVesloWorkspaceIdFromUrl } from "../lib/veslo-server";
import type {
  VesloServerClient,
  VesloServerConnectionSnapshot,
  VesloServerSettings,
  VesloServerStatus,
} from "../lib/veslo-server";
import { DEFAULT_VESLO_PUBLISHER_BASE_URL } from "../lib/publisher";
import { join } from "@tauri-apps/api/path";
import {
  isUserVisiblePart,
  isTauriRuntime,
  isWindowsPlatform,
  normalizeDirectoryPath,
} from "../utils";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
import { normalizeLocalFilePath } from "../lib/local-file-path";
import {
  partText,
  toolNameFromPart,
  toolOutputSizeFromPart,
  toolStateFromPart,
} from "../lib/opencode-part-access";
import {
  resolveFolderAccessRequestFromPermission,
  selectedFolderContainsRequestedPath,
} from "../lib/folder-access-request";
import {
  createSessionClientMessageId,
  sessionSubmitNeedsImplicitSkillConfirmation,
  type MaterializedSessionHandoff,
  type SessionSendOptionsBase,
  type SessionSendOrigin,
  type SessionSubmitResult,
} from "../lib/session-send-contract";
import type { UiConversationRef } from "../lib/ui-conversation-scope";
import { resolveEscapeStopShortcut } from "./session-shortcuts";
import {
  deriveSessionRunPresentation,
  lifecycleKeepsRunPresentationActive,
  terminalLifecycleOwnsOptimistic,
} from "./session-run-presentation";
import { currentLocale, t } from "../../i18n";
import type { UpdateDownloadRetryInfo } from "../context/updater";

import MessageList, { type PendingMessageState } from "../components/session/message-list";
import Composer from "../components/session/composer";
import type { ComposerSendOptions, ComposerSendResult } from "../components/session/composer";
import ComposerTargetPicker from "../components/session/composer-target-picker";
import type { SidebarSessionOpenTarget } from "../components/session/workspace-session-list-model";
import QueuedMessageList from "../components/session/queued-message-list";
import ServerQueuedRunList from "../components/session/server-queued-run-list";
import {
  replaceServerQueuedRunScope,
  serverQueuedRunsForScope,
  serverQueuedRunsForVisibleConversation,
  upsertServerQueuedRunProjection,
  type ServerQueuedRunProjectionScope,
  type ServerQueuedRunProjection,
} from "../components/session/server-queue-projection-model.js";
import { createServerQueueProjectionController } from "../components/session/server-queue-projection-controller.js";
import { getEditableUserMessageDraft, type EditableUserMessageDraft } from "../components/session/message-editability";
import {
  createPendingSubmittedDraft,
  pendingSubmittedDraftToEditable,
  pendingSubmittedDraftToMessage,
} from "../components/session/pending-submit-model";
import {
  decidePendingSubmittedTranscriptAdoption,
  resolvePendingSubmittedRenderReplacement,
} from "../components/session/pending-submit-reconciliation";
import {
  createPendingSessionInstanceId,
  materializePendingSessionInstance,
  removePendingSubmittedDraftForKey,
  selectPendingSubmittedDraft,
  setPendingSubmittedDraftForKey,
  type PendingSubmittedDraftBySessionKey,
} from "../components/session/pending-session-instance-model";
import {
  appendQueuedDraft,
  resolveQueuedDraftSessionKey,
  type QueuedDraft,
  type QueuedDraftEnvelope,
} from "../components/session/session-queue-model.js";
import { shouldShowSessionLoadingState } from "../components/session/session-loading-state-model";
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
import {
  createInitialSidebarLayoutState,
  toggleSidebarFromButton,
  type SidebarLayoutState,
  type SidebarSide,
} from "../components/session/sidebar-layout-model";
import FlyoutItem from "../components/flyout-item";
import QuestionModal from "../components/question-modal";
import type { ArtifactFamily } from "../components/session/artifact-family-model";
import type { SessionCapabilitiesSnapshot } from "../lib/session-capabilities";
import { openSidebarSessionFromList, type SessionBrowseScope } from "./session-navigation";
import type { WorkspaceActivationOptions } from "../context/workspace-types";
import type { ReconnectState } from "../context/session-reconnect";
import { createSessionViewFlowFacade } from "../context/session-flow-facade";
import { createSessionQueueDrainController } from "../context/session-queue-drain-controller";
import {
  availableChatWidthForLayout,
  reconcileSidebarLayoutForRootWidth,
  responsiveLayoutRootWidth,
} from "./session-layout-width";
import { resolveSessionTitlebarContext } from "./session-titlebar-context";
import {
  EMPTY_RUN_STATE,
  createSessionConversationFlow,
  remapPendingQueueToSession as remapPendingQueueToSessionRecord,
  remapPendingRunStateToSession as remapPendingRunStateToSessionRecord,
  remapQueuePausedToSession,
  resolveActiveUiConversationWorkspaceId,
  resolveCurrentSessionQueueKey,
  resolvePendingDraftWorkspaceId,
  resolvePendingSessionQueueKey,
  resolveTranscriptDisplaySessionId,
  resetRunStateRecord,
  resolveSessionIdForQueueKey,
  resolveSessionQueueKeyForSessionId,
  shouldClearMaterializedSubmitDisplayHold,
  restoreMaterializedQueueToPending as restoreMaterializedQueueToPendingRecord,
  restoreQueuePausedToPending,
  resolveWorkspaceIdForQueueKey,
  resolveWorkspaceIdForSessionQueue,
  updateRunStateRecord,
  type RunUiState,
  type SessionQueueKeyContext,
} from "./session-conversation-flow";
import {
  createSessionTranscriptViewport,
  shouldAutoScrollForRunProgress,
  shouldAutoScrollForTranscriptGrowth,
} from "./session-transcript-viewport";
import {
  createSessionSearchCommandController,
  messageIdFromInfo,
  resolveSessionSearchCommandShortcut,
} from "./session-search-command-controller";
import SessionLeftSidebar from "./session-left-sidebar";
import SessionRightSidebar from "./session-right-sidebar";
import SessionCenter from "./session-center";
import { createWorkspaceShareController } from "./workspace-share-controller";
import { formatRunElapsedDuration } from "./session-run-elapsed-label";
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../i18n";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import { readSessionStatus, scopedSessionStatusKey } from "../lib/scoped-session-status";
import type { WorkspaceBusyMap } from "../context/workspace-debug";
import type { SessionRunDiagnostic } from "../context/session-lifecycle-recovery";
import type { SidebarSessionActivity } from "../context/sidebar-session-activity-projection";

function recordSendTrace(event: string, payload?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const root = window as typeof window & {
      __vesloSendTrace?: Array<Record<string, unknown>>;
    };
    const logs = root.__vesloSendTrace ?? [];
    logs.push({
      at: new Date().toISOString(),
      source: "session-page",
      event,
      ...(payload ?? {}),
    });
    if (logs.length > 120) logs.splice(0, logs.length - 120);
    root.__vesloSendTrace = logs;
    recordSendWorkflowTrace("session-page", event, payload);
  } catch {
    // ignore
  }
}

const sessionUiMutationTraceEnabled = () => {
  try {
    if (!import.meta.env?.DEV) return false;
    const value = import.meta.env?.VITE_VESLO_SESSION_UI_MUTATION_TRACE;
    return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  } catch {
    return false;
  }
};

const describeSessionUiMutationTarget = (node: Node) => {
  if (!(node instanceof Element)) return node.nodeName.toLowerCase();
  const testId = node.getAttribute("data-testid");
  if (testId) return `[data-testid=${testId}]`;
  if (node.id) return `#${node.id}`;
  const classes = Array.from(node.classList).slice(0, 2);
  return `${node.tagName.toLowerCase()}${classes.length ? `.${classes.join(".")}` : ""}`;
};

type TempRuntimeUiRenderSurface = "workspace-initial" | "conversation";
type TempRuntimeUiMarkerKind = "initial" | "flow" | "message-blocks";

type TempRuntimeUiRenderSource = {
  source: string;
  reason: string;
  markerKind: TempRuntimeUiMarkerKind;
  surface: TempRuntimeUiRenderSurface;
  activeWorkspaceId: string;
  activeWorkspaceRoot: string;
  workspacesHydrated: boolean;
  engineReady: boolean;
  clientConnected: boolean;
  activeWorkspaceHasRoutingEntry: boolean;
  activeWorkspaceSessionsLoaded: boolean;
  selectedSessionId: string | null;
  currentSessionQueueKey: string;
  messageCount: number;
  effectiveMessageCount?: number;
  workspaceSetupVisible?: boolean;
  composerEntryVisible?: boolean;
  sessionLoadingVisible?: boolean;
  activePendingDraftKey: string | null;
  clientMessageId?: string;
  origin?: SessionSendOrigin;
  detail?: string;
  at: number;
};

type TempRuntimeUiMarkerOptions = Pick<
  Partial<TempRuntimeUiRenderSource>,
  "clientMessageId" | "origin" | "detail" | "markerKind"
> & {
  markerPayload?: Record<string, unknown>;
};

type ActiveSessionSwitchHandoff = {
  fromSessionId: string;
  toSessionId: string;
  heldMessages: MessageWithParts[];
  observedLoading: boolean;
  startedAt: number;
  token: number;
};

export type SessionHistoryUnavailableView = {
  sessionId: string;
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
  reason?: string | null;
};

export type SessionViewProps = {
  selectedSessionId: string | null;
  activePendingDraftKey: string | null;
  activePendingDraftMeta: PendingSessionDraftSummary | null;
  composerTargetOptions: ComposerTargetOption[];
  activeComposerTargetId: string | null;
  switchComposerTarget: (targetId: string) => Promise<ComposerTargetSwitchResult>;
  setView: (view: View, sessionId?: string) => void;
  setSessionBrowseScope: (scope: SessionBrowseScope) => void;
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  onOpenFeedback: () => void;
  activeWorkspaceDisplay: WorkspaceDisplay;
  activeWorkspaceRoot: string;
  workspaces: WorkspaceInfo[];
  workspacesHydrated?: boolean;
  activeWorkspaceId: string;
  activeUiConversationRef?: UiConversationRef;
  activeWorkspaceHasRoutingEntry?: boolean;
  activeWorkspaceSessionsLoaded?: boolean;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  readyEngineWorkspaceIds?: Set<string>;
  activateWorkspace: (workspaceId: string, options: WorkspaceActivationOptions) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  recoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean;
  editWorkspaceConnection: (workspaceId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
  openCreateWorkspace: () => void;
  openCreateRemoteWorkspace: () => void;
  openNewSessionWithDirectory: () => Promise<boolean | void> | boolean | void;
  openDirectorySessionFromPicker: () => void;
  openPendingDirectoryDraftInWorkspace: (workspaceId: string) => void;
  canChooseSessionFolder: boolean;
  chooseFolderForCurrentSession: () => Promise<boolean>;
  showRemoteActions?: boolean;
  importWorkspaceConfig: () => void;
  importingWorkspaceConfig: boolean;
  exportWorkspaceConfig: (workspaceId?: string) => void;
  exportWorkspaceBusy: boolean;
  engineReady?: boolean;
  clientConnected: boolean;
  authenticatedUser: string | null;
  onLogout: () => Promise<void> | void;
  onSignIn: () => Promise<void> | void;
  vesloServerStatus: VesloServerStatus;
  vesloServerConnection: VesloServerConnectionSnapshot;
  startupPreference: StartupPreference | null;
  hideTitlebar: boolean;
  vesloServerClient: VesloServerClient | null;
  vesloServerSettings: VesloServerSettings;
  vesloServerHostInfo: VesloServerInfo | null;
  vesloServerWorkspaceId: string | null;
  engineInfo: EngineInfo | null;
  stopHost: () => void;
  headerStatus: string;
  busyHint: string | null;
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
  updateAutoDownload: boolean;
  anyActiveRuns: boolean;
  downloadUpdate: () => void;
  retryUpdateDownload: () => void;
  installUpdateAndRestart: () => void;
  createSessionAndOpen: () => Promise<string | undefined>;
  sendPromptAsync: (
    draft: ComposerDraft,
    options: SessionSendOptionsBase & {
      targetSessionId?: string | null;
      onMaterializedSessionId?: (handoff: MaterializedSessionHandoff) => void;
      pendingSession?: PendingSidebarSessionMetadata | null;
      implicitSkillCommandPolicy?: "confirm" | "allow" | "disable";
    },
  ) => Promise<SessionSubmitResult>;
  replaceUserMessageAsync: (
    messageId: string,
    draft: ComposerDraft,
    options: SessionSendOptionsBase & { targetSessionId?: string | null },
  ) => Promise<SessionSubmitResult>;
  clearComposerDraftForSession: (sessionId: string | null | undefined) => void;
  abortSession: (sessionId?: string) => Promise<void>;
  sessionRevertMessageId: string | null;
  undoLastUserMessage: () => Promise<void>;
  redoLastUserMessage: () => Promise<void>;
  compactSession: () => Promise<void>;
  lastPromptSent: string;
  retryLastPrompt: () => void;
  newTaskDisabled: boolean;
  pendingPermissionCountByWs?: Record<string, number>;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  unreadSessionIds: Record<string, true>;
  workspaceSessionPagingById: Record<string, { hasMore: boolean; loadingMore: boolean }>;
  subagentDecorationsBySessionId: Record<string, SidebarSubagentDecoration>;
  archivedSessionIds: string[];
  archiveSession: (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) => Promise<void> | void;
  unarchiveSession: (workspaceId: string, sessionId: string, target?: SidebarSessionOpenTarget) => Promise<void> | void;
  loadMoreWorkspaceSidebarSessions: (workspaceId: string) => Promise<void> | void;
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean;
  openRenameWorkspace: (workspaceId: string) => void;
  selectSession: (sessionId: string) => Promise<void> | void;
  selectedSessionTitle: string | null;
  messages: MessageWithParts[];
  todos: TodoItem[];
  busyLabel: string | null;
  developerMode: boolean;
  showThinking: boolean;
  groupMessageParts: (parts: Part[], messageId: string) => MessageGroup[];
  summarizeStep: (part: Part) => { title: string; detail?: string };
  expandedStepIds: Set<string>;
  setExpandedStepIds: (updater: (current: Set<string>) => Set<string>) => Set<string>;
  expandedTimelineSectionIds: Set<string>;
  setExpandedTimelineSectionIds: (updater: (current: Set<string>) => Set<string>) => Set<string>;
  expandedTimelineDetailIds: Set<string>;
  setExpandedTimelineDetailIds: (updater: (current: Set<string>) => Set<string>) => Set<string>;
  expandedSidebarSections: SidebarSectionState;
  setExpandedSidebarSections: (
    updater: (current: SidebarSectionState) => SidebarSectionState,
  ) => SidebarSectionState;
  artifacts: ArtifactItem[];
  artifactFamilies: ArtifactFamily[];
  sessionCapabilities: SessionCapabilitiesSnapshot | null;
  sessionCapabilitiesStatus: "idle" | "loading" | "ready" | "error";
  sessionCapabilitiesError: string | null;
  workingFiles: string[];
  authorizedDirs: string[];
  activePlugins: string[];
  activePluginStatus: string | null;
  mcpServers: McpServerEntry[];
  mcpStatuses: McpStatusMap;
  mcpStatus: string | null;
  skills: SkillCard[];
  skillsStatus: string | null;
  showSkillReloadBanner: boolean;
  reloadBannerTitle: string;
  reloadBannerBody: string;
  reloadBannerBlocked: boolean;
  reloadBannerActiveCount: number;
  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: (workspaceId?: string) => Promise<void>;
  refreshWorkspaceConfig: (workspacePath?: string) => Promise<void>;
  forceStopActiveConversations: () => Promise<void>;
  dismissReloadBanner: () => void;
  reloadBusy: boolean;
  reloadError: string | null;
  busy: boolean;
  composerDraft: ComposerDraft;
  setComposerDraft: (draft: ComposerDraft) => void;
  prompt: string;
  setPrompt: (value: string) => void;
  reconnectNotice: "reconnecting" | "reconnected" | null;
  reconnectState: ReconnectState | null;
  clearReconnectNotice: () => void;
  activePermission: PendingPermission | null;
  showTryNotionPrompt: boolean;
  onTryNotionPrompt: () => void;
  permissionReplyBusy: boolean;
  respondPermission: (requestID: string, reply: "once" | "always" | "reject") => void;
  respondPermissionAndRemember: (requestID: string, reply: "once" | "always" | "reject") => void;
  activeQuestion: PendingQuestion | null;
  questionReplyBusy: boolean;
  respondQuestion: (requestID: string, answers: string[][]) => void;
  safeStringify: (value: unknown) => string;
  error: string | null;
  sessionStatus: string;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  aiAccessBlockedReason: string | null;
  listAgents: () => Promise<Agent[]>;
  searchFiles: (query: string) => Promise<string[]>;
  listCommands: () => Promise<{ id: string; name: string; description?: string; source?: "command" | "mcp" | "skill" }[]>;
  selectedSessionAgent: string | null;
  setSessionAgent: (sessionId: string, agent: string | null) => void;
  saveSession: (sessionId: string) => Promise<string>;
  sessionStatusById: Record<string, string>;
  sidebarSessionActivityByRowKey: Record<string, SidebarSessionActivity>;
  conversationRunDiagnosticsBySessionKey: Record<string, SessionRunDiagnostic>;
  busySessionByWorkspaceId?: WorkspaceBusyMap;
  historyUnavailable: SessionHistoryUnavailableView | null;
  historyUnavailableRetrying: boolean;
  retryUnavailableHistory: (sessionId: string) => Promise<void> | void;
  retryAcceptedRunForSession: (sessionId: string, workspaceId?: string | null) => number;
  retryTerminalTranscriptRecoveryForSession: (sessionId: string, workspaceId?: string | null) => number;
  hasEarlierMessages: boolean;
  loadingEarlierMessages: boolean;
  loadEarlierMessages: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string, workspaceId?: string) => Promise<void>;
};

const SESSION_TOAST_DISMISS_DELAY_MS = 4_000;
const MAIN_THREAD_LAG_INTERVAL_MS = 200;
const MAIN_THREAD_LAG_WARN_MS = 180;
const SESSION_DEFAULT_SIDEBAR_DOCKED_VISIBILITY = {
  left: true,
  right: true,
};
const interpolate = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );

const reconnectStateLabelKey = (status: ReconnectState["status"]) => {
  switch (status) {
    case "reconnecting":
      return "session.reconnect_state_reconnecting";
    case "catching-up":
      return "session.reconnect_state_catching_up";
    case "runtime-recovering":
      return "session.reconnect_state_runtime_recovering";
    case "degraded":
      return "session.reconnect_state_degraded";
    case "live":
    default:
      return "session.reconnect_state_live";
  }
};

type ImplicitSkillConfirmationRequest = {
  sessionKey: string;
  draft: ComposerDraft;
  options: ComposerSendOptions;
  skillName: string;
  arguments: string;
};

const snapshotImplicitSkillConfirmationDraft = (draft: ComposerDraft): ComposerDraft => ({
  ...draft,
  parts: draft.parts.map((part) => ({ ...part })),
  attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  command: draft.command ? { ...draft.command } : undefined,
});

export default function SessionView(props: SessionViewProps) {
  const tr = (key: string) => t(key, currentLocale());
  const formatTr = (key: string, values: Record<string, string | number>) =>
    interpolate(tr(key), values);
  const visibleReconnectState = createMemo(() => {
    const state = props.reconnectState;
    if (!state || state.status === "live") return null;
    return state;
  });
  const reconnectStateDetail = (state: ReconnectState) => {
    const details: string[] = [];
    if (state.attempt) details.push(formatTr("session.reconnect_state_attempt", { attempt: state.attempt }));
    if (state.delayMs) {
      details.push(formatTr("session.reconnect_state_retry_seconds", {
        seconds: Math.max(1, Math.ceil(state.delayMs / 1000)),
      }));
    }
    if (state.messagesMayBeDelayed) details.push(tr("session.reconnect_state_messages_delayed"));
    if (state.lastError) details.push(state.lastError);
    return details.join(" · ");
  };
  let messagesEndEl: HTMLDivElement | undefined;
  let bottomVisibilityEl: HTMLDivElement | undefined;
  let chatContainerEl: HTMLDivElement | undefined;
  let sessionLayoutRootEl: HTMLDivElement | undefined;
  const [sessionUiMutationRoot, setSessionUiMutationRoot] = createSignal<HTMLDivElement>();
  let scrollMessageIntoViewById: ((messageId: string, behavior?: ScrollBehavior) => boolean) | null = null;
  const [isChatContainerReady, setIsChatContainerReady] = createSignal(false);
  let sessionMenuRef: HTMLDivElement | undefined;
  let searchInputEl: HTMLInputElement | undefined;
  let sidebarLayoutResizeFrame: number | undefined;

  const [toastMessage, setToastMessage] = createSignal<string | null>(null);
  const [renameModalOpen, setRenameModalOpen] = createSignal(false);
  const [renameTitle, setRenameTitle] = createSignal("");
  const [renameTargetSessionId, setRenameTargetSessionId] = createSignal<string | null>(null);
  const [renameBusy, setRenameBusy] = createSignal(false);
  const [newSessionBusy, setNewSessionBusy] = createSignal(false);
  const [newSessionError, setNewSessionError] = createSignal<string | null>(null);
  const [folderAccessGrantBusy, setFolderAccessGrantBusy] = createSignal(false);
  const [folderAccessError, setFolderAccessError] = createSignal<string | null>(null);

  const [sessionMenuOpen, setSessionMenuOpen] = createSignal(false);
  const [deleteSessionOpen, setDeleteSessionOpen] = createSignal(false);
  const [deleteSessionBusy, setDeleteSessionBusy] = createSignal(false);
  const [deleteSessionTarget, setDeleteSessionTarget] = createSignal<{
    sessionId: string;
    workspaceId: string | null;
  } | null>(null);
  const [implicitSkillConfirmationBySessionKey, setImplicitSkillConfirmationBySessionKey] =
    createSignal<Record<string, ImplicitSkillConfirmationRequest>>({});
  const [historyActionBusy, setHistoryActionBusy] = createSignal<"undo" | "redo" | "compact" | null>(null);

  const [layoutRootWidth, setLayoutRootWidth] = createSignal(0);
  const [leftSidebarWidth, setLeftSidebarWidth] = createSignal(readLeftSidebarWidth());
  const [leftSidebarResizing, setLeftSidebarResizing] = createSignal(false);
  const [sidebarLayoutState, setSidebarLayoutState] = createSignal<SidebarLayoutState>(
    createInitialSidebarLayoutState(
      readGlobalSidebarDockedPrefs(undefined, {
        defaultVisibility: SESSION_DEFAULT_SIDEBAR_DOCKED_VISIBILITY,
      }),
    ),
  );
  const selectedSessionSidebarItem = createMemo(() => {
    const id = props.selectedSessionId?.trim() ?? "";
    if (!id) return null;
    for (const group of props.workspaceSessionGroups) {
      const match = group.sessions.find((session) => session.id === id);
      if (match) return match;
    }
    return null;
  });
  const selectedSessionTitle = createMemo(() =>
    props.selectedSessionTitle?.trim() || selectedSessionSidebarItem()?.title?.trim() || "",
  );
  const openNewSessionFromEmptyState = async () => {
    if (newSessionBusy()) return;
    setNewSessionError(null);
    setNewSessionBusy(true);
    try {
      const opened = await props.openNewSessionWithDirectory();
      if (opened === false) {
        setNewSessionError(tr("session.open_chat_failed"));
      }
    } catch (error) {
      setNewSessionError(error instanceof Error ? error.message : tr("session.open_chat_failed"));
    } finally {
      setNewSessionBusy(false);
    }
  };
  const newSessionDisplayError = createMemo(() => props.error ?? newSessionError());
  const activeFolderAccessRequest = createMemo(() =>
    resolveFolderAccessRequestFromPermission({
      permission: props.activePermission,
      workspacePath: props.activeWorkspaceRoot,
      activeWorkspaceId: props.activeWorkspaceId,
      workspaces: props.workspaces,
      authorizedDirs: props.authorizedDirs,
    }),
  );
  createEffect(() => {
    if (activeFolderAccessRequest()) return;
    setFolderAccessError(null);
  });
  const chooseFolderForAccessRequest = async () => {
    const request = activeFolderAccessRequest();
    if (!request || folderAccessGrantBusy()) return;

    setFolderAccessGrantBusy(true);
    setFolderAccessError(null);
    try {
      const selectedFolder = await pickDirectory({
        title: tr("folder_access.choose_folder"),
        defaultPath: request.pickerStartPath,
      });
      const selectedFolderPath = Array.isArray(selectedFolder)
        ? selectedFolder[0]?.trim() ?? ""
        : selectedFolder?.trim() ?? "";
      if (!selectedFolderPath) return;
      if (!selectedFolderContainsRequestedPath(selectedFolderPath, request.requestedPath)) {
        setFolderAccessError("invalid_selection");
        return;
      }

      await workspaceGrantFolderAccess({
        workspacePath: request.workspacePath,
        requestedPath: request.requestedPath,
        selectedFolderPath,
        accessMode: "read",
      });
      await props.refreshWorkspaceConfig(request.workspacePath);
      await props.reloadWorkspaceEngine(request.workspaceId);
      props.respondPermission(request.permissionId, "once");
    } catch (error) {
      reportError(error, "folderAccessConsent.chooseFolder");
      setFolderAccessError(error instanceof Error ? error.message : props.safeStringify(error));
    } finally {
      setFolderAccessGrantBusy(false);
    }
  };
  const cancelFolderAccessRequest = () => {
    const request = activeFolderAccessRequest();
    if (!request || folderAccessGrantBusy()) return;
    props.respondPermission(request.permissionId, "reject");
  };
  const sessionTitlebarContextModel = createMemo(() => {
    const rootPath = props.activeWorkspaceRoot.trim();
    return resolveSessionTitlebarContext({
      selectedSessionId: props.selectedSessionId,
      selectedSessionTitle: selectedSessionTitle() || null,
      messageCount: props.messages.length,
      workspaceType: props.activeWorkspaceDisplay.workspaceType,
      activeWorkspaceRoot: rootPath,
      localWorkspaceLabel: tr("session.local_workspace_label"),
      remoteWorkspaceLabel: tr("session.remote_workspace_label"),
      newSessionLabel: tr("session.chat_label"),
      chatFallbackLabel: tr("session.chat_label"),
      isPrivateWorkspacePath: props.isPrivateWorkspacePath(rootPath),
    });
  });

  const sessionTitlebarContext = createMemo(() => {
    const context = sessionTitlebarContextModel();
    if (!context) return null;
    const stateLabel = context.stateLabel;
    const locationLabel = context.locationLabel;
    return (
      <span class="flex min-w-0 items-center gap-1.5 leading-6">
        <Show when={stateLabel}>
          {(label) => (
            <span
              class="inline-block min-w-0 max-w-[14rem] truncate rounded-md border border-gray-6/70 bg-gray-2 px-1.5 align-middle text-[11px] font-medium leading-5 text-gray-11"
              title={label()}
            >
              {label()}
            </span>
          )}
        </Show>
        <Show when={stateLabel && locationLabel}>
          <span class="shrink-0 text-[11px] leading-6 text-gray-8" aria-hidden="true">
            ·
          </span>
        </Show>
        <Show when={locationLabel}>
          {(label) => (
            <span
              class={
                context.locationUsePathStyle
                  ? "truncate text-[12px] leading-6 text-gray-10"
                  : "truncate text-[10px] font-bold uppercase leading-6 text-gray-10"
              }
              title={context.locationTitle ?? label()}
            >
              {label()}
            </span>
          )}
        </Show>
      </span>
    );
  });

  let releaseNativeWindowTitleLease: (() => void) | null = null;

  onMount(() => {
    releaseNativeWindowTitleLease = acquireBlankNativeWindowTitleLease();
  });

  onCleanup(() => {
    releaseNativeWindowTitleLease?.();
  });

  let commandPaletteInputEl: HTMLInputElement | undefined;
  const commandPaletteOptionRefs: HTMLButtonElement[] = [];
  const leftDockedVisible = createMemo(
    () => sidebarLayoutState().mode === "wide" && sidebarLayoutState().docked.left,
  );
  const rightDockedVisible = createMemo(
    () => sidebarLayoutState().mode === "wide" && sidebarLayoutState().docked.right,
  );
  const useCompactCenterColumn = createMemo(() => {
    const rootWidth = layoutRootWidth();
    if (rootWidth <= 0) return false;
    if (!leftDockedVisible() || !rightDockedVisible()) return false;
    return availableChatWidthForLayout(rootWidth, sidebarLayoutState(), leftSidebarWidth()) < 740;
  });
  const centerColumnWidthClass = (wideWidth: string) => {
    const widthClass = createMemo(() => (useCompactCenterColumn() ? "max-w-full" : wideWidth));
    return widthClass;
  };
  const searchBannerWidthClass = centerColumnWidthClass("max-w-[800px]");
  const chatBodyWidthClass = centerColumnWidthClass("max-w-[960px]");
  const railWidthClass = centerColumnWidthClass("max-w-[68ch]");
  const overlayOpenSide = createMemo(() =>
    sidebarLayoutState().mode === "narrow" ? sidebarLayoutState().overlay : null,
  );
  const leftSidebarToggleActive = createMemo(() =>
    sidebarLayoutState().mode === "wide"
      ? sidebarLayoutState().docked.left
      : sidebarLayoutState().overlay === "left",
  );
  const rightSidebarToggleActive = createMemo(() =>
    sidebarLayoutState().mode === "wide"
      ? sidebarLayoutState().docked.right
      : sidebarLayoutState().overlay === "right",
  );

  const applySidebarModeForRootWidth = (rootWidth: number) => {
    if (rootWidth <= 0) return;
    setSidebarLayoutState((current) =>
      reconcileSidebarLayoutForRootWidth(current, rootWidth, leftSidebarWidth(), {
        overlayOnNarrow:
          leftSidebarResizing() && current.mode === "wide" && current.docked.left ? "left" : null,
      }),
    );
  };

  const queueSidebarRootMeasurement = () => {
    if (sidebarLayoutResizeFrame !== undefined) return;
    sidebarLayoutResizeFrame = requestAnimationFrame(() => {
      sidebarLayoutResizeFrame = undefined;
      const rootWidth = responsiveLayoutRootWidth(
        sessionLayoutRootEl?.clientWidth ?? 0,
        typeof window !== "undefined" ? window.innerWidth : undefined,
      );
      setLayoutRootWidth(rootWidth);
      applySidebarModeForRootWidth(rootWidth);
    });
  };

  const closeSidebarOverlay = () => {
    setSidebarLayoutState((current) => {
      if (current.mode !== "narrow" || current.overlay === null) return current;
      return {
        ...current,
        overlay: null,
      };
    });
  };

  const toggleSidebarMenu = (side: SidebarSide) => {
    const measuredRootWidth = layoutRootWidth() || responsiveLayoutRootWidth(
      sessionLayoutRootEl?.clientWidth ?? 0,
      typeof window !== "undefined" ? window.innerWidth : undefined,
    );
    setSidebarLayoutState((current) => {
      const toggled = toggleSidebarFromButton(current, side);
      if (current.mode === "wide" && toggled.mode === "wide") {
        writeGlobalSidebarDockedPrefs(toggled.dockedPreference);
      }
      if (measuredRootWidth <= 0) return toggled;
      return reconcileSidebarLayoutForRootWidth(toggled, measuredRootWidth, leftSidebarWidth());
    });
  };

  const leftSidebarDockedStyle = createMemo(() => ({ width: `${leftSidebarWidth()}px` }));
  const leftSidebarOverlayStyle = createMemo(() => ({
    width: `min(${leftSidebarWidth()}px, calc(100vw - 32px))`,
  }));

  let leftSidebarResizeCleanup: (() => void) | null = null;
  const stopLeftSidebarResize = (persist: boolean) => {
    if (leftSidebarResizeCleanup) {
      leftSidebarResizeCleanup();
      leftSidebarResizeCleanup = null;
    }
    if (!leftSidebarResizing()) return;
    setLeftSidebarResizing(false);
    if (persist) {
      const normalized = writeLeftSidebarWidth(leftSidebarWidth());
      setLeftSidebarWidth(normalized);
    }
    if (typeof window !== "undefined") {
      queueSidebarRootMeasurement();
    }
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
    const resizeListeners = new AbortController();
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - initialX;
      setLeftSidebarWidth(clampLeftSidebarWidth(initialWidth + delta));
      queueSidebarRootMeasurement();
    };
    const onPointerUp = () => stopLeftSidebarResize(true);
    const onPointerCancel = () => stopLeftSidebarResize(true);

    window.addEventListener("pointermove", onPointerMove, { signal: resizeListeners.signal });
    window.addEventListener("pointerup", onPointerUp, { once: true, signal: resizeListeners.signal });
    window.addEventListener("pointercancel", onPointerCancel, { once: true, signal: resizeListeners.signal });

    leftSidebarResizeCleanup = () => {
      resizeListeners.abort();
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  };

  onCleanup(() => stopLeftSidebarResize(false));

  createEffect(() => {
    const root = sessionLayoutRootEl;
    if (!root) return;

    const onResize = () => queueSidebarRootMeasurement();
    window.addEventListener("resize", onResize);

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        queueSidebarRootMeasurement();
      });
      observer.observe(root);
      queueSidebarRootMeasurement();
      onCleanup(() => {
        observer.disconnect();
        window.removeEventListener("resize", onResize);
        if (sidebarLayoutResizeFrame !== undefined) {
          window.cancelAnimationFrame(sidebarLayoutResizeFrame);
          sidebarLayoutResizeFrame = undefined;
        }
      });
      return;
    }

    queueSidebarRootMeasurement();
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      if (sidebarLayoutResizeFrame !== undefined) {
        window.cancelAnimationFrame(sidebarLayoutResizeFrame);
        sidebarLayoutResizeFrame = undefined;
      }
    });
  });

  createEffect(() => {
    if (!overlayOpenSide()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeSidebarOverlay();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  const workspaceLabel = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.vesloWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    tr("sidebar.workspace_fallback");
  const activeComposerTargetOption = createMemo(() =>
    props.composerTargetOptions.find((option) => option.id === props.activeComposerTargetId) ??
    props.composerTargetOptions[0] ??
    null,
  );
  const composerEntryTargetName = createMemo(() =>
    activeComposerTargetOption()?.label ?? workspaceLabel(props.activeWorkspaceDisplay),
  );
  const composerEntryHeading = createMemo(() => {
    const target = activeComposerTargetOption();
    if (target?.kind === "chat") return tr("session.target_heading_chat");
    return formatTr("session.target_heading_workspace", { name: composerEntryTargetName() });
  });
  const todoList = createMemo(() => props.todos.filter((todo) => todo.content.trim()));
  const todoCount = createMemo(() => todoList().length);
  const todoCompletedCount = createMemo(() =>
    todoList().filter((todo) => todo.status === "completed").length
  );
  const hasWorkspaceConfigured = createMemo(() => props.workspaces.length > 0);
  const showWorkspaceSetupEmptyState = createMemo(
    () =>
      props.workspacesHydrated === true &&
      !hasWorkspaceConfigured() &&
      !props.selectedSessionId &&
      props.messages.length === 0,
  );
  const sessionWorkspaceContextLabel = createMemo(() => {
    if (showWorkspaceSetupEmptyState()) return "";
    if (props.activeWorkspaceDisplay.workspaceType !== "local") return "";
    if (!props.activeWorkspaceRoot.trim()) return "";
    return props.canChooseSessionFolder ? tr("sidebar.private_workspace") : workspaceLabel(props.activeWorkspaceDisplay);
  });

  const searchCommand = createSessionSearchCommandController({
    messages: () => props.messages,
    workspaceSessionGroups: () => props.workspaceSessionGroups,
    activeWorkspaceId: () => props.activeWorkspaceId,
    developerMode: () => props.developerMode,
    labels: () => ({
      createSessionTitle: tr("session.command_palette_create_session"),
      createSessionDetail: tr("session.command_palette_create_session_detail"),
      createSessionMeta: tr("session.command_palette_meta_create"),
      createSessionFailed: tr("session.failed_create_session"),
      searchSessionsTitle: tr("session.command_palette_search_sessions"),
      searchSessionsDetail: (count) =>
        formatTr("session.command_palette_search_sessions_detail", {
          count: count.toLocaleString(),
        }),
      searchSessionsMeta: tr("session.command_palette_meta_jump"),
      currentWorkspaceMeta: tr("session.command_palette_meta_current_workspace"),
      switchWorkspaceMeta: tr("session.command_palette_meta_switch"),
      untitledSession: tr("session.untitled"),
      quickActionsTitle: tr("session.quick_actions"),
      actionsPlaceholder: tr("session.command_palette_search_actions"),
      sessionsPlaceholder: tr("session.command_palette_find_by_session_or_workspace"),
      noSearchMatches: tr("session.search_no_matches"),
    }),
    workspaceLabel,
    perfNow,
    recordPerfLog,
    focusSearchInput: () => focusSearchInput(),
    focusCommandPaletteInput: () => focusCommandPaletteInput(),
    createSessionAndOpen: () => props.createSessionAndOpen(),
    openSessionFromList: (workspaceId, sessionId) => openSessionFromList(workspaceId, sessionId),
    setToastMessage,
  });
  const searchOpen = searchCommand.searchOpen;
  const searchQuery = searchCommand.searchQuery;
  const searchQueryDebounced = searchCommand.searchQueryDebounced;
  const searchActive = searchCommand.searchActive;
  const searchHits = searchCommand.searchHits;
  const searchMatchMessageIds = searchCommand.searchMatchMessageIds;
  const activeSearchHit = searchCommand.activeSearchHit;
  const activeSearchPositionLabel = searchCommand.activeSearchPositionLabel;
  const commandPaletteOpen = searchCommand.commandPaletteOpen;
  const commandPaletteMode = searchCommand.commandPaletteMode;
  const commandPaletteQuery = searchCommand.commandPaletteQuery;
  const commandPaletteActiveIndex = searchCommand.commandPaletteActiveIndex;
  const commandPaletteItems = searchCommand.commandPaletteItems;
  const commandPaletteTitle = searchCommand.commandPaletteTitle;
  const commandPalettePlaceholder = searchCommand.commandPalettePlaceholder;
  const setSearchQuery = searchCommand.setSearchQuery;
  const setCommandPaletteQuery = searchCommand.setCommandPaletteQuery;
  const setCommandPaletteActiveIndex = searchCommand.setCommandPaletteActiveIndex;
  const openCommandPalette = searchCommand.openCommandPalette;
  const closeCommandPalette = searchCommand.closeCommandPalette;
  const returnToCommandRoot = searchCommand.returnToCommandRoot;
  const closeSearch = searchCommand.closeSearch;
  const moveSearchHit = searchCommand.moveSearchHit;

  const queueKeyContext = (): SessionQueueKeyContext => ({
    activeWorkspaceId: props.activeWorkspaceId,
    activeUiConversationRef: props.activeUiConversationRef,
    activePendingDraftKey: props.activePendingDraftKey,
    activePendingDraftMeta: props.activePendingDraftMeta,
  });
  const activeUiConversationWorkspaceId = () =>
    resolveActiveUiConversationWorkspaceId(queueKeyContext());
  const pendingDraftWorkspaceId = () => resolvePendingDraftWorkspaceId(queueKeyContext());
  const workspaceIdForSessionQueue = (sessionId: string) =>
    resolveWorkspaceIdForSessionQueue(queueKeyContext(), sessionId);
  const pendingSessionQueueKey = () => resolvePendingSessionQueueKey(queueKeyContext());
  const sessionQueueKeyForSessionId = (sessionId: string | null | undefined) =>
    resolveSessionQueueKeyForSessionId(queueKeyContext(), sessionId);
  const sessionIdForQueueKey = (sessionKey: string) => resolveSessionIdForQueueKey(sessionKey);
  const workspaceIdForQueueKey = (sessionKey: string) =>
    resolveWorkspaceIdForQueueKey(queueKeyContext(), sessionKey);
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
  const statusForQueueKey = (sessionKey: string, statuses: Record<string, string>) => {
    const sessionId = sessionIdForQueueKey(sessionKey);
    if (!sessionId) return "idle";
    return readSessionStatus(statuses, workspaceIdForQueueKey(sessionKey), sessionId);
  };
  const statusForSessionId = (sessionId: string, statuses: Record<string, string>) =>
    readSessionStatus(statuses, workspaceIdForSessionQueue(sessionId), sessionId);
  const runDiagnosticForQueueKey = (sessionKey: string) => {
    const sessionId = sessionIdForQueueKey(sessionKey);
    if (!sessionId) return null;
    const workspaceId = workspaceIdForQueueKey(sessionKey);
    const scoped = scopedSessionStatusKey(workspaceId, sessionId);
    if (scoped) return props.conversationRunDiagnosticsBySessionKey[scoped] ?? null;
    return props.conversationRunDiagnosticsBySessionKey[sessionId] ?? null;
  };
  const [pendingQueueKeyAwaitingSessionIdByBaseKey, setPendingQueueKeyAwaitingSessionIdByBaseKey] =
    createSignal<Record<string, string>>({});
  const currentSessionQueueKey = createMemo(() => {
    return resolveCurrentSessionQueueKey({
      ...queueKeyContext(),
      selectedSessionId: props.selectedSessionId,
      pendingQueueKeyAwaitingSessionIdByBaseKey: pendingQueueKeyAwaitingSessionIdByBaseKey(),
    });
  });
  const implicitSkillConfirmation = createMemo(() =>
    implicitSkillConfirmationBySessionKey()[currentSessionQueueKey()] ?? null,
  );
  const [composerEntryDismissedBySessionKey, setComposerEntryDismissedBySessionKey] =
    createSignal<Record<string, boolean>>({});
  const composerEntryDismissed = createMemo(() => {
    const dismissedBySessionKey = composerEntryDismissedBySessionKey();
    if (dismissedBySessionKey[currentSessionQueueKey()]) return true;
    if (props.selectedSessionId) return false;
    return Boolean(dismissedBySessionKey[pendingSessionQueueKey()]);
  });
  const dismissComposerEntryForSessionKey = (sessionKey = currentSessionQueueKey()) => {
    const key = sessionKey.trim();
    if (!key) return;
    setComposerEntryDismissedBySessionKey((current) =>
      current[key] ? current : { ...current, [key]: true },
    );
  };
  const tempRuntimeUiSurface = (): TempRuntimeUiRenderSurface =>
    showWorkspaceSetupEmptyState() ? "workspace-initial" : "conversation";
  const sessionUiDiagnosticEnabled = () => props.developerMode || sessionUiMutationTraceEnabled();
  const createTempRuntimeUiRenderSnapshot = (
    source: string,
    reason: string,
    extras: TempRuntimeUiMarkerOptions = {},
  ): TempRuntimeUiRenderSource => {
    const { markerPayload: _markerPayload, ...snapshotExtras } = extras;
    return {
      source,
      reason,
      markerKind: snapshotExtras.markerKind ?? (source === "SessionView.initialRender" ? "initial" : "flow"),
      surface: tempRuntimeUiSurface(),
      activeWorkspaceId: props.activeWorkspaceId.trim(),
      activeWorkspaceRoot: props.activeWorkspaceRoot.trim(),
      workspacesHydrated: props.workspacesHydrated === true,
      engineReady: props.engineReady !== false,
      clientConnected: props.clientConnected,
      activeWorkspaceHasRoutingEntry: props.activeWorkspaceHasRoutingEntry === true,
      activeWorkspaceSessionsLoaded: props.activeWorkspaceSessionsLoaded === true,
      selectedSessionId: props.selectedSessionId?.trim() || null,
      currentSessionQueueKey: currentSessionQueueKey(),
      messageCount: props.messages.length,
      activePendingDraftKey: props.activePendingDraftKey ?? null,
      ...snapshotExtras,
      at: Date.now(),
    };
  };
  const disabledTempRuntimeUiRenderSnapshot = (): TempRuntimeUiRenderSource => ({
    source: "SessionView.diagnostics-disabled",
    reason: "disabled",
    markerKind: "initial",
    surface: "conversation",
    activeWorkspaceId: "",
    activeWorkspaceRoot: "",
    workspacesHydrated: false,
    engineReady: false,
    clientConnected: false,
    activeWorkspaceHasRoutingEntry: false,
    activeWorkspaceSessionsLoaded: false,
    selectedSessionId: null,
    currentSessionQueueKey: "",
    messageCount: 0,
    activePendingDraftKey: null,
    at: 0,
  });
  // TEMP: runtime UI flicker diagnostic. Remove after duplicated workspace/conversation render handoff is identified.
  const [tempRuntimeUiRenderSource, setTempRuntimeUiRenderSource] = createSignal<TempRuntimeUiRenderSource>(
    sessionUiDiagnosticEnabled()
      ? createTempRuntimeUiRenderSnapshot("SessionView.initialRender", "component-created")
      : disabledTempRuntimeUiRenderSnapshot(),
  );
  const markTempRuntimeUiRenderSource = (
    source: string,
    reason: string,
    extras: TempRuntimeUiMarkerOptions = {},
  ) => {
    if (!sessionUiDiagnosticEnabled()) return;
    const snapshot = createTempRuntimeUiRenderSnapshot(source, reason, extras);
    setTempRuntimeUiRenderSource(snapshot);
    if (sessionUiMutationTraceEnabled()) {
      recordSendTrace("session-ui:render-source-mark", {
        source: snapshot.source,
        reason: snapshot.reason,
        markerKind: snapshot.markerKind,
        selectedSessionId: snapshot.selectedSessionId,
        currentSessionQueueKey: snapshot.currentSessionQueueKey,
        messageCount: snapshot.messageCount,
        engineReady: snapshot.engineReady,
        clientConnected: snapshot.clientConnected,
        detail: snapshot.detail ?? null,
        ...(extras.markerPayload ?? {}),
      });
    }
  };
  createEffect(
    on(
      () => [
        showWorkspaceSetupEmptyState(),
        props.selectedSessionId,
        props.messages.length,
        props.activePendingDraftKey,
        props.activeWorkspaceId,
        props.activeWorkspaceRoot,
        props.workspacesHydrated,
        props.engineReady,
        props.clientConnected,
        props.activeWorkspaceHasRoutingEntry,
        props.activeWorkspaceSessionsLoaded,
        currentSessionQueueKey(),
      ] as const,
      ([
        workspaceInitial,
        selectedSessionId,
        messageCount,
        activePendingDraftKey,
        activeWorkspaceId,
        activeWorkspaceRoot,
        workspacesHydrated,
        engineReady,
        clientConnected,
        activeWorkspaceHasRoutingEntry,
        activeWorkspaceSessionsLoaded,
        sessionKey,
      ]) => {
        if (!sessionUiDiagnosticEnabled()) return;
        setTempRuntimeUiRenderSource((current) => ({
          ...current,
          surface: workspaceInitial ? "workspace-initial" : "conversation",
          activeWorkspaceId: activeWorkspaceId.trim(),
          activeWorkspaceRoot: activeWorkspaceRoot.trim(),
          workspacesHydrated: workspacesHydrated === true,
          engineReady: engineReady !== false,
          clientConnected,
          activeWorkspaceHasRoutingEntry: activeWorkspaceHasRoutingEntry === true,
          activeWorkspaceSessionsLoaded: activeWorkspaceSessionsLoaded === true,
          selectedSessionId: selectedSessionId?.trim() || null,
          currentSessionQueueKey: sessionKey,
          messageCount,
          activePendingDraftKey: activePendingDraftKey ?? null,
          at: Date.now(),
        }));
      },
    ),
  );
  const setPendingQueueKeyAwaitingSessionIdForBaseKey = (baseKey: string, pendingKey: string) => {
    const base = baseKey.trim();
    const pending = pendingKey.trim();
    if (!base || !pending) return;
    setPendingQueueKeyAwaitingSessionIdByBaseKey((current) => {
      if (current[base] === pending) return current;
      return { ...current, [base]: pending };
    });
  };
  const clearPendingQueueKeyAwaitingSessionIdForBaseKey = (baseKey: string | null, pendingKey: string | null) => {
    const base = baseKey?.trim();
    const pending = pendingKey?.trim();
    if (!base) return;
    setPendingQueueKeyAwaitingSessionIdByBaseKey((current) => {
      if (!(base in current)) return current;
      if (pending && current[base] !== pending) return current;
      const { [base]: _removedPendingKey, ...rest } = current;
      return rest;
    });
  };
  const [pendingSubmittedDraftBySessionKey, setPendingSubmittedDraftBySessionKey] =
    createSignal<PendingSubmittedDraftBySessionKey>({});
  const optimisticSubmittedDraft = createMemo(() =>
    selectPendingSubmittedDraft(pendingSubmittedDraftBySessionKey(), currentSessionQueueKey()),
  );
  const [materializedSubmitDisplayHoldSessionId, setMaterializedSubmitDisplayHoldSessionId] =
    createSignal<string | null>(null);
  const hasSendingOptimisticSubmit = createMemo(() => optimisticSubmittedDraft()?.state === "sending");
  // The route-selected session can become real before its transcript does.
  // Detect the pending handoff synchronously from the pending-key map, then let
  // the controller-owned hold survive the map cleanup for the next render ticks.
  const selectedMaterializedPendingSubmitSessionId = createMemo(() => {
    const selectedSessionId = props.selectedSessionId?.trim() || null;
    if (!selectedSessionId) return null;
    const pendingBaseKey = pendingSessionQueueKey();
    const materializedPendingKey =
      pendingQueueKeyAwaitingSessionIdByBaseKey()[pendingBaseKey]?.trim() || null;
    if (!materializedPendingKey) return null;
    const selectedSessionKey = sessionQueueKeyForSessionId(selectedSessionId);
    if (materializedPendingKey !== selectedSessionKey) return null;
    return pendingSubmittedDraftBySessionKey()[materializedPendingKey]?.state === "sending"
      ? selectedSessionId
      : null;
  });
  const heldMaterializedSubmitSessionId = createMemo(
    () => selectedMaterializedPendingSubmitSessionId() ?? materializedSubmitDisplayHoldSessionId(),
  );
  const transcriptDisplaySessionId = createMemo(() =>
    resolveTranscriptDisplaySessionId({
      selectedSessionId: props.selectedSessionId,
      heldMaterializedSessionId: heldMaterializedSubmitSessionId(),
      hasSendingOptimisticSubmit: hasSendingOptimisticSubmit(),
      transcriptMessageCount: props.messages.length,
    })
  );
  const composerResetKey = createMemo(() =>
    `${props.activeComposerTargetId ?? "__no-target"}:${transcriptDisplaySessionId() ?? "__no-session"}`
  );
  createEffect(() => {
    const heldMaterializedSessionId = materializedSubmitDisplayHoldSessionId();
    if (!heldMaterializedSessionId) return;
    if (
      shouldClearMaterializedSubmitDisplayHold({
        selectedSessionId: props.selectedSessionId,
        heldMaterializedSessionId,
        hasSendingOptimisticSubmit: hasSendingOptimisticSubmit(),
        transcriptMessageCount: props.messages.length,
      })
    ) {
      setMaterializedSubmitDisplayHoldSessionId(null);
    }
  });
  const setOptimisticSubmittedDraft = (
    sessionKey: string,
    draft: ReturnType<typeof createPendingSubmittedDraft>,
  ) => {
    setPendingSubmittedDraftBySessionKey((current) =>
      setPendingSubmittedDraftForKey(current, sessionKey, draft),
    );
  };
  const [runStateBySessionKey, setRunStateBySessionKey] = createSignal<Record<string, RunUiState>>({});
  const activeRunState = createMemo(() => runStateBySessionKey()[currentSessionQueueKey()] ?? EMPTY_RUN_STATE);
  const runStartedAt = createMemo(() => activeRunState().startedAt);
  const runHasBegun = createMemo(() => activeRunState().hasBegun);
  const runTick = createMemo(() => activeRunState().tick);
  const runLastProgressAt = createMemo(() => activeRunState().lastProgressAt);
  const runBaseline = createMemo(() => activeRunState().baseline);
  const isActiveRunStatus = (status: string | null | undefined) => {
    const normalized = status?.trim().toLowerCase() ?? "";
    return Boolean(normalized && normalized !== "idle");
  };
  const updateRunStateForSessionKey = (sessionKey: string, update: (current: RunUiState) => RunUiState) => {
    const key = sessionKey.trim();
    if (!key) return;
    setRunStateBySessionKey((current) => updateRunStateRecord(current, key, update));
  };
  const resetRunState = (sessionKey = currentSessionQueueKey(), reason = "unspecified-reset") => {
    const key = sessionKey.trim();
    if (!key) return;
    const previous = untrack(runStateBySessionKey)[key];
    if (previous) {
      recordSendTrace("run-state:reset", {
        reason,
        sessionKey: key,
        startedAt: previous.startedAt,
        hasBegun: previous.hasBegun,
        lastProgressAt: previous.lastProgressAt,
      });
    }
    setRunStateBySessionKey((current) => resetRunStateRecord(current, key));
  };
  const preserveRunStateOnSessionSwitch = (sessionKey: string) => {
    const key = sessionKey.trim();
    if (!key) return;
    const previous = untrack(runStateBySessionKey)[key];
    if (!previous) return;
    recordSendTrace("run-state:preserve-session-switch", {
      sessionKey: key,
      status: statusForQueueKey(key, props.sessionStatusById),
      startedAt: previous.startedAt,
      hasBegun: previous.hasBegun,
      lastProgressAt: previous.lastProgressAt,
    });
  };

  const lastAssistantSnapshot = createMemo(() => {
    for (let i = props.messages.length - 1; i >= 0; i -= 1) {
      const msg = props.messages[i];
      const info = msg?.info as { id?: string | number; role?: string } | undefined;
      if (info?.role === "assistant") {
        const id = typeof info.id === "string" ? info.id : typeof info.id === "number" ? String(info.id) : null;
        return { id, partCount: msg.parts.length };
      }
    }
    return { id: null, partCount: 0 };
  });

  const startRun = (sessionKey = currentSessionQueueKey()) => {
    const key = sessionKey.trim();
    if (!key) return;
    if (untrack(runStateBySessionKey)[key]?.startedAt) return;
    const now = Date.now();
    const snapshot = lastAssistantSnapshot();
    recordSendTrace("run-state:start", {
      sessionKey: key,
      startedAt: now,
      baselineAssistantId: snapshot.id,
      baselinePartCount: snapshot.partCount,
    });
    setRunStateBySessionKey((current) => ({
      ...current,
      [key]: {
        startedAt: now,
        hasBegun: false,
        tick: now,
        lastProgressAt: now,
        baseline: { assistantId: snapshot.id, partCount: snapshot.partCount },
      },
    }));
  };
  const setRunHasBegunForSessionKey = (sessionKey: string, hasBegun: boolean) => {
    const key = sessionKey.trim();
    if (!key) return;
    if (untrack(runStateBySessionKey)[key]?.hasBegun === hasBegun) return;
    recordSendTrace("run-state:has-begun", {
      sessionKey: key,
      hasBegun,
    });
    updateRunStateForSessionKey(key, (current) => ({ ...current, hasBegun }));
  };
  const setRunTickForSessionKey = (sessionKey: string, tick: number) => {
    updateRunStateForSessionKey(sessionKey, (current) => ({ ...current, tick }));
  };
  const setRunLastProgressAtForSessionKey = (sessionKey: string, lastProgressAt: number | null) => {
    updateRunStateForSessionKey(sessionKey, (current) => ({ ...current, lastProgressAt }));
  };
  const remapPendingRunStateToSession = (
    pendingKey: string,
    sessionId: string,
    sessionKeyOverride?: string | null,
  ) => {
    const sessionKey = sessionKeyOverride?.trim() || sessionQueueKeyForSessionId(sessionId);
    if (!pendingKey || pendingKey === sessionKey) return;
    const pendingRun = untrack(runStateBySessionKey)[pendingKey];
    recordSendTrace("run-state:remap-pending-to-session", {
      pendingKey,
      sessionId,
      sessionKey,
      hadPendingRun: Boolean(pendingRun),
      pendingStartedAt: pendingRun?.startedAt ?? null,
      pendingHasBegun: pendingRun?.hasBegun ?? null,
    });
    setRunStateBySessionKey((current) =>
      remapPendingRunStateToSessionRecord(current, pendingKey, sessionKey),
    );
  };

  const responseStarted = createMemo(() => {
    if (!runStartedAt()) return false;
    const baseline = runBaseline();
    const snapshot = lastAssistantSnapshot();
    if (!snapshot.id && !baseline.assistantId) return false;
    if (snapshot.id && snapshot.id !== baseline.assistantId) return true;
    return snapshot.id === baseline.assistantId && snapshot.partCount > baseline.partCount;
  });

  const localSubmittedMessage = createMemo<MessageWithParts | null>(() => {
    const submitted = optimisticSubmittedDraft();
    if (!submitted) return null;
    if (submitted.sessionKey !== currentSessionQueueKey()) return null;
    const renderReplacement = resolvePendingSubmittedRenderReplacement({
      pending: submitted,
      messages: props.messages,
      sessionKey: currentSessionQueueKey(),
      sessionId: props.selectedSessionId,
    });
    if (renderReplacement.kind === "show-canonical") return null;
    return pendingSubmittedDraftToMessage(submitted, props.activeWorkspaceRoot);
  });
  createEffect(() => {
    const submitted = optimisticSubmittedDraft();
    if (!submitted || submitted.state !== "sending") return;
    const adoption = decidePendingSubmittedTranscriptAdoption({
      pending: submitted,
      messages: props.messages,
      sessionKey: currentSessionQueueKey(),
      sessionId: props.selectedSessionId,
    });
    if (adoption.kind !== "adopt") return;
    setPendingSubmittedDraftBySessionKey((current) =>
      removePendingSubmittedDraftForKey(current, submitted.sessionKey, submitted.id),
    );
  });

  const pendingMessageStateById = createMemo<Record<string, PendingMessageState>>(() => {
    const submitted = optimisticSubmittedDraft();
    if (!submitted) return {};
    if (submitted.sessionKey !== currentSessionQueueKey()) return {};
    if (submitted.state === "error") {
      return {
        [submitted.id]: { state: "error", error: submitted.error },
      };
    }
    if (submitted.state === "outcome-unknown") {
      return {
        [submitted.id]: { state: "sync-warning", reason: "delivery-unconfirmed" },
      };
    }
    const adoption = decidePendingSubmittedTranscriptAdoption({
      pending: submitted,
      messages: props.messages,
      sessionKey: currentSessionQueueKey(),
      sessionId: props.selectedSessionId,
    });
    if (
      submitted.admission === "accepted" &&
      adoption.kind === "unresolved" &&
      (adoption.reason === "ambiguous-fingerprint" || adoption.reason === "ambiguous-identity") &&
      terminalLifecycleOwnsOptimistic({
        lifecycle: runDiagnosticForQueueKey(submitted.sessionKey),
        optimisticSending: true,
        optimisticAccepted: true,
        acceptedRunId: submitted.acceptedRunId,
        acceptedClientMessageId: submitted.acceptedClientMessageId,
      })
    ) {
      return {
        [submitted.id]: { state: "sync-warning", reason: "ambiguous-legacy" },
      };
    }
    return {};
  });

  const totalPartCount = createMemo(() => props.messages.reduce((total, message) => total + message.parts.length, 0));

  const transcriptViewport = createSessionTranscriptViewport({
    messages: () => props.messages,
    localSubmittedMessage,
    searchActive,
    sessionStatus: () => props.sessionStatus,
    developerMode: () => props.developerMode,
    selectedSessionId: transcriptDisplaySessionId,
    hasEarlierMessages: () => props.hasEarlierMessages,
    isChatContainerReady,
    totalPartCount,
    loadEarlierMessages: (sessionId) => props.loadEarlierMessages(sessionId),
    messagesEndElement: () => messagesEndEl,
    bottomVisibilityElement: () => bottomVisibilityEl,
    chatContainerElement: () => chatContainerEl,
    now: () => Date.now(),
    perfNow,
    recordPerfLog,
    queueMicrotask: (callback) => queueMicrotask(callback),
  });
  const renderedMessages = transcriptViewport.renderedMessages;

  const effectiveRenderedMessages = transcriptViewport.effectiveRenderedMessages;
  const [activeSessionSwitchHandoff, setActiveSessionSwitchHandoff] =
    createSignal<ActiveSessionSwitchHandoff | null>(null);
  let activeSessionSwitchHandoffToken = 0;
  let lastSelectedSessionId = untrack(() => props.selectedSessionId?.trim() ?? "");
  let lastPaintedSessionId = untrack(() => props.selectedSessionId?.trim() ?? "");
  let lastPaintedMessages: MessageWithParts[] = [];
  createEffect(
    on(
      () => [
        props.selectedSessionId?.trim() ?? "",
        effectiveRenderedMessages(),
        props.loadingEarlierMessages,
      ] as const,
      ([sessionId, rendered, loadingEarlierMessages]) => {
        const messageCount = rendered.length;
        const currentHandoff = untrack(activeSessionSwitchHandoff);

        if (!sessionId) {
          setActiveSessionSwitchHandoff(null);
          lastSelectedSessionId = "";
          lastPaintedSessionId = "";
          lastPaintedMessages = [];
          return;
        }

        if (
          lastSelectedSessionId &&
          sessionId !== lastSelectedSessionId &&
          lastSelectedSessionId === lastPaintedSessionId &&
          lastPaintedMessages.length > 0 &&
          messageCount === 0
        ) {
          setActiveSessionSwitchHandoff({
            fromSessionId: lastPaintedSessionId,
            toSessionId: sessionId,
            heldMessages: lastPaintedMessages,
            observedLoading: loadingEarlierMessages,
            startedAt: Date.now(),
            token: ++activeSessionSwitchHandoffToken,
          });
        } else if (currentHandoff?.toSessionId === sessionId) {
          if (messageCount > 0) {
            setActiveSessionSwitchHandoff(null);
          } else if (loadingEarlierMessages && !currentHandoff.observedLoading) {
            setActiveSessionSwitchHandoff({
              ...currentHandoff,
              observedLoading: true,
            });
          } else if (!loadingEarlierMessages && currentHandoff.observedLoading) {
            setActiveSessionSwitchHandoff(null);
          }
        } else if (currentHandoff) {
          setActiveSessionSwitchHandoff(null);
        }

        if (messageCount > 0) {
          lastPaintedSessionId = sessionId;
          lastPaintedMessages = rendered;
        }
        lastSelectedSessionId = sessionId;
      },
    ),
  );
  createEffect(() => {
    const handoff = activeSessionSwitchHandoff();
    if (!handoff || handoff.observedLoading || typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      setActiveSessionSwitchHandoff((current) =>
        current?.token === handoff.token && !current.observedLoading ? null : current,
      );
    }, 250);
    onCleanup(() => window.clearTimeout(timer));
  });
  const activeSessionSwitchHandoffActive = createMemo(() => {
    const handoff = activeSessionSwitchHandoff();
    const sessionId = props.selectedSessionId?.trim() ?? "";
    return Boolean(
      handoff &&
      handoff.toSessionId === sessionId &&
      effectiveRenderedMessages().length === 0 &&
      handoff.heldMessages.length > 0,
    );
  });
  const displayedEffectiveMessages = createMemo(() =>
    activeSessionSwitchHandoffActive()
      ? activeSessionSwitchHandoff()?.heldMessages ?? []
      : effectiveRenderedMessages(),
  );
  const aiAccessLoading = createMemo(() => isAiAccessLoadingMessage(props.aiAccessBlockedReason, tr));
  const aiAccessLoadingWithoutMessages = createMemo(() =>
    aiAccessLoading() && displayedEffectiveMessages().length === 0
  );
  const visibleAiAccessBlockedReason = createMemo(() =>
    resolveActionableAiAccessBlockedReason(props.aiAccessBlockedReason, tr)
  );
  const composerBusy = createMemo(() => props.busy);
  const hiddenMessageCount = transcriptViewport.hiddenMessageCount;
  const nextRevealCount = transcriptViewport.nextRevealCount;
  const hasServerEarlierMessages = transcriptViewport.hasServerEarlierMessages;
  const nearBottom = transcriptViewport.nearBottom;
  const stickToBottom = transcriptViewport.stickToBottom;
  const setStickToBottom = transcriptViewport.setStickToBottom;
  const initialAnchorPending = transcriptViewport.initialAnchorPending;
  const revealEarlierMessages = transcriptViewport.revealEarlierMessages;
  const scheduleScrollToLatest = transcriptViewport.scheduleScrollToLatest;
  const jumpToLatest = transcriptViewport.jumpToLatest;
  const showSessionLoadingState = createMemo(() =>
    !activeSessionSwitchHandoffActive() &&
    shouldShowSessionLoadingState({
      hasWorkspaceSetupEmptyState: showWorkspaceSetupEmptyState(),
      selectedSessionId: transcriptDisplaySessionId(),
      messageCount: displayedEffectiveMessages().length,
      loadingEarlierMessages: props.loadingEarlierMessages,
    })
  );
  const showComposerEntryState = createMemo(() =>
    displayedEffectiveMessages().length === 0 &&
    !composerEntryDismissed() &&
    !showWorkspaceSetupEmptyState() &&
    !activeSessionSwitchHandoffActive() &&
    !showSessionLoadingState(),
  );
  const showFooterComposerArea = createMemo(() =>
    !showWorkspaceSetupEmptyState() &&
    !showComposerEntryState() &&
    !showSessionLoadingState() &&
    !activeSessionSwitchHandoffActive(),
  );
  const showFooterComposerTargetContext = createMemo(() =>
    !props.selectedSessionId &&
    !composerEntryDismissed(),
  );
  createEffect(() => {
    if (!sessionUiDiagnosticEnabled()) return;
    const effectiveMessageCount = displayedEffectiveMessages().length;
    const workspaceSetupVisible = showWorkspaceSetupEmptyState();
    const composerEntryVisible = showComposerEntryState();
    const sessionLoadingVisible = showSessionLoadingState();
    setTempRuntimeUiRenderSource((current) => ({
      ...current,
      effectiveMessageCount,
      workspaceSetupVisible,
      composerEntryVisible,
      sessionLoadingVisible,
      at: Date.now(),
    }));
  });

  createEffect(() => {
    if (!props.developerMode) return;
    if (typeof window === "undefined") return;

    let expectedAt = perfNow() + MAIN_THREAD_LAG_INTERVAL_MS;
    const interval = setInterval(() => {
      const now = perfNow();
      const lagMs = Math.round((now - expectedAt) * 100) / 100;
      expectedAt = now + MAIN_THREAD_LAG_INTERVAL_MS;
      if (lagMs < MAIN_THREAD_LAG_WARN_MS) return;

      recordPerfLog(true, "session.main-thread", "lag", {
        lagMs,
        sessionID: props.selectedSessionId,
        status: props.sessionStatus,
        messageCount: props.messages.length,
        partCount: totalPartCount(),
        renderedMessageCount: displayedEffectiveMessages().length,
      });
    }, MAIN_THREAD_LAG_INTERVAL_MS);

    onCleanup(() => {
      window.clearInterval(interval);
    });
  });

  const canUndoLastMessage = createMemo(() => {
    if (!props.selectedSessionId) return false;
    const revert = props.sessionRevertMessageId;
    for (const message of props.messages) {
      const role = (message.info as { role?: string }).role;
      if (role !== "user") continue;
      const id = messageIdFromInfo(message);
      if (!id) continue;
      if (!revert || id < revert) return true;
    }
    return false;
  });

  const hasUserMessages = createMemo(() =>
    props.messages.some((message) => (message.info as { role?: string }).role === "user"),
  );

  const canRedoLastMessage = createMemo(() => {
    if (!props.selectedSessionId) return false;
    return Boolean(props.sessionRevertMessageId);
  });

  const canCompactSession = createMemo(() => Boolean(props.selectedSessionId) && hasUserMessages());

  const resolveLocalFileCandidates = async (file: string) => {
    const trimmed = normalizeLocalFilePath(file).trim();
    if (!trimmed) return [];
    if (isAbsolutePath(trimmed)) return [trimmed];

    const root = props.activeWorkspaceRoot.trim();
    if (!root) return [];

    const normalized = trimmed.replace(/[\\/]+/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    const candidates: string[] = [];
    const seen = new Set<string>();

    const pushCandidate = (value: string) => {
      const key = value.trim().replace(/[\\/]+/g, "/").toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      candidates.push(value);
    };

    pushCandidate(await join(root, normalized));

    if (normalized.startsWith(".opencode/veslo/outbox/")) {
      return candidates;
    }

    if (normalized.startsWith("veslo/outbox/")) {
      const suffix = normalized.slice("veslo/outbox/".length);
      if (suffix) {
        pushCandidate(await join(root, ".opencode", "veslo", "outbox", suffix));
      }
      return candidates;
    }

    if (normalized.startsWith("outbox/")) {
      const suffix = normalized.slice("outbox/".length);
      if (suffix) {
        pushCandidate(await join(root, ".opencode", "veslo", "outbox", suffix));
      }
      return candidates;
    }

    if (!normalized.startsWith(".opencode/")) {
      pushCandidate(await join(root, ".opencode", "veslo", "outbox", normalized));
    }

    return candidates;
  };

  const runLocalFileAction = async (
    file: string,
    mode: "open" | "reveal",
    action: (candidate: string) => Promise<void>,
  ) => {
    const candidates = await resolveLocalFileCandidates(file);
    if (!candidates.length) {
      return { ok: false as const, reason: "missing-root" as const };
    }

    let lastError: unknown = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const startedAt = perfNow();
      try {
        recordPerfLog(props.developerMode, "session.file-open", "attempt", {
          mode,
          input: file,
          target: candidate,
          candidateIndex: index,
          candidateCount: candidates.length,
        });
        await action(candidate);
        finishPerf(props.developerMode, "session.file-open", "success", startedAt, {
          mode,
          input: file,
          target: candidate,
          candidateIndex: index,
          candidateCount: candidates.length,
        });
        return { ok: true as const, path: candidate };
      } catch (error) {
        lastError = error;
        console.warn("[session.file-open] candidate failed", {
          mode,
          input: file,
          target: candidate,
          candidateIndex: index,
          candidateCount: candidates.length,
          error: error instanceof Error ? error.message : String(error),
        });
        finishPerf(props.developerMode, "session.file-open", "candidate-failed", startedAt, {
          mode,
          input: file,
          target: candidate,
          candidateIndex: index,
          candidateCount: candidates.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const suffix =
      candidates.length > 1
        ? ` (${t("session.file_open_tried_paths", currentLocale()).replace("{count}", String(candidates.length))})`
        : "";
    return {
      ok: false as const,
      reason: `${lastError instanceof Error ? lastError.message : t("session.file_open_failed", currentLocale())}${suffix}`,
    };
  };

  const revealArtifact = async (file: string) => {
    if (props.activeWorkspaceDisplay.workspaceType === "remote") {
      setToastMessage(tr("session.reveal_remote_unavailable"));
      return;
    }
    if (!isTauriRuntime()) {
      setToastMessage(tr("session.reveal_desktop_only"));
      return;
    }
    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      const result = await runLocalFileAction(file, "reveal", async (candidate) => {
        if (isWindowsPlatform()) {
          await openPath(candidate);
          return;
        }
        await revealItemInDir(candidate);
      });
      if (!result.ok && result.reason === "missing-root") {
        setToastMessage(tr("session.pick_worker_reveal_files"));
        return;
      }
      if (!result.ok) {
        setToastMessage(result.reason);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : tr("session.unable_reveal_file");
      setToastMessage(message);
    }
  };

  const revealWorkspaceInFinder = async (workspaceId: string) => {
    const workspace = props.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "local") return;
    const target = workspace.path?.trim() ?? "";
    if (!target) {
      setToastMessage(tr("session.workspace_path_unavailable"));
      return;
    }
    if (!isTauriRuntime()) {
      setToastMessage(tr("session.reveal_desktop_only"));
      return;
    }
    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      if (isWindowsPlatform()) {
        await openPath(target);
      } else {
        await revealItemInDir(target);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : tr("session.unable_reveal_workspace");
      setToastMessage(message);
    }
  };
  const todoLabel = createMemo(() => {
    const total = todoCount();
    if (!total) return "";
    return formatTr("session.tasks_completed", {
      completed: todoCompletedCount(),
      total,
    });
  });
  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(null);
  const attachmentsEnabled = createMemo(() => {
    return props.vesloServerStatus === "connected"
      && Boolean(props.vesloServerClient);
  });
  const attachmentsDisabledReason = createMemo(() => {
    if (attachmentsEnabled()) return null;
    if (props.vesloServerStatus === "limited") {
      return tr("session.add_server_token_to_attach");
    }
    return tr("session.connect_server_to_attach");
  });

  const isAbsolutePath = (value: string) =>
    /^(?:[a-zA-Z]:[\\/]|\\\\|\/|~\/)/.test(value.trim());

  const handleWorkingFileClick = async (file: string) => {
    const trimmed = file.trim();
    if (!trimmed) return;

    if (props.activeWorkspaceDisplay.workspaceType === "remote") {
      setToastMessage(tr("session.file_open_remote_unavailable"));
      return;
    }

    if (!isTauriRuntime()) {
      setToastMessage(tr("session.file_open_desktop_only"));
      return;
    }

    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      const result = await runLocalFileAction(trimmed, "open", async (candidate) => {
        await openPath(candidate);
      });
      if (!result.ok && result.reason === "missing-root") {
        setToastMessage(tr("session.pick_worker_open_files"));
        return;
      }
      if (!result.ok) {
        setToastMessage(result.reason);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : tr("session.unable_open_file");
      setToastMessage(message);
    }
  };

  type Flyout = {
    id: string;
    rect: { top: number; left: number; width: number; height: number };
    targetRect: { top: number; left: number; width: number; height: number };
    label: string;
    icon: "file" | "check" | "folder";
  };
  const [flyouts, setFlyouts] = createSignal<Flyout[]>([]);
  const [prevTodoCount, setPrevTodoCount] = createSignal(0);
  const [prevFileCount, setPrevFileCount] = createSignal(0);
  const [isInitialLoad, setIsInitialLoad] = createSignal(true);
  const [queuedDraftsBySessionKey, setQueuedDraftsBySessionKey] = createSignal<Record<string, QueuedDraft[]>>({});
  const [serverQueuedRuns, setServerQueuedRuns] = createSignal<ServerQueuedRunProjection[]>([]);
  const [queuePausedAfterStopBySessionKey, setQueuePausedAfterStopBySessionKey] = createSignal<Record<string, boolean>>({});
  const [editingQueuedDraftId, setEditingQueuedDraftId] = createSignal<string | null>(null);
  const [editingTranscriptMessageId, setEditingTranscriptMessageId] = createSignal<string | null>(null);
  const [abortBusy, setAbortBusy] = createSignal(false);
  const [escapeStopConfirmationPending, setEscapeStopConfirmationPending] = createSignal(false);
  const [todoExpanded, setTodoExpanded] = createSignal(false);
  let escapeStopConfirmationSessionId = untrack(() => props.selectedSessionId);

  const queuedDrafts = createMemo(() => queuedDraftsBySessionKey()[currentSessionQueueKey()] ?? []);
  const activeServerQueueVisibilityScope = createMemo(() => {
    const ref = props.activeUiConversationRef;
    return {
      workspaceId: resolveVesloWorkspaceId(ref?.workspaceId ?? props.activeWorkspaceId) ?? "",
      conversationId: ref?.conversationId?.trim() ?? "",
      opencodeSessionId: ref?.opencodeSessionId?.trim() || props.selectedSessionId?.trim() || "",
      uiConversationKey: ref?.key?.trim() || currentSessionQueueKey(),
    };
  });
  const activeServerQueueProjectionScope = (): ServerQueuedRunProjectionScope | null => {
    const scope = activeServerQueueVisibilityScope();
    if (!scope.workspaceId || !scope.conversationId || !scope.uiConversationKey) return null;
    return {
      workspaceId: scope.workspaceId,
      conversationId: scope.conversationId,
      uiConversationKey: scope.uiConversationKey,
    };
  };
  const visibleServerQueuedRuns = createMemo(() =>
    serverQueuedRunsForVisibleConversation(serverQueuedRuns(), activeServerQueueVisibilityScope()),
  );
  const queuePaused = createMemo(() => Boolean(queuePausedAfterStopBySessionKey()[currentSessionQueueKey()]));
  const queuePausedForSessionKey = (sessionKey: string) =>
    Boolean(queuePausedAfterStopBySessionKey()[sessionKey]);
  const emptyComposerDraft = (mode: ComposerDraft["mode"] = "prompt"): ComposerDraft => ({
    mode,
    parts: [],
    attachments: [],
    text: "",
    resolvedText: "",
  });

  const updateQueueForSessionKey = (sessionKey: string, updater: (queue: QueuedDraft[]) => QueuedDraft[]) => {
    setQueuedDraftsBySessionKey((current) => {
      const existing = current[sessionKey] ?? [];
      const next = updater(existing);
      if (next === existing) return current;
      return { ...current, [sessionKey]: next };
    });
  };

  const updateCurrentQueue = (updater: (queue: QueuedDraft[]) => QueuedDraft[]) => {
    updateQueueForSessionKey(currentSessionQueueKey(), updater);
  };

  const resolveQueueKeyForQueuedDraft = (originalSessionKey: string, draftId: string) => {
    return resolveQueuedDraftSessionKey(queuedDraftsBySessionKey(), originalSessionKey, draftId);
  };

  const setQueuePausedForSessionKey = (sessionKey: string, paused: boolean) => {
    setQueuePausedAfterStopBySessionKey((current) => {
      if (Boolean(current[sessionKey]) === paused) return current;
      return { ...current, [sessionKey]: paused };
    });
  };

  const setQueuePausedForCurrentSession = (paused: boolean) => {
    setQueuePausedForSessionKey(currentSessionQueueKey(), paused);
  };

  const remapPendingQueueToSession = (
    pendingKey: string,
    sessionId: string,
    sessionKeyOverride?: string | null,
  ) => {
    const sessionKey = sessionKeyOverride?.trim() || sessionQueueKeyForSessionId(sessionId);
    if (!pendingKey || pendingKey === sessionKey) return;

    setQueuedDraftsBySessionKey((current) =>
      remapPendingQueueToSessionRecord(current, pendingKey, sessionKey),
    );

    setQueuePausedAfterStopBySessionKey((current) =>
      remapQueuePausedToSession(current, pendingKey, sessionKey),
    );

    remapPendingRunStateToSession(pendingKey, sessionId, sessionKey);

    setPendingSubmittedDraftBySessionKey((current) => {
      // materializePendingSessionInstance preserves the former remapPendingSubmittedSession behavior for keyed drafts.
      return materializePendingSessionInstance(current, {
        pendingSessionKey: pendingKey,
        realSessionKey: sessionKey,
        realSessionId: sessionId,
      });
    });
  };

  const workspaceRootForPendingSidebarSession = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return "";
    const workspace = props.workspaces.find((entry) => entry.id === id) ?? null;
    return normalizeDirectoryPath(workspace?.directory?.trim() || workspace?.path?.trim() || "");
  };

  const createPendingSidebarSessionWorkspaceId = () => {
    const meta = props.activePendingDraftMeta;
    if (!meta) return props.activeWorkspaceId;
    const workspaceId =
      meta.kind === "new-private"
        ? (meta.privateWorkspaceId ?? meta.workspaceId).trim()
        : meta.workspaceId.trim();
    return workspaceId || props.activeWorkspaceId;
  };

  const createPendingSidebarSessionWorkspaceRoot = (workspaceId: string) => {
    const directory = normalizeDirectoryPath(props.activePendingDraftMeta?.directory ?? "");
    if (directory) return directory;
    return workspaceRootForPendingSidebarSession(workspaceId) || props.activeWorkspaceRoot;
  };

  const restoreMaterializedQueueToPending = (
    pendingKey: string,
    sessionId: string | null | undefined,
    sessionKeyOverride?: string | null,
  ) => {
    const materializedSessionId = sessionId?.trim();
    if (!pendingKey || !materializedSessionId) return;
    const sessionKey = sessionKeyOverride?.trim() || sessionQueueKeyForSessionId(materializedSessionId);
    if (pendingKey === sessionKey) return;

    setQueuedDraftsBySessionKey((current) =>
      restoreMaterializedQueueToPendingRecord(current, pendingKey, sessionKey),
    );

    setQueuePausedAfterStopBySessionKey((current) =>
      restoreQueuePausedToPending(current, pendingKey, sessionKey),
    );
  };

  const appendDraftToCurrentQueue = (draft: ComposerDraft, envelope: QueuedDraftEnvelope) => {
    updateCurrentQueue((queue) => appendQueuedDraft(queue, draft, envelope));
  };

  const isComposerDraftEmpty = (draft: ComposerDraft) => {
    const hasPartContent = draft.parts.some((part) => {
      if (part.type === "text") return part.text.trim().length > 0;
      return true;
    });
    return (
      draft.attachments.length === 0 &&
      !draft.text.trim() &&
      !(draft.resolvedText ?? "").trim() &&
      !hasPartContent
    );
  };

  const activeRunDiagnostic = createMemo(() => runDiagnosticForQueueKey(currentSessionQueueKey()));
  const formatNoProgressDuration = (seconds: number | null | undefined) => {
    const value = Math.max(0, Math.floor(seconds ?? 0));
    if (value >= 60) return `${Math.floor(value / 60)}m`;
    return `${value}s`;
  };
  const activeNoProgressSeconds = createMemo(() => {
    const diagnostic = activeRunDiagnostic();
    if (!diagnostic) return null;
    if (typeof diagnostic.noProgressSeconds === "number" && Number.isFinite(diagnostic.noProgressSeconds)) {
      return Math.max(0, Math.floor(diagnostic.noProgressSeconds));
    }
    if (typeof diagnostic.retrySince === "number" && Number.isFinite(diagnostic.retrySince)) {
      const tick = runTick() || Date.now();
      return Math.max(0, Math.floor((tick - diagnostic.retrySince) / 1000));
    }
    return null;
  });
  const formatLastProgressTime = (timestamp: number | null | undefined) => {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return null;
    return new Intl.DateTimeFormat(currentLocale(), {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  };
  const runDiagnosticLabel = createMemo(() => {
    const diagnostic = activeRunDiagnostic();
    if (diagnostic?.recoveryState === "exhausted") {
      return tr("session.run_observation_exhausted");
    }
    if (diagnostic?.waitReason !== "model_retry_no_output") return null;
    const time = formatNoProgressDuration(activeNoProgressSeconds());
    const lastProgress = formatLastProgressTime(diagnostic.lastUsefulProgressAt);
    if (lastProgress) {
      return diagnostic.status === "blocked"
        ? formatTr("session.run_model_retry_blocked_with_progress", { time, lastProgress })
        : formatTr("session.run_model_retry_no_output_with_progress", { time, lastProgress });
    }
    return diagnostic.status === "blocked"
      ? formatTr("session.run_model_retry_blocked", { time })
      : formatTr("session.run_model_retry_no_output", { time });
  });
  const runPresentation = createMemo(() => deriveSessionRunPresentation({
    hasSessionScope: Boolean(props.selectedSessionId?.trim()),
    engineStatus: props.sessionStatus,
    lifecycle: activeRunDiagnostic(),
    local: {
      started: runStartedAt() !== null,
      hasBegun: runHasBegun(),
      optimisticSending: optimisticSubmittedDraft()?.state === "sending",
      optimisticAccepted: optimisticSubmittedDraft()?.admission === "accepted",
      acceptedRunId: optimisticSubmittedDraft()?.acceptedRunId,
      acceptedClientMessageId: optimisticSubmittedDraft()?.acceptedClientMessageId,
      responseStarted: responseStarted(),
    },
  }));
  const hasAbortableBackendRun = createMemo(() => runPresentation().abortable);
  const runPhase = createMemo(() => runPresentation().phase);
  const showRunIndicator = createMemo(() => runPresentation().showIndicator);
  const recoveryNotice = createMemo(() => runPresentation().recoveryNotice ?? null);
  const recoveryBlockedComposer = createMemo(() => runPresentation().composerMode === "recovery-blocked");
  const showFooterRunIndicator = createMemo(() => showRunIndicator() || Boolean(recoveryNotice()));
  const sessionUiStateFieldNames = [
    "selectedSessionId",
    "activeWorkspaceId",
    "engineReady",
    "clientConnected",
    "sessionStatus",
    "messageCount",
    "effectiveMessageCount",
    "workspaceSetupVisible",
    "sessionLoadingVisible",
    "composerEntryVisible",
    "footerComposerVisible",
    "runIndicatorVisible",
    "runPhase",
    "responseStarted",
    "pendingDraftKey",
    "sessionSwitchHandoffActive",
    "loadingEarlierMessages",
    "appBusy",
    "composerBusy",
    "aiAccessLoading",
    "aiAccessLoadingWithoutMessages",
    "aiAccessBlockedReason",
    "visibleAiAccessBlockedReason",
  ] as const;
  createEffect(
    on(
      () =>
        [
          props.selectedSessionId?.trim() || null,
          props.activeWorkspaceId.trim(),
          props.engineReady !== false,
          props.clientConnected,
          props.sessionStatus,
          props.messages.length,
          displayedEffectiveMessages().length,
          showWorkspaceSetupEmptyState(),
          showSessionLoadingState(),
          showComposerEntryState(),
          showFooterComposerArea(),
          showRunIndicator(),
          runPhase(),
          responseStarted(),
          props.activePendingDraftKey,
          activeSessionSwitchHandoffActive(),
          props.loadingEarlierMessages,
          props.busy,
          composerBusy(),
          aiAccessLoading(),
          aiAccessLoadingWithoutMessages(),
          props.aiAccessBlockedReason,
          visibleAiAccessBlockedReason(),
        ] as const,
      (state, previous) => {
        if (!sessionUiMutationTraceEnabled()) return;
        const changedFields = previous
          ? sessionUiStateFieldNames.filter((_, index) => state[index] !== previous[index])
          : [...sessionUiStateFieldNames];
        if (previous && changedFields.length === 0) return;
        recordSendTrace("session-ui:state-change", {
          changedFields,
          selectedSessionId: state[0],
          activeWorkspaceId: state[1],
          engineReady: state[2],
          clientConnected: state[3],
          sessionStatus: state[4],
          messageCount: state[5],
          effectiveMessageCount: state[6],
          workspaceSetupVisible: state[7],
          sessionLoadingVisible: state[8],
          composerEntryVisible: state[9],
          footerComposerVisible: state[10],
          runIndicatorVisible: state[11],
          runPhase: state[12],
          responseStarted: state[13],
          pendingDraftKey: state[14],
          sessionSwitchHandoffActive: state[15],
          loadingEarlierMessages: state[16],
          appBusy: state[17],
          composerBusy: state[18],
          aiAccessLoading: state[19],
          aiAccessLoadingWithoutMessages: state[20],
          aiAccessBlockedReason: state[21],
          visibleAiAccessBlockedReason: state[22],
        });
      },
    ),
  );
  createEffect(() => {
    if (!sessionUiMutationTraceEnabled()) return;
    const root = sessionUiMutationRoot();
    if (!root || typeof MutationObserver === "undefined") return;

    let frame: number | undefined;
    let batchNumber = 0;
    let recordCount = 0;
    let childListCount = 0;
    let attributeCount = 0;
    let addedNodeCount = 0;
    let removedNodeCount = 0;
    const attributeNames = new Set<string>();
    const targets: string[] = [];
    const collect = (records: MutationRecord[]) => {
      for (const record of records) {
        recordCount += 1;
        if (record.type === "childList") {
          childListCount += 1;
          addedNodeCount += record.addedNodes.length;
          removedNodeCount += record.removedNodes.length;
        } else if (record.type === "attributes") {
          attributeCount += 1;
          if (record.attributeName) attributeNames.add(record.attributeName);
        }
        if (targets.length < 8) {
          const target = describeSessionUiMutationTarget(record.target);
          if (!targets.includes(target)) targets.push(target);
        }
      }
    };
    const flush = (phase: "animation-frame" | "cleanup") => {
      frame = undefined;
      if (!recordCount) return;
      const renderSource = untrack(tempRuntimeUiRenderSource);
      recordSendTrace("session-ui:dom-mutation-batch", {
        phase,
        batchNumber: (batchNumber += 1),
        recordCount,
        childListCount,
        attributeCount,
        addedNodeCount,
        removedNodeCount,
        attributeNames: [...attributeNames].sort(),
        targets: [...targets],
        latestUiMarker: renderSource.source,
        latestUiMarkerReason: renderSource.reason,
        latestUiMarkerKind: renderSource.markerKind,
        latestUiMarkerAt: renderSource.at,
        latestUiMarkerAgeMs: renderSource.at > 0 ? Math.max(0, Date.now() - renderSource.at) : null,
        selectedSessionId: renderSource.selectedSessionId,
        currentSessionQueueKey: renderSource.currentSessionQueueKey,
        messageCount: renderSource.messageCount,
        effectiveMessageCount: renderSource.effectiveMessageCount ?? null,
        engineReady: renderSource.engineReady,
        clientConnected: renderSource.clientConnected,
      });
      recordCount = 0;
      childListCount = 0;
      attributeCount = 0;
      addedNodeCount = 0;
      removedNodeCount = 0;
      attributeNames.clear();
      targets.length = 0;
    };
    const observer = new MutationObserver((records) => {
      collect(records);
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => flush("animation-frame"));
    });
    observer.observe(root, { attributes: true, childList: true, subtree: true });

    onCleanup(() => {
      collect(observer.takeRecords());
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      flush("cleanup");
    });
  });
  const retryAcceptedRunRecovery = () => {
    const sessionId = props.selectedSessionId?.trim() ?? "";
    const workspaceId = activeRunDiagnostic()?.workspaceId ?? null;
    if (!sessionId) return;
    props.retryAcceptedRunForSession(sessionId, workspaceId);
  };
  const retryTerminalTranscriptRecovery = () => {
    const sessionId = props.selectedSessionId?.trim() ?? "";
    const workspaceId = activeRunDiagnostic()?.workspaceId ?? null;
    if (!sessionId) return;
    props.retryTerminalTranscriptRecoveryForSession(sessionId, workspaceId);
  };
  const operationalError = createMemo(() => props.error?.trim() || null);
  createEffect(() => {
    const sessionId = props.selectedSessionId;
    if (sessionId === escapeStopConfirmationSessionId) return;
    escapeStopConfirmationSessionId = sessionId;
    setEscapeStopConfirmationPending(false);
  });
  createEffect(() => {
    if (!showRunIndicator() || abortBusy() || commandPaletteOpen() || searchOpen() || overlayOpenSide()) {
      setEscapeStopConfirmationPending(false);
    }
  });
  const workspaceSendWarmupActive = createMemo(() => {
    const submitted = optimisticSubmittedDraft();
    if (!submitted || submitted.state !== "sending") return false;
    if (props.engineReady !== false) return false;
    if (runHasBegun() || responseStarted()) return false;
    return true;
  });
  const createTranscriptEditableUserMessage = () => {
    const editableUserMessage = createMemo(() =>
      getEditableUserMessageDraft({
        messages: props.messages,
        sessionIdle: !showRunIndicator(),
        queueEmpty: queuedDrafts().length === 0,
        composerEmpty: isComposerDraftEmpty(props.composerDraft),
      }),
    );
    return editableUserMessage;
  };
  const transcriptEditableUserMessage = createTranscriptEditableUserMessage();
  const editableUserMessage = createMemo(() => {
    const submitted = optimisticSubmittedDraft();
    const sessionIdle = !showRunIndicator();
    const queueEmpty = queuedDrafts().length === 0;
    const composerEmpty = isComposerDraftEmpty(props.composerDraft);
    if (
      submitted?.sessionKey === currentSessionQueueKey() &&
      sessionIdle &&
      queueEmpty &&
      composerEmpty
    ) {
      const editable = pendingSubmittedDraftToEditable(submitted);
      if (editable) return editable;
    }
    return transcriptEditableUserMessage();
  });

  const latestRunPart = createMemo<Part | null>(() => {
    if (!showRunIndicator()) return null;
    const baseline = runBaseline();
    const lastVisiblePart = (parts: Part[]): Part | null => {
      for (let j = parts.length - 1; j >= 0; j--) {
        if (isUserVisiblePart(parts[j])) return parts[j];
      }
      return null;
    };
    for (let i = props.messages.length - 1; i >= 0; i -= 1) {
      const msg = props.messages[i];
      const info = msg?.info as { id?: string | number; role?: string } | undefined;
      if (info?.role !== "assistant") continue;
      const messageId =
        typeof info.id === "string" ? info.id : typeof info.id === "number" ? String(info.id) : null;
      if (!messageId) continue;
      if (baseline.assistantId && messageId === baseline.assistantId) {
        if (msg.parts.length <= baseline.partCount) {
          return null;
        }
        return lastVisiblePart(msg.parts);
      }
      if (!msg.parts.length) continue;
      return lastVisiblePart(msg.parts);
    }
    return null;
  });

  const cleanReasoning = (value: string) =>
    value
      .replace(/\[REDACTED\]/g, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();

  const computeStatusFromPart = (part: Part | null) => {
    if (!part) return null;
    if (part.type === "tool") {
      const tool = toolNameFromPart(part);
      switch (tool) {
        case "task":
          return tr("session.status_delegating");
        case "todowrite":
        case "todoread":
          return tr("session.status_planning");
        case "read":
          return tr("session.status_gathering_context");
        case "list":
        case "grep":
        case "glob":
          return tr("session.status_searching_codebase");
        case "webfetch":
          return tr("session.status_searching_web");
        case "edit":
        case "write":
        case "apply_patch":
          return tr("session.status_writing_file");
        case "bash":
          return tr("session.status_running_shell");
        default:
          return tr("session.status_working");
      }
    }
    if (part.type === "reasoning") {
      const text = cleanReasoning(partText(part));
      const first = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (first) {
        const clipped = first.length > 56 ? `${first.slice(0, 53)}...` : first;
        return formatTr("session.status_thinking_prefix", { text: clipped });
      }
      return tr("session.status_thinking");
    }
    if (part.type === "text") {
      return tr("session.status_gathering_thoughts");
    }
    return null;
  };

  const thinkingStatus = createMemo(() => {
    const status = computeStatusFromPart(latestRunPart());
    if (status) return status;
    if (runPhase() === "thinking") return tr("session.status_thinking");
    return null;
  });

  const runProgressSignature = createMemo(() => {
    if (!showRunIndicator()) return "";
    const part = latestRunPart();
    const partTotal = totalPartCount();
    if (!part) {
      return `messages:${props.messages.length}:parts:${partTotal}:todos:${props.todos.length}`;
    }

    if (part.type === "reasoning" || part.type === "text") {
      const text = partText(part);
      return `${part.type}:${text.length}:${text.slice(-48)}:parts:${partTotal}:todos:${props.todos.length}`;
    }

    if (part.type === "tool") {
      const state = toolStateFromPart(part);
      const status = typeof state.status === "string" ? state.status : "";
      const outputSize = toolOutputSizeFromPart(part);
      return `tool:${status}:${outputSize}:parts:${partTotal}:todos:${props.todos.length}`;
    }

    return `${part.type}:parts:${partTotal}:todos:${props.todos.length}`;
  });

  const runLabel = createMemo(() => {
    switch (runPhase()) {
      case "sending":
        return tr("session.run_sending");
      case "retrying":
        return tr("session.run_retrying");
      case "responding":
        return workspaceSendWarmupActive() ? tr("session.run_loading") : tr("session.run_responding");
      case "thinking":
        return tr("session.run_thinking");
      case "error":
        return tr("session.run_failed");
      default:
        return "";
    }
  });

  const runElapsedMs = createMemo(() => {
    const start = runStartedAt();
    if (!start) return 0;
    return Math.max(0, runTick() - start);
  });

  const runElapsedLabel = createMemo(() => formatRunElapsedDuration(runElapsedMs()));

  onMount(() => {
    setTimeout(() => setIsInitialLoad(false), 2000);
  });

  createEffect(() => {
    const active = activeSearchHit();
    if (!active) return;
    if (scrollMessageIntoViewById?.(active.messageId, "smooth")) return;
    const container = chatContainerEl;
    if (!container) return;
    const escapedId = active.messageId.replace(/"/g, '\\"');
    const target = container.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    const idx = commandPaletteActiveIndex();
    requestAnimationFrame(() => {
      commandPaletteOptionRefs[idx]?.scrollIntoView({ block: "nearest" });
    });
  });

  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const searchCommandShortcut = resolveSessionSearchCommandShortcut({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        commandPaletteOpen: commandPaletteOpen(),
        searchOpen: searchOpen(),
        commandPaletteMode: commandPaletteMode(),
        commandPaletteQuery: commandPaletteQuery(),
        isComposing: event.isComposing,
        keyCode: event.keyCode,
      });
      if (searchCommand.handleShortcutAction(searchCommandShortcut)) {
        event.preventDefault();
        return;
      }

      if (overlayOpenSide()) return;

      const escapeStopAction = resolveEscapeStopShortcut({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        commandPaletteOpen: commandPaletteOpen(),
        searchOpen: searchOpen(),
        showRunIndicator: showRunIndicator(),
        abortBusy: abortBusy(),
        confirmationPending: escapeStopConfirmationPending(),
      });
      if (escapeStopAction !== "ignore") {
        event.preventDefault();
        if (escapeStopAction === "request-confirmation") {
          setEscapeStopConfirmationPending(true);
          return;
        }
        setEscapeStopConfirmationPending(false);
        void cancelRun();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  createEffect(() => {
    const status = props.sessionStatus;
    const diagnostic = activeRunDiagnostic();
    if (status === "running" || status === "retry" || diagnostic?.waitReason === "model_retry_no_output") {
      const sessionKey = currentSessionQueueKey();
      startRun(sessionKey);
      setRunHasBegunForSessionKey(sessionKey, true);
    }
  });

  createEffect(
    on(
      () => props.sessionStatusById,
      (statuses, previousStatuses) => {
        if (!previousStatuses) return;
        for (const [sessionKey, runState] of Object.entries(untrack(runStateBySessionKey))) {
          if (!runState.startedAt && !runState.hasBegun) continue;
          const sessionId = sessionIdForQueueKey(sessionKey);
          if (!sessionId) continue;
          const previousStatus = statusForQueueKey(sessionKey, previousStatuses);
          const status = statusForQueueKey(sessionKey, statuses);
          if (!isActiveRunStatus(previousStatus) || isActiveRunStatus(status)) continue;
          if (lifecycleKeepsRunPresentationActive(runDiagnosticForQueueKey(sessionKey))) continue;
          resetRunState(sessionKey, "session-status-idle");
        }
      },
    ),
  );

  createEffect(() => {
    if (responseStarted()) {
      setRunHasBegunForSessionKey(currentSessionQueueKey(), true);
    }
  });

  createEffect(() => {
    if (!editingTranscriptMessageId()) return;
    if (!isComposerDraftEmpty(props.composerDraft)) return;
    setEditingTranscriptMessageId(null);
  });

  createEffect(() => {
    if (!runStartedAt()) return;
    if (lifecycleKeepsRunPresentationActive(activeRunDiagnostic())) return;
    if (props.sessionStatus === "idle" && (runHasBegun() || responseStarted())) {
      resetRunState(currentSessionQueueKey(), "active-session-idle");
    }
  });

  // Safety net: if the server reports idle but neither runHasBegun nor
  // responseStarted ever flipped (e.g. "running" + "idle" SSE events
  // arrived in the same SolidJS batch so effects only saw the final "idle"),
  // force-reset after a short grace period.
  createEffect(() => {
    if (!runStartedAt()) return;
    if (props.sessionStatus !== "idle") return;
    if (optimisticSubmittedDraft()?.state === "sending") return;
    if (runHasBegun() || responseStarted()) return;
    if (lifecycleKeepsRunPresentationActive(activeRunDiagnostic())) return;
    const timer = setTimeout(() => {
      if (
        runStartedAt() &&
        props.sessionStatus === "idle" &&
        optimisticSubmittedDraft()?.state !== "sending" &&
        !runHasBegun() &&
        !responseStarted() &&
        !lifecycleKeepsRunPresentationActive(activeRunDiagnostic())
      ) {
        resetRunState(currentSessionQueueKey(), "idle-grace-expired");
      }
    }, 2_000);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    if (!showRunIndicator()) return;
    const sessionKey = currentSessionQueueKey();
    setRunTickForSessionKey(sessionKey, Date.now());
    const id = window.setInterval(() => setRunTickForSessionKey(sessionKey, Date.now()), 50);
    onCleanup(() => window.clearInterval(id));
  });

  createEffect(() => {
    if (!showRunIndicator()) return;
    runProgressSignature();
    if (!shouldAutoScrollForRunProgress({
      showRunIndicator: showRunIndicator(),
      initialAnchorPending: initialAnchorPending(),
      stickToBottom: stickToBottom(),
    })) return;
    scheduleScrollToLatest("auto");
  });

  createEffect(
    on(
      () => [
        props.messages.length,
        props.todos.length,
        totalPartCount(),
      ],
      (current, previous) => {
        if (!previous) return;
        const [mLen, tLen, pCount] = current;
        const [prevM, prevT, prevP] = previous;
        const currentCounts = { messages: mLen, todos: tLen, parts: pCount };
        const previousCounts = { messages: prevM, todos: prevT, parts: prevP };
        if (
          shouldAutoScrollForTranscriptGrowth({
            current: currentCounts,
            previous: previousCounts,
            initialAnchorPending: initialAnchorPending(),
            stickToBottom: stickToBottom(),
          })
        ) {
          scheduleScrollToLatest("auto");
        }
        if (mLen > prevM || tLen > prevT || pCount > prevP) {
          if (showRunIndicator()) {
            setRunLastProgressAtForSessionKey(currentSessionQueueKey(), Date.now());
          }
        }
      },
    ),
  );

  const runStallMs = createMemo(() => {
    if (!showRunIndicator()) return 0;
    if (runPhase() === "error") return 0;
    const last = runLastProgressAt() ?? runStartedAt() ?? Date.now();
    return Math.max(0, runTick() - last);
  });

  const stallThresholds = createMemo(() => {
    // Keep these thresholds user-friendly:
    // - "Still working" should appear quickly enough to reassure, but not so quickly it feels noisy.
    // - "Taking longer than usual" should appear late enough to avoid false alarms.
    const phase = runPhase();
    if (phase === "sending" || phase === "retrying") {
      return { softMs: 8_000, hardMs: 20_000 };
    }
    if (phase === "thinking") {
      return { softMs: 25_000, hardMs: 70_000 };
    }
    if (phase === "responding") {
      return { softMs: 25_000, hardMs: 90_000 };
    }
    return { softMs: 0, hardMs: 0 };
  });

  const stallStage = createMemo<"none" | "soft" | "hard">(() => {
    if (!showRunIndicator()) return "none";
    if (runPhase() === "error") return "none";
    const ms = runStallMs();
    const { softMs, hardMs } = stallThresholds();
    if (!softMs || !hardMs) return "none";
    if (ms >= hardMs) return "hard";
    if (ms >= softMs) return "soft";
    return "none";
  });

  let lastStallPerfStage: "none" | "soft" | "hard" = "none";
  createEffect(() => {
    if (!props.developerMode) {
      lastStallPerfStage = "none";
      return;
    }

    const stage = stallStage();
    if (stage === lastStallPerfStage) return;

    const previous = lastStallPerfStage;
    lastStallPerfStage = stage;

    if (stage === "none") {
      if (previous !== "none") {
        recordPerfLog(true, "session.run", "stall-recovered", {
          sessionID: props.selectedSessionId,
          phase: runPhase(),
          elapsedMs: runElapsedMs(),
          messageCount: props.messages.length,
          partCount: totalPartCount(),
        });
      }
      return;
    }

    recordPerfLog(true, "session.run", stage === "soft" ? "stall-soft" : "stall-hard", {
      sessionID: props.selectedSessionId,
      phase: runPhase(),
      stallMs: runStallMs(),
      elapsedMs: runElapsedMs(),
      messageCount: props.messages.length,
      renderedMessageCount: renderedMessages().length,
      hiddenMessageCount: hiddenMessageCount(),
      partCount: totalPartCount(),
    });
  });

  const cancelRun = async () => {
    await sessionFlowFacade.cancelRun();
  };

  const retryRun = async () => {
    await sessionFlowFacade.retryRun();
  };

  const focusSearchInput = () => {
    queueMicrotask(() => {
      searchInputEl?.focus();
      searchInputEl?.select();
    });
  };

  const focusCommandPaletteInput = () => {
    queueMicrotask(() => {
      commandPaletteInputEl?.focus();
      commandPaletteInputEl?.select();
    });
  };

  const undoLastMessage = async () => {
    if (historyActionBusy()) return;
    if (!canUndoLastMessage()) {
      setToastMessage(tr("session.nothing_to_undo"));
      return;
    }

    setHistoryActionBusy("undo");
    try {
      await props.undoLastUserMessage();
      setToastMessage(tr("session.undo_success"));
    } catch (error) {
      const message = error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || tr("session.failed_to_undo"));
    } finally {
      setHistoryActionBusy(null);
    }
  };

  const redoLastMessage = async () => {
    if (historyActionBusy()) return;
    if (!canRedoLastMessage()) {
      setToastMessage(tr("session.nothing_to_redo"));
      return;
    }

    setHistoryActionBusy("redo");
    try {
      await props.redoLastUserMessage();
      setToastMessage(tr("session.redo_success"));
    } catch (error) {
      const message = error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || tr("session.failed_to_redo"));
    } finally {
      setHistoryActionBusy(null);
    }
  };

  const compactSessionHistory = async () => {
    if (historyActionBusy()) return;
    if (!canCompactSession()) {
      setToastMessage(tr("session.nothing_to_compact"));
      return;
    }

    const sessionID = props.selectedSessionId;
    const startedAt = perfNow();
    setHistoryActionBusy("compact");
    setToastMessage(tr("session.compacting"));
    try {
      await props.compactSession();
      setToastMessage(tr("session.compact_success"));
      finishPerf(props.developerMode, "session.compact", "ui-done", startedAt, {
        sessionID,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || tr("session.failed_to_compact"));
      finishPerf(props.developerMode, "session.compact", "ui-error", startedAt, {
        sessionID,
        error: message,
      });
    } finally {
      setHistoryActionBusy(null);
    }
  };


  const triggerFlyout = (
    sourceEl: Element | null,
    targetId: string,
    label: string,
    icon: Flyout["icon"]
  ) => {
    if (isInitialLoad() || !sourceEl) return;
    const targetEl = document.getElementById(targetId);
    if (!targetEl) return;

    const rect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    const id = Math.random().toString(36);
    setFlyouts((prev) => [
      ...prev,
      {
        id,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        targetRect: { top: targetRect.top, left: targetRect.left, width: targetRect.width, height: targetRect.height },
        label,
        icon,
      },
    ]);

    setTimeout(() => {
      setFlyouts((prev) => prev.filter((f) => f.id !== id));
    }, 1000);
  };

  createEffect(() => {
    const count = todoCount();
    const prev = prevTodoCount();
    if (count > prev && prev > 0) {
      const lastMsg = chatContainerEl?.querySelector('[data-message-role="assistant"]:last-child');
      triggerFlyout(lastMsg ?? null, "sidebar-progress", tr("session.new_task_flyout"), "check");
    }
    setPrevTodoCount(count);
  });

  createEffect(() => {
    const files = props.workingFiles;
    const count = files.length;
    const prev = prevFileCount();
    if (count > prev && prev > 0) {
      const lastMsg = chatContainerEl?.querySelector('[data-message-role="assistant"]:last-child');
      triggerFlyout(lastMsg ?? null, "sidebar-context", tr("session.file_modified_flyout"), "folder");
    }
    setPrevFileCount(count);
  });

  createEffect(() => {
    const reconnectNotice = props.reconnectNotice;
    if (!reconnectNotice) return;
    setToastMessage(
      reconnectNotice === "reconnecting"
        ? tr("session.reconnecting_toast")
        : tr("session.reconnected_toast"),
    );
    props.clearReconnectNotice();
  });

  createEffect(() => {
    if (!toastMessage()) return;
    const id = window.setTimeout(() => setToastMessage(null), SESSION_TOAST_DISMISS_DELAY_MS);
    return () => window.clearTimeout(id);
  });

  const sessionTitleById = (sessionId: string | null | undefined) => {
    const id = (sessionId ?? "").trim();
    if (!id) return "";
    if (id === (props.selectedSessionId?.trim() ?? "")) {
      return selectedSessionTitle();
    }
    for (const group of props.workspaceSessionGroups) {
      const match = group.sessions.find((session) => session.id === id);
      if (match) return match.title ?? "";
    }
    return "";
  };

  const sessionTitleByWorkspaceAndId = (workspaceId: string | null | undefined, sessionId: string | null | undefined) => {
    const targetWorkspaceId = (workspaceId ?? "").trim();
    const id = (sessionId ?? "").trim();
    if (!id) return "";
    const group = props.workspaceSessionGroups.find((candidate) => candidate.workspace.id === targetWorkspaceId);
    const match = group?.sessions.find((session) => session.id === id);
    return match?.title ?? sessionTitleById(id);
  };

  const deleteSessionTargetId = createMemo(() => deleteSessionTarget()?.sessionId ?? props.selectedSessionId ?? null);
  const deleteSessionTargetTitle = createMemo(() => sessionTitleById(deleteSessionTargetId()));

  const renameCanSave = createMemo(() => {
    if (renameBusy()) return false;
    const next = renameTitle().trim();
    if (!next) return false;
    if (renameTargetSessionId()) return true;
    return next !== selectedSessionTitle().trim();
  });

  const openRenameModal = () => {
    setSessionMenuOpen(false);
    setRenameTargetSessionId(null);
    if (!props.selectedSessionId) {
      setToastMessage(tr("session.no_session_selected_toast"));
      return;
    }
    setRenameTitle(selectedSessionTitle());
    setRenameModalOpen(true);
  };

  const openRenameModalFor = (workspaceId: string, sessionId: string) => {
    const id = sessionId.trim();
    if (!id) {
      setToastMessage(tr("session.no_session_selected_toast"));
      return;
    }
    setSessionMenuOpen(false);
    setRenameTitle(sessionTitleByWorkspaceAndId(workspaceId, id));
    setRenameTargetSessionId(id);
    setRenameModalOpen(true);
  };

  const closeRenameModal = () => {
    if (renameBusy()) return;
    setRenameModalOpen(false);
    setRenameTargetSessionId(null);
  };

  const submitRename = async () => {
    const sessionId = renameTargetSessionId() ?? props.selectedSessionId;
    if (!sessionId) return;
    const next = renameTitle().trim();
    if (!next || !renameCanSave()) return;
    setRenameBusy(true);
    try {
      await props.renameSession(sessionId, next);
      setRenameModalOpen(false);
      setRenameTargetSessionId(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message);
    } finally {
      setRenameBusy(false);
    }
  };

  const chooseFolderForSession = async () => {
    setSessionMenuOpen(false);
    if (!props.selectedSessionId) {
      setToastMessage(tr("session.no_session_selected_toast"));
      return;
    }
    try {
      const moved = await props.chooseFolderForCurrentSession();
      if (moved) {
        setToastMessage(tr("session.folder_selected_continue"));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || tr("session.failed_choose_folder"));
    }
  };

  const openDeleteSessionModalForTarget = (workspaceId: string | null | undefined, sessionId: string | null | undefined) => {
    setSessionMenuOpen(false);
    const id = (sessionId ?? "").trim();
    if (!id) {
      setToastMessage(tr("session.no_session_selected_toast"));
      return;
    }
    const targetWorkspaceId = (workspaceId ?? "").trim() || null;
    setDeleteSessionTarget({ sessionId: id, workspaceId: targetWorkspaceId });
    setDeleteSessionOpen(true);
  };

  const openDeleteSessionModal = () => {
    openDeleteSessionModalForTarget(props.activeWorkspaceId, props.selectedSessionId);
  };

  const openDeleteSessionModalForSession = (workspaceId: string, sessionId: string) => {
    openDeleteSessionModalForTarget(workspaceId, sessionId);
  };

  const closeDeleteSessionModal = () => {
    if (deleteSessionBusy()) return;
    setDeleteSessionOpen(false);
    setDeleteSessionTarget(null);
  };

  const confirmDeleteSession = async () => {
    if (deleteSessionBusy()) return;
    const sessionId = (deleteSessionTarget()?.sessionId ?? props.selectedSessionId ?? "").trim();
    if (!sessionId) return;
    const workspaceId = deleteSessionTarget()?.workspaceId ?? props.activeWorkspaceId;
    const wasSelectedSession = props.selectedSessionId === sessionId;
    setDeleteSessionBusy(true);
    try {
      await props.deleteSession(sessionId, workspaceId || undefined);
      setDeleteSessionOpen(false);
      setDeleteSessionTarget(null);
      setToastMessage(tr("session.delete_success"));
      if (wasSelectedSession) {
        // Route away from the deleted session id.
        props.setView("session");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : props.safeStringify(error);
      setToastMessage(message || tr("session.failed_delete"));
    } finally {
      setDeleteSessionBusy(false);
    }
  };

  const requireSessionId = () => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) {
      setToastMessage(tr("session.no_session_selected_toast"));
      return null;
    }
    return sessionId;
  };

  const applySessionAgent = async (agent: string | null) => {
    let sessionId = props.selectedSessionId;
    if (!sessionId) {
      // Auto-create a session when none is selected (same pattern as sendPrompt)
      sessionId = (await props.createSessionAndOpen()) ?? null;
      if (!sessionId) return;
    }
    props.setSessionAgent(sessionId, agent);
  };

  createEffect(() => {
    if (!sessionMenuOpen()) return;
    const handler = (event: MouseEvent) => {
      if (!sessionMenuRef) return;
      if (sessionMenuRef.contains(event.target as Node)) return;
      setSessionMenuOpen(false);
    };
    window.addEventListener("mousedown", handler);
    onCleanup(() => window.removeEventListener("mousedown", handler));
  });

  const shareController = createWorkspaceShareController({
    shareWorkspaceId,
    workspaces: () => props.workspaces,
    workspaceLabel,
    t: tr,
    serverHostInfo: () => props.vesloServerHostInfo,
    serverSettings: () => props.vesloServerSettings,
    engineRuntime: () => props.engineInfo?.runtime ?? null,
    isDesktopRuntime: () => isTauriRuntime(),
    exportWorkspaceBusy: () => props.exportWorkspaceBusy,
    remoteTokenMissingPlaceholder: () => tr("share.set_token_in_workspace_settings"),
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

  const conversationFlow = createSessionConversationFlow({
    identity: {
      createClientMessageId: createSessionClientMessageId,
      createPendingSessionInstanceId,
      now: () => Date.now(),
    },
    sessionKeys: {
      activeUiConversationWorkspaceId,
      activeWorkspaceId: () => props.activeWorkspaceId,
      currentSessionQueueKey,
      pendingSessionQueueKey,
      selectedSessionId: () => props.selectedSessionId,
      sessionIdForQueueKey,
      sessionQueueKeyForSessionId,
      workspaceIdForQueueKey,
    },
    runtime: {
      activePendingDraftKey: () => props.activePendingDraftKey ?? null,
      aiAccessBlockedReason: () => props.aiAccessBlockedReason,
      busyHint: () => props.busyHint ?? null,
      busyLabel: () => props.busyLabel ?? null,
      error: () => props.error ?? null,
    },
    transcript: {
      messageCount: () => props.messages.length,
      messageIds: () => props.messages.map(messageIdFromInfo).filter(Boolean),
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey,
      createPendingSidebarSessionWorkspaceId,
      createPendingSidebarSessionWorkspaceRoot,
      remapPendingQueueToSession,
      restoreMaterializedQueueToPending,
      setPendingQueueKeyAwaitingSessionIdForBaseKey,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft,
      setOptimisticSubmittedDraft,
      updatePendingSubmittedDrafts: setPendingSubmittedDraftBySessionKey,
      pendingSubmittedDrafts: pendingSubmittedDraftBySessionKey,
    },
    queue: {
      appendDraftToCurrentQueue,
      editingQueuedDraftId,
      queuePaused,
      queuedDrafts,
      queuedDraftsBySessionKey,
      queuePausedForSessionKey,
      resolveQueueKeyForQueuedDraft,
      setEditingQueuedDraftId,
      setQueuePausedForSessionKey,
      updateCurrentQueue,
      updateQueueForSessionKey,
    },
    composer: {
      clearComposerDraftForSession: (sessionId) => props.clearComposerDraftForSession(sessionId),
      currentDraftMode: () => props.composerDraft.mode,
      setComposerDraft: (draft) => props.setComposerDraft(draft),
    },
    transcriptEdit: {
      editableUserMessage,
      editingTranscriptMessageId,
      setEditingTranscriptMessageId,
    },
    runControl: {
      abortBusy,
      abortSession: (sessionId) => props.abortSession(sessionId),
      lastPromptSent: () => props.lastPromptSent,
      retryLastPrompt: () => props.retryLastPrompt(),
      runPhase,
      hasAbortableBackendRun,
      setAbortBusy,
      setEscapeStopConfirmationPending,
    },
    runState: {
      resetRunState,
      showRunIndicator,
      startRun,
    },
    sessionStatus: {
      statusForQueueKey,
      statusForSessionId,
    },
    viewport: {
      scheduleScrollToLatest,
      setStickToBottom,
    },
    transport: {
      replaceUserMessageAsync: (messageId, draft, options) =>
        props.replaceUserMessageAsync(messageId, draft, options),
      sendPromptAsync: async (draft, options) => {
        const uiConversationKey = currentSessionQueueKey();
        const result = await props.sendPromptAsync(draft, options);
        const workspaceId = result.workspaceId?.trim() ?? "";
        const conversationId = result.conversationId?.trim() ?? "";
        const opencodeSessionId = result.opencodeSessionId?.trim() ?? "";
        const queueItemId = result.queueItemId?.trim() ?? "";
        const reservedRunId = result.reservedRunId?.trim() ?? "";
        if (
          result.status === "queued" &&
          workspaceId &&
          conversationId &&
          opencodeSessionId &&
          queueItemId &&
          reservedRunId
        ) {
          const now = Date.now();
          setServerQueuedRuns((current) =>
            upsertServerQueuedRunProjection(current, {
              workspaceId,
              conversationId,
              opencodeSessionId,
              queueItemId,
              reservedRunId,
              clientMessageId: result.clientMessageId?.trim() || null,
              kind: draft.mode === "shell" ? "shell" : "prompt_async",
              status: "pending",
              queuePosition: result.queuePosition ?? null,
              order: { createdAt: now, queueItemId },
              createdAt: now,
              updatedAt: now,
              startedAt: null,
              completedAt: null,
              error: null,
            }, uiConversationKey),
          );
          requestServerQueueProjectionRefresh({ workspaceId, conversationId, uiConversationKey });
        }
        return result;
      },
    },
    feedback: {
      setToastMessage,
      tr,
    },
    trace: {
      markTempRuntimeUiRenderSource,
      recordSendTrace,
      reportError,
    },
    effects: {
      batch,
    },
  });
  const sessionFlowFacade = createSessionViewFlowFacade({ conversationFlow });
  createSessionQueueDrainController({
    selectedSessionId: () => props.selectedSessionId,
    sessionStatus: () => props.sessionStatus,
    sessionStatusById: () => props.sessionStatusById,
    pendingSessionQueueKey,
    pendingQueueKeyAwaitingSessionIdByBaseKey,
    sessionQueueKeyForSessionId,
    preserveRunStateOnSessionSwitch,
    setSearchQuery,
    closeSearch,
    markSelectedSessionForInitialAnchor: (sessionId) =>
      transcriptViewport.markSelectedSessionForInitialAnchor(sessionId),
    markTempRuntimeUiRenderSource,
    handleSelectedSessionChanged: (input) => {
      const selectedSessionId = input.sessionId?.trim() || null;
      if (
        selectedSessionId &&
        input.pendingKey &&
        pendingSubmittedDraftBySessionKey()[input.pendingKey]?.state === "sending"
      ) {
        setMaterializedSubmitDisplayHoldSessionId(selectedSessionId);
      }
      const flowResult = sessionFlowFacade.handleSelectedSessionChanged(input);
      if (flowResult.materializedPendingSubmit && flowResult.selectedSessionId) {
        setMaterializedSubmitDisplayHoldSessionId(flowResult.selectedSessionId);
      }
      return flowResult;
    },
    handleActiveSessionStatusChanged: (status, previousStatus) =>
      sessionFlowFacade.handleActiveSessionStatusChanged(status, previousStatus),
    handleSessionStatusMapChanged: (statuses, previousStatuses) =>
      sessionFlowFacade.handleSessionStatusMapChanged(statuses, previousStatuses),
  }).start();

  const handleEditQueuedDraft = (id: string) => {
    sessionFlowFacade.handleEditQueuedDraft(id);
  };

  const handleCancelQueuedDraft = (id: string) => {
    sessionFlowFacade.handleCancelQueuedDraft(id);
  };

  const handleRetryQueuedDraft = (id: string) => {
    sessionFlowFacade.handleRetryQueuedDraft(id);
  };

  const handleMoveQueuedDraft = (id: string, targetIndex: number) => {
    sessionFlowFacade.handleMoveQueuedDraft(id, targetIndex);
  };

  const handleEditUserMessage = (editable: EditableUserMessageDraft) => {
    sessionFlowFacade.handleEditUserMessage(editable);
  };

  const handleSendPrompt = async (draft: ComposerDraft, options: ComposerSendOptions = {}): Promise<ComposerSendResult> => {
    const submissionSessionKey = currentSessionQueueKey();
    recordSendTrace("handleSendPrompt:start", {
      sendTraceId: options.sendTraceId ?? null,
      sendNow: options.sendNow,
      source: options.source,
      sessionKey: submissionSessionKey,
      editingQueuedDraftId: editingQueuedDraftId(),
      queuePaused: queuePaused(),
      showRunIndicator: showRunIndicator(),
    });
    if (showComposerEntryState() || showFooterComposerTargetContext()) {
      dismissComposerEntryForSessionKey(submissionSessionKey);
    }
    const result = await sessionFlowFacade.handleSendPrompt(draft, {
      sendNow: options.sendNow,
      sendTraceId: options.sendTraceId,
      source: options.source,
      implicitSkillCommandPolicy: options.implicitSkillCommandPolicy,
      onDraftTransferred: options.onDraftTransferred,
    });
    if (sessionSubmitNeedsImplicitSkillConfirmation(result)) {
      setImplicitSkillConfirmationBySessionKey((current) => ({
        ...current,
        [submissionSessionKey]: {
          sessionKey: submissionSessionKey,
          draft: snapshotImplicitSkillConfirmationDraft(draft),
          options: { ...options },
          skillName: result.confirmation.skillName,
          arguments: result.confirmation.arguments,
        },
      }));
    }
    return result;
  };

  const removeImplicitSkillConfirmation = (pending: ImplicitSkillConfirmationRequest) => {
    setImplicitSkillConfirmationBySessionKey((current) => {
      if (current[pending.sessionKey] !== pending) return current;
      const { [pending.sessionKey]: _removed, ...rest } = current;
      return rest;
    });
  };

  const sendImplicitSkillAsPrompt = async () => {
    const pending = implicitSkillConfirmation();
    if (!pending) return;
    if (pending.sessionKey !== currentSessionQueueKey()) return;
    removeImplicitSkillConfirmation(pending);
    await handleSendPrompt(pending.draft, {
      ...pending.options,
      implicitSkillCommandPolicy: "disable",
    });
  };

  const runImplicitSkillCommand = async () => {
    const pending = implicitSkillConfirmation();
    if (!pending) return;
    if (pending.sessionKey !== currentSessionQueueKey()) return;
    removeImplicitSkillConfirmation(pending);
    await handleSendPrompt({
      ...pending.draft,
      command: {
        name: pending.skillName,
        arguments: pending.arguments,
      },
    }, {
      ...pending.options,
      implicitSkillCommandPolicy: "allow",
    });
  };

  const tempRuntimeUiDiagnosticBadge = (visibleSurface: TempRuntimeUiRenderSurface) => (
    <Show when={props.developerMode}>
      <div
        class="mb-3 rounded-lg border border-red-7/30 bg-red-1/80 px-3 py-2 font-mono text-[10px] leading-4 text-red-12"
        data-temp-runtime-ui-render-source={visibleSurface}
      >
        TEMP UI marker: {tempRuntimeUiRenderSource().source} | kind: {tempRuntimeUiRenderSource().markerKind} |
        reason: {tempRuntimeUiRenderSource().reason} |
        visible: {visibleSurface} | state: {tempRuntimeUiRenderSource().surface} | session:{" "}
        {tempRuntimeUiRenderSource().selectedSessionId ?? "none"} | key:{" "}
        {tempRuntimeUiRenderSource().currentSessionQueueKey} | messages: {tempRuntimeUiRenderSource().messageCount} |
        effective: {tempRuntimeUiRenderSource().effectiveMessageCount ?? "n/a"} | workspace:{" "}
        {tempRuntimeUiRenderSource().activeWorkspaceId || "none"} | hydrated:{" "}
        {String(tempRuntimeUiRenderSource().workspacesHydrated)} | engineReady:{" "}
        {String(tempRuntimeUiRenderSource().engineReady)} | clientConnected:{" "}
        {String(tempRuntimeUiRenderSource().clientConnected)} | routeEntry:{" "}
        {String(tempRuntimeUiRenderSource().activeWorkspaceHasRoutingEntry)} | routeListReady:{" "}
        {String(tempRuntimeUiRenderSource().activeWorkspaceSessionsLoaded)} | setup:{" "}
        {String(tempRuntimeUiRenderSource().workspaceSetupVisible ?? false)} | composerEntry:{" "}
        {String(tempRuntimeUiRenderSource().composerEntryVisible ?? false)} | loading:{" "}
        {String(tempRuntimeUiRenderSource().sessionLoadingVisible ?? false)} |
        pending: {tempRuntimeUiRenderSource().activePendingDraftKey ?? "none"} | client:{" "}
        {tempRuntimeUiRenderSource().clientMessageId ?? "none"} | origin: {tempRuntimeUiRenderSource().origin ?? "none"} |
        detail: {tempRuntimeUiRenderSource().detail ?? "none"} | at:{" "}
        {new Date(tempRuntimeUiRenderSource().at).toISOString()}
      </div>
    </Show>
  );

  const handleComposerTargetSelect = async (targetId: string) => {
    const result = await props.switchComposerTarget(targetId);
    if (result.status === "blocked") setToastMessage(result.message);
  };

  const handleDraftChange = (draft: ComposerDraft) => {
    props.setComposerDraft(draft);
  };

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
      sourceContext: "session",
    });
  };

  const serverQueueProjectionController = createServerQueueProjectionController({
    getScope: activeServerQueueProjectionScope,
    fetchScope: async (scope) => {
      const client = props.vesloServerClient;
      if (!client || props.vesloServerStatus !== "connected") return null;
      const page = await client.listConversationQueue(scope.workspaceId, scope.conversationId, {
        status: ["pending", "starting", "failed"],
      });
      return page.items;
    },
    replaceScope: (scope, items) => {
      setServerQueuedRuns((current) => replaceServerQueuedRunScope(current, scope, items));
    },
    hasKnownPollingRows: (scope) =>
      serverQueuedRunsForScope(untrack(serverQueuedRuns), scope.workspaceId, scope.conversationId).some(
        (item) => item.status === "pending" || item.status === "starting",
      ),
  });
  const requestServerQueueProjectionRefresh = (scope = activeServerQueueProjectionScope()) => {
    void serverQueueProjectionController.refreshAndPoll(scope);
  };
  createEffect(
    on(
      () => [
        activeServerQueueProjectionScope()?.workspaceId ?? "",
        activeServerQueueProjectionScope()?.conversationId ?? "",
        activeServerQueueProjectionScope()?.uiConversationKey ?? "",
        props.vesloServerClient,
        props.vesloServerStatus,
        props.reconnectState?.status ?? "",
      ] as const,
      ([workspaceId, conversationId, uiConversationKey, _client, status]) => {
        if (!workspaceId || !conversationId || !uiConversationKey || status !== "connected") {
          serverQueueProjectionController.stopPolling();
          return;
        }
        requestServerQueueProjectionRefresh({ workspaceId, conversationId, uiConversationKey });
      },
    ),
  );
  createEffect(
    on(
      () => [props.sessionStatus, activeServerQueueProjectionScope()?.uiConversationKey ?? ""] as const,
      ([status, uiConversationKey], previous) => {
        if (!uiConversationKey || !previous || status === previous[0]) return;
        requestServerQueueProjectionRefresh();
      },
      { defer: true },
    ),
  );
  onCleanup(() => serverQueueProjectionController.dispose());

  const reportLoadedSessionPrefetchInterest: LoadedSessionPrefetchInterestChangeHandler = (workspaceId, interest) => {
    const client = props.vesloServerClient;
    if (!client || props.vesloServerStatus !== "connected") return;
    const serverWorkspaceId = resolveVesloWorkspaceId(workspaceId);
    if (!serverWorkspaceId) return;

    void client.prefetchSessionTranscripts(serverWorkspaceId, interest, { appWorkspaceId: workspaceId }).catch((error) => {
      console.warn("[session.loaded-session-prefetch] failed", {
        workspaceId,
        serverWorkspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const openPendingDirectoryDraftFromList = (workspaceId: string) => {
    const pendingBaseKey = pendingSessionQueueKey();
    const pendingKey = pendingQueueKeyAwaitingSessionIdByBaseKey()[pendingBaseKey] ?? null;
    if (pendingKey) {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey(pendingBaseKey, pendingKey);
    }
    props.openPendingDirectoryDraftInWorkspace(workspaceId);
  };

  createEffect(
    on(
      () => [commandPaletteMode(), commandPaletteQuery()],
      () => {
        if (!commandPaletteOpen()) return;
        commandPaletteOptionRefs.length = 0;
        setCommandPaletteActiveIndex(0);
      },
    ),
  );

  const openSettings = (tab: SettingsTab = "general") => {
    props.setSettingsTab(tab);
    props.setTab("settings");
    props.setView("dashboard");
  };

  const openConfig = () => {
    props.setTab("config");
    props.setView("dashboard");
  };

  const openDashboardTab = (tab: DashboardTab) => {
    props.setTab(tab);
    props.setView("dashboard");
  };

  const showUpdatePill = createMemo(() => {
    if (!isTauriRuntime()) return false;
    const state = props.updateStatus?.state;
    const retry = props.updateStatus?.retry;
    return (
      state === "available" ||
      state === "downloading" ||
      state === "installing" ||
      state === "ready" ||
      (state === "error" && retry?.kind === "exhausted")
    );
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
    const retry = props.updateStatus?.retry;
    if (state === "ready") {
      return t("settings.sidebar_update_ready", currentLocale());
    }
    if (state === "installing") {
      return t("settings.update_installing", currentLocale());
    }
    if (state === "available" && props.updateAutoDownload) {
      return t("settings.sidebar_update_preparing", currentLocale());
    }
    if (state === "error" && retry?.kind === "exhausted") {
      return t("settings.update_download_failed", currentLocale());
    }
    if (state === "downloading") {
      if (retry?.kind === "scheduled" || retry?.kind === "active") {
        return t("settings.update_retrying_download", currentLocale());
      }
      const percent = updateDownloadPercent();
      const label = t("settings.update_downloading", currentLocale());
      return percent == null ? label : `${label} ${percent}%`;
    }
    return t("settings.sidebar_update_available", currentLocale());
  });

  const updatePillActionLabel = createMemo(() => {
    const state = props.updateStatus?.state;
    const retry = props.updateStatus?.retry;
    if (state === "available" && !props.updateAutoDownload) return t("settings.sidebar_download_update", currentLocale());
    if (state === "ready") return t("settings.sidebar_install_update", currentLocale());
    if (state === "error" && retry?.kind === "exhausted") return t("settings.retry_update_download", currentLocale());
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
    const retry = props.updateStatus?.retry;
    if (state === "ready") {
      return props.anyActiveRuns
        ? "text-amber-11 hover:text-amber-11 hover:bg-amber-3/30"
        : "text-green-11 hover:text-green-11 hover:bg-green-3/30";
    }
    if (state === "error" && retry?.kind === "exhausted") {
      return "text-red-11 hover:text-red-11 hover:bg-red-3/30";
    }
    if (state === "downloading" || state === "installing") {
      return "text-blue-11 hover:text-blue-11 hover:bg-blue-3/30";
    }
    return "text-dls-secondary hover:text-emerald-11 hover:bg-emerald-3/25";
  });

  const updatePillBorderTone = createMemo(() => {
    const state = props.updateStatus?.state;
    const retry = props.updateStatus?.retry;
    if (state === "ready") {
      return props.anyActiveRuns ? "border-amber-7/35" : "border-green-7/35";
    }
    if (state === "error" && retry?.kind === "exhausted") {
      return "border-red-7/35";
    }
    if (state === "downloading" || state === "installing") {
      return "border-blue-7/35";
    }
    return "border-dls-border";
  });

  const updatePillDotTone = createMemo(() => {
    const state = props.updateStatus?.state;
    const retry = props.updateStatus?.retry;
    if (state === "ready") {
      return props.anyActiveRuns ? "text-amber-10 fill-amber-10" : "text-green-10 fill-green-10";
    }
    if (state === "error" && retry?.kind === "exhausted") {
      return "text-red-10 fill-red-10";
    }
    if (state === "downloading" || state === "installing") {
      return "text-blue-10";
    }
    return "text-emerald-10 fill-emerald-10";
  });

  const updatePillVersionTone = createMemo(() => {
    const state = props.updateStatus?.state;
    const retry = props.updateStatus?.retry;
    if (state === "ready") {
      return props.anyActiveRuns ? "text-amber-11/75" : "text-green-11/75";
    }
    if (state === "error" && retry?.kind === "exhausted") {
      return "text-red-11/75";
    }
    if (state === "downloading" || state === "installing") {
      return "text-blue-11/75";
    }
    return "text-dls-secondary";
  });

  const updatePillTitle = createMemo(() => {
    const version = props.updateStatus?.version ? ` v${props.updateStatus.version}` : "";
    const state = props.updateStatus?.state;
    const retry = props.updateStatus?.retry;
    if (state === "ready") {
      return props.anyActiveRuns
        ? `${t("settings.sidebar_update_ready", currentLocale())}${version}. ${t("settings.stop_runs_to_update", currentLocale())}.`
        : `${t("settings.sidebar_update_ready", currentLocale())}${version}`;
    }
    if (state === "error" && retry?.kind === "exhausted") {
      return `${t("settings.update_download_failed", currentLocale())}${version}`;
    }
    if (state === "downloading" && (retry?.kind === "scheduled" || retry?.kind === "active")) {
      return `${t("settings.update_retrying_download", currentLocale())}${version}`;
    }
    if (state === "downloading") return `${t("settings.update_downloading", currentLocale())}${version}`;
    if (state === "installing") return `${t("settings.update_installing", currentLocale())}${version}`;
    if (state === "available" && props.updateAutoDownload) {
      return `${t("settings.sidebar_update_preparing", currentLocale())}${version}`;
    }
    return `${t("settings.sidebar_update_available", currentLocale())}${version}`;
  });

  const openSoul = (workspaceId?: string) => {
    const id = (workspaceId ?? props.activeWorkspaceId).trim();
    if (!id) return;
    void (async () => {
      if (id !== props.activeWorkspaceId) {
        const activated = await Promise.resolve(props.activateWorkspace(id, { origin: "session:open-soul-workspace" }));
        if (!activated) return;
      }
      props.setTab("soul");
      props.setView("dashboard");
    })();
  };

  const runtimeAvailableWithoutClient = createMemo(() => {
    void props.clientConnected;
    void props.vesloServerStatus;
    void props.activeWorkspaceDisplay;
    return false;
  });

  const leftSidebarUpdatePill = () => (
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
                if (props.updateStatus?.state === "available") {
                  if (!props.updateAutoDownload) {
                    props.downloadUpdate();
                  }
                  return;
                }
                if (props.updateStatus?.state === "error" && props.updateStatus?.retry?.kind === "exhausted") {
                  props.retryUpdateDownload();
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
  );

  const feedbackButtonLabel = () => t("feedback.button", currentLocale());

  return (
    <div
      ref={(el) => {
        sessionLayoutRootEl = el;
      }}
      data-feedback-capture-root
      class="flex h-screen w-full min-w-0 bg-dls-sidebar text-gray-12 font-sans overflow-hidden"
    >
      <TitlebarMenuToggles
        leftActive={leftSidebarToggleActive()}
        rightActive={rightSidebarToggleActive()}
        centerContent={sessionTitlebarContext()}
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
        onToggleLeft={() => toggleSidebarMenu("left")}
        onToggleRight={() => toggleSidebarMenu("right")}
      />

      <SessionLeftSidebar
        dockedVisible={leftDockedVisible()}
        overlayOpen={overlayOpenSide() === "left"}
        resizing={leftSidebarResizing()}
        dockedStyle={leftSidebarDockedStyle()}
        overlayStyle={leftSidebarOverlayStyle()}
        resizeLabel={__vesloT("ui.literal.resize_left_sidebar_1nybbn", __vesloCurrentLocale())}
        updatePill={leftSidebarUpdatePill()}
        workspaceSessionListProps={{
          workspaceSessionGroups: props.workspaceSessionGroups,
          workspaceSessionPagingById: props.workspaceSessionPagingById,
          subagentDecorationsBySessionId: props.subagentDecorationsBySessionId,
          unreadSessionIds: props.unreadSessionIds,
          archivedSessionIds: props.archivedSessionIds,
          activeWorkspaceId: props.activeWorkspaceId,
          selectedSessionId: props.selectedSessionId,
          selectedSessionKey: props.activeUiConversationRef?.key ?? null,
          pendingPermissionCountByWs: props.pendingPermissionCountByWs,
          allowSelectedParentExpansion: true,
          sidebarSessionActivityByRowKey: props.sidebarSessionActivityByRowKey,
          connectingWorkspaceId: props.connectingWorkspaceId,
          workspaceConnectionStateById: props.workspaceConnectionStateById,
          readyEngineWorkspaceIds: props.readyEngineWorkspaceIds,
          newTaskDisabled: props.newTaskDisabled,
          importingWorkspaceConfig: props.importingWorkspaceConfig,
          showRemoteActions: props.showRemoteActions,
          isPrivateWorkspacePath: props.isPrivateWorkspacePath,
          onActivateWorkspace: props.activateWorkspace,
          onOpenSession: openSessionFromList,
          onDeleteSession: openDeleteSessionModalForSession,
          onRenameSession: openRenameModalFor,
          onOpenPendingDirectoryDraftInWorkspace: openPendingDirectoryDraftFromList,
          onOpenRenameWorkspace: props.openRenameWorkspace,
          onShareWorkspace: (workspaceId) => setShareWorkspaceId(workspaceId),
          onOpenSoul: openSoul,
          onRevealWorkspace: revealWorkspaceInFinder,
          onRecoverWorkspace: props.recoverWorkspace,
          onTestWorkspaceConnection: props.testWorkspaceConnection,
          onEditWorkspaceConnection: props.editWorkspaceConnection,
          onForgetWorkspace: props.forgetWorkspace,
          onOpenCreateWorkspace: props.openCreateWorkspace,
          onOpenCreateRemoteWorkspace: props.openCreateRemoteWorkspace,
          onImportWorkspaceConfig: props.importWorkspaceConfig,
          onQuickNewSession: props.openNewSessionWithDirectory,
          onAddDirectorySession: props.openDirectorySessionFromPicker,
          onOpenArchivedSessions: () => openSettings("archived"),
          onArchiveSession: props.archiveSession,
          onUnarchiveSession: props.unarchiveSession,
          onLoadMoreWorkspaceSessions: props.loadMoreWorkspaceSidebarSessions,
          onLoadedSessionPrefetchInterestChange: reportLoadedSessionPrefetchInterest,
          onOpenSessionSearch: () => openCommandPalette("sessions"),
        }}
        dashboardNavProps={{
          currentTab: props.tab,
          onSelect: openDashboardTab,
        }}
        statusControlsProps={{
          clientConnected: props.clientConnected,
          vesloServerConnection: props.vesloServerConnection,
          runtimeAvailableWithoutClient: runtimeAvailableWithoutClient(),
          authenticatedUser: props.authenticatedUser,
          onOpenSettings: () => openSettings("general"),
          onLogout: props.onLogout,
          onSignIn: props.onSignIn,
        }}
        onCloseOverlay={closeSidebarOverlay}
        onStartResize={startLeftSidebarResize}
      />

      <SessionCenter
        searchBanner={(
        <Show when={searchOpen()}>
          <div class="border-b border-gray-5 bg-gray-2/70 px-6 py-2">
            <div class={`mx-auto flex w-full ${searchBannerWidthClass()} items-center gap-2 rounded-xl border border-gray-6 bg-gray-1 px-3 py-2`}>
              <Search size={14} class="text-gray-9" />
              <input
                ref={(el) => (searchInputEl = el)}
                type="text"
                value={searchQuery()}
                onInput={(event) => {
                  setSearchQuery(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    moveSearchHit(event.shiftKey ? -1 : 1);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeSearch();
                  }
                }}
                class="min-w-0 flex-1 bg-transparent text-sm text-gray-11 placeholder:text-gray-9 focus:outline-none"
                placeholder={tr("session.search_in_chat")}
                aria-label={tr("session.search_in_chat")}
              />
              <span class="text-[11px] text-gray-10 tabular-nums">{activeSearchPositionLabel()}</span>
              <button
                type="button"
                class="rounded-md border border-gray-6 px-2 py-1 text-[11px] text-gray-10 hover:text-gray-12 hover:bg-gray-3 transition-colors disabled:opacity-60"
                disabled={searchHits().length === 0}
                onClick={() => moveSearchHit(-1)}
                aria-label={tr("session.previous_match")}
              >
                {tr("session.previous_short")}
              </button>
              <button
                type="button"
                class="rounded-md border border-gray-6 px-2 py-1 text-[11px] text-gray-10 hover:text-gray-12 hover:bg-gray-3 transition-colors disabled:opacity-60"
                disabled={searchHits().length === 0}
                onClick={() => moveSearchHit(1)}
                aria-label={tr("session.next_match")}
              >
                {tr("session.next_short")}
              </button>
              <button
                type="button"
                class="h-7 w-7 flex items-center justify-center rounded-md text-gray-10 hover:text-gray-12 hover:bg-gray-3 transition-colors"
                onClick={closeSearch}
                aria-label={tr("session.close_search")}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </Show>
        )}
        reloadBanner={(
        <>
          <Show when={props.showSkillReloadBanner}>
            <div
              class="border-b border-amber-6/50 bg-amber-2/70 px-6 py-3"
              data-testid="session-reload-banner"
              data-reload-blocked={props.reloadBannerBlocked ? "true" : "false"}
            >
              <div class={`mx-auto flex w-full ${searchBannerWidthClass()} flex-col gap-3 rounded-2xl border border-amber-6/60 bg-amber-1/80 px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between`}>
                <div class="min-w-0">
                  <div class="text-sm font-medium text-amber-11">{props.reloadBannerTitle}</div>
                  <div class="mt-0.5 text-xs text-amber-11/80">
                    {props.reloadBannerBody}
                    <Show when={props.reloadBannerBlocked}>
                      <span>
                        {" "}
                        {formatTr("reload.toast_warning_active", { count: props.reloadBannerActiveCount })}
                      </span>
                    </Show>
                  </div>
                  <Show when={props.reloadError}>
                    <div class="mt-1 text-xs text-red-11">{props.reloadError}</div>
                  </Show>
                </div>

                <div class="flex items-center gap-2 sm:shrink-0">
                  <button
                    type="button"
                    data-testid="session-reload-action"
                    class="rounded-xl border border-amber-7 bg-amber-4 px-3 py-2 text-xs font-medium text-amber-12 transition-colors hover:bg-amber-5 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!props.canReloadWorkspace || props.reloadBusy}
                    onClick={() =>
                      void (props.reloadBannerBlocked
                        ? props.forceStopActiveConversations()
                        : props.reloadWorkspaceEngine())
                    }
                  >
                    {props.reloadBusy
                      ? tr("reload.toast_reloading")
                      : props.reloadBannerBlocked
                        ? tr("reload.toast_reload_stopped")
                        : tr("reload.toast_reload")}
                  </button>
                  <button
                    type="button"
                    class="rounded-xl border border-amber-6/70 bg-transparent px-3 py-2 text-xs font-medium text-amber-11 transition-colors hover:bg-amber-3"
                    onClick={() => props.dismissReloadBanner()}
                  >
                    {tr("reload.toast_dismiss")}
                  </button>
                </div>
              </div>
            </div>
          </Show>
          <Show when={visibleReconnectState()}>
            {(state) => (
              <div
                class="border-b border-blue-6/50 bg-blue-2/70 px-6 py-2"
                data-testid="session-reconnect-state"
                data-reconnect-status={state().status}
              >
                <div class={`mx-auto flex w-full ${searchBannerWidthClass()} items-center gap-2 rounded-lg border border-blue-6/60 bg-blue-1/85 px-3 py-2 text-xs text-blue-11 shadow-sm`}>
                  <Loader2 size={14} class="shrink-0 animate-spin" />
                  <span class="shrink-0 font-medium">{tr(reconnectStateLabelKey(state().status))}</span>
                  <span class="min-w-0 truncate text-blue-11/80">{reconnectStateDetail(state())}</span>
                </div>
              </div>
            )}
          </Show>
        </>
        )}
        transcript={(
        <div
          data-testid="session-center-pane"
          ref={(el) => {
            setSessionUiMutationRoot(el);
          }}
          class="flex-1 flex overflow-hidden"
        >
          <div class="flex-1 min-w-0 relative overflow-hidden bg-gray-1">
            <div
              data-testid="session-transcript-viewport"
              class={`h-full overflow-y-auto px-8 ${showWorkspaceSetupEmptyState() ? "pt-8 pb-20" : "pt-0 pb-0"} scroll-smooth bg-gray-1 ${nearBottom() ? "chat-scrollbar-hidden" : ""} ${initialAnchorPending() ? "invisible" : "visible"}`}
              style={{ contain: "layout paint style" }}
              ref={(el) => {
                chatContainerEl = el;
                setIsChatContainerReady(Boolean(el));
              }}
            >
              <div class={`mx-auto w-full ${chatBodyWidthClass()}`}>
            <Show when={showWorkspaceSetupEmptyState()}>
              {tempRuntimeUiDiagnosticBadge("workspace-initial")}
              <div class="mx-auto max-w-xl rounded-3xl border border-gray-6 bg-gray-2/60 p-8 text-center shadow-sm">
                <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-gray-6 bg-gray-1 text-gray-11">
                  <MessageCircle size={24} />
                </div>
                <h3 class="font-product type-title-md text-gray-12">{tr("session.start_new_session")}</h3>
                <p class="font-reading type-reading-md mt-2 text-gray-10">
                  {tr("session.start_new_session_description")}
                </p>
                <div class="mt-6 flex justify-center">
                  <button
                    type="button"
                    class="font-product type-ui-md inline-flex items-center gap-2 rounded-2xl border border-gray-7 bg-gray-12 px-4 py-3 font-semibold text-gray-1 transition-colors hover:bg-gray-11 disabled:cursor-not-allowed disabled:opacity-70"
                    disabled={newSessionBusy()}
                    onClick={() => {
                      void openNewSessionFromEmptyState();
                    }}
                  >
                    <Show when={newSessionBusy()}>
                      <Loader2 size={14} class="animate-spin" />
                    </Show>
                    {tr("session.new_session_label")}
                  </button>
                </div>
                <Show when={newSessionDisplayError()}>
                  <p class="font-reading type-ui-sm mt-4 text-red-11">
                    {newSessionDisplayError()}
                  </p>
                </Show>
              </div>
            </Show>
            <Show when={showSessionLoadingState()}>
              <div class="mx-auto max-w-xl px-6 py-20 text-center">
                <div class="mx-auto flex max-w-md flex-col items-center gap-5 rounded-3xl border border-gray-6 bg-gray-2/60 px-8 py-10 shadow-sm">
                  <div class="flex h-16 w-16 items-center justify-center rounded-3xl border border-gray-6 bg-gray-1 text-gray-10">
                    <Loader2 size={18} class="animate-spin text-gray-10" />
                  </div>
                  <div class="space-y-2">
                    <h3 class="font-product type-title-sm text-gray-12">
                      {props.selectedSessionTitle || tr("session.opening_conversation")}
                    </h3>
                    <p class="font-reading type-ui-md text-gray-10">{tr("session.opening_conversation")}</p>
                  </div>
                </div>
              </div>
            </Show>
          <Show when={showComposerEntryState()}>
            <div class="mx-auto flex min-h-[min(34rem,calc(100vh-14rem))] w-full max-w-[960px] flex-col justify-center px-4 py-12">
              <div class="mx-auto flex w-full max-w-[960px] flex-col items-center gap-5 text-center">
                <ComposerTargetPicker
                  options={props.composerTargetOptions}
                  activeTargetId={props.activeComposerTargetId}
                  disabled={props.busy}
                  onSelect={(targetId) => {
                    void handleComposerTargetSelect(targetId);
                  }}
                />
                <h2
                  data-testid="composer-entry-target-heading"
                  class="font-product type-title-md w-full max-w-[960px] text-balance text-dls-text"
                >
                  {composerEntryHeading()}
                </h2>
                <Show when={composerResetKey()} keyed>
                  {(_composerKey) => (
                    <div class="w-full text-left">
                      <Composer
                        entryPlacement="center"
                        initialDraft={props.composerDraft}
                        prompt={props.composerDraft.text}
                        developerMode={props.developerMode}
                        busy={composerBusy()}
                        isStreaming={showRunIndicator()}
                        recoveryBlocked={recoveryBlockedComposer()}
                        stopShortcutConfirmPending={escapeStopConfirmationPending()}
                        compactWidth={useCompactCenterColumn()}
                        onSend={handleSendPrompt}
                        onStop={cancelRun}
                        onDraftChange={handleDraftChange}
                        selectedAgent={props.selectedSessionAgent}
                        onSelectAgent={(agent) => {
                          void applySessionAgent(agent);
                        }}
                        showNotionBanner={props.showTryNotionPrompt}
                        onNotionBannerClick={props.onTryNotionPrompt}
                        toast={toastMessage()}
                        onToast={(message) => setToastMessage(message)}
                        listAgents={props.listAgents}
                        recentFiles={props.workingFiles}
                        searchFiles={props.searchFiles}
                        listCommands={props.listCommands}
                        isRemoteWorkspace={props.activeWorkspaceDisplay.workspaceType === "remote"}
                        localWorkspacePath={props.activeWorkspaceRoot}
                        canChooseSessionFolder={props.canChooseSessionFolder}
                        onChooseSessionFolder={chooseFolderForSession}
                        attachmentsEnabled={attachmentsEnabled()}
                        attachmentsDisabledReason={attachmentsDisabledReason()}
                        engineReady={props.engineReady}
                      />
                    </div>
                  )}
                </Show>
              </div>
            </div>
          </Show>

          <Show when={!showWorkspaceSetupEmptyState()}>
            {tempRuntimeUiDiagnosticBadge("conversation")}
          </Show>

          <Show when={props.historyUnavailable}>
            {(history) => (
              <div class="mx-auto mb-4 flex w-full max-w-[min(100%,72rem)] flex-col gap-3 rounded-xl border border-amber-7/40 bg-amber-2/40 px-4 py-3 text-sm text-amber-12 sm:flex-row sm:items-center sm:justify-between">
                <div class="min-w-0 leading-relaxed">
                  {tr("session.history_unavailable")}
                </div>
                <button
                  type="button"
                  class="shrink-0 rounded-lg border border-amber-7 bg-amber-4 px-3 py-2 text-xs font-medium text-amber-12 transition-colors hover:bg-amber-5 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => {
                    void Promise.resolve(props.retryUnavailableHistory(history().sessionId)).catch((error) =>
                      reportError(error, "session.historyUnavailable.retry"),
                    );
                  }}
                  disabled={props.historyUnavailableRetrying}
                >
                  {props.historyUnavailableRetrying
                    ? tr("session.history_retrying")
                    : tr("session.history_retry")}
                </button>
              </div>
            )}
          </Show>

          <Show when={hiddenMessageCount() > 0 || hasServerEarlierMessages()}>
            <div class="mb-4 flex justify-center">
              <button
                type="button"
                class="rounded-full border border-dls-border bg-dls-hover/70 px-3 py-1 text-xs text-dls-secondary transition-colors hover:bg-dls-active hover:text-dls-text"
                onClick={() => {
                  void revealEarlierMessages();
                }}
                disabled={props.loadingEarlierMessages}
              >
                {props.loadingEarlierMessages
                  ? tr("session.loading_earlier_messages")
                  : hiddenMessageCount() > 0
                    ? formatTr("session.show_earlier_messages", { count: nextRevealCount().toLocaleString() })
                    : tr("session.load_earlier_messages")}
              </button>
            </div>
          </Show>

          <MessageList
            messages={displayedEffectiveMessages()}
            isStreaming={showRunIndicator()}
            developerMode={props.developerMode}
            showThinking={props.showThinking}
            subagentDecorationsBySessionId={props.subagentDecorationsBySessionId}
            workspaceRoot={props.activeWorkspaceRoot}
            expandedStepIds={props.expandedStepIds}
            setExpandedStepIds={props.setExpandedStepIds}
            expandedTimelineSectionIds={props.expandedTimelineSectionIds}
            setExpandedTimelineSectionIds={props.setExpandedTimelineSectionIds}
            expandedTimelineDetailIds={props.expandedTimelineDetailIds}
            setExpandedTimelineDetailIds={props.setExpandedTimelineDetailIds}
            openSessionById={(sessionId) => props.setView("session", sessionId)}
            searchMatchMessageIds={searchMatchMessageIds()}
            activeSearchMessageId={activeSearchHit()?.messageId ?? null}
            searchHighlightQuery={searchQueryDebounced().trim()}
            scrollElement={() => chatContainerEl}
            pendingMessageStateById={pendingMessageStateById()}
            editableUserMessage={editableUserMessage()}
            onEditUserMessage={handleEditUserMessage}
            onMessageBlocksRecomputed={
              sessionUiDiagnosticEnabled()
                ? (trace) => {
                    markTempRuntimeUiRenderSource("MessageList.messageBlocks", "recomputed", {
                      markerKind: "message-blocks",
                      detail: `revision=${trace.revision} blocks=${trace.blockCount} unstableKeys=${trace.unstableBlockKeyCount}`,
                      markerPayload: { ...trace },
                    });
                  }
                : undefined
            }
            setScrollToMessageById={(handler) => {
              scrollMessageIntoViewById = handler;
            }}
            footer={
              showFooterRunIndicator() ? (
                <div class="flex justify-start pl-2">
                  <div class={`w-full ${railWidthClass()}`}>
                    <div
                      class={`flex items-center gap-2 text-xs py-1 ${runPhase() === "error" ? "text-red-11" : "text-gray-9"}`}
                      data-testid="session-run-indicator"
                      data-run-phase={runPhase()}
                      role="status"
                      aria-live="polite"
                    >
                      <span
                        class={`h-1.5 w-1.5 rounded-full shrink-0 ${
                          runPhase() === "error" ? "bg-red-9" : "bg-gray-8 animate-pulse"
                        }`}
                      />
                      <span class="truncate">
                        {recoveryNotice() === "connection-unavailable"
                          ? tr("session.run_observation_exhausted")
                          : recoveryNotice() === "transcript-unavailable"
                            ? tr("session.run_transcript_unavailable")
                            : runDiagnosticLabel() || thinkingStatus() || runLabel()}
                      </span>
                      <Show when={recoveryNotice()}>
                        <button
                          type="button"
                          class="ml-auto shrink-0 rounded border border-red-8 px-2 py-0.5 text-[10px] font-medium text-red-11 hover:bg-red-2"
                          onClick={() => {
                            if (recoveryNotice() === "connection-unavailable") {
                              retryAcceptedRunRecovery();
                            } else {
                              retryTerminalTranscriptRecovery();
                            }
                          }}
                        >
                          {tr("session.history_retry")}
                        </button>
                      </Show>
                      <Show when={!recoveryNotice()}>
                        <span class="text-[10px] text-gray-8 ml-auto shrink-0">{runElapsedLabel()}</span>
                      </Show>
                    </div>
                  </div>
                </div>
              ) : undefined
            }
          />

          <Show when={operationalError()}>
            <div class="px-3 py-2 text-xs text-gray-10" data-testid="session-operational-error" role="status">
              {operationalError()}
            </div>
          </Show>

           <div
             ref={(el) => {
               messagesEndEl = el;
               bottomVisibilityEl = el;
             }}
           />
           </div>
           </div>

            <Show when={props.messages.length > 0 && !nearBottom()}>
              <div class="absolute bottom-4 right-4 z-20 pointer-events-none">
                <div class="pointer-events-auto flex items-center gap-2 rounded-full border border-gray-6 bg-gray-1/95 p-1 shadow-lg shadow-gray-12/5 backdrop-blur-md">
                  <button
                    type="button"
                    class="h-7 w-7 rounded-full p-0 text-gray-11 hover:bg-gray-3 transition-colors flex items-center justify-center"
                    onClick={() => jumpToLatest("smooth")}
                    aria-label={tr("session.jump_to_latest")}
                    title={tr("session.jump_to_latest")}
                  >
                    <ChevronDown size={12} />
                  </button>
                </div>
              </div>
            </Show>
         </div>

        </div>

        )}
        todoPanel={(
      <Show when={todoCount() > 0}>
        <div class={`mx-auto w-full ${railWidthClass()} px-4`}>
          <div class="rounded-t-xl border border-b-0 border-gray-6/70 bg-gray-1/70 shadow-sm shadow-gray-12/5">
            <button
              type="button"
              class="w-full flex items-center justify-between px-4 py-1.5 text-xs text-gray-9 hover:bg-gray-2/50 transition-colors rounded-t-xl"
              onClick={() => setTodoExpanded((prev) => !prev)}
            >
              <div class="flex items-center gap-2">
                <ListTodo size={14} class="text-gray-8" />
                <span class="text-gray-11 font-medium">{todoLabel()}</span>
              </div>
              <Minimize2
                size={12}
                class={`text-gray-8 transition-transform ${todoExpanded() ? "" : "rotate-180"}`}
              />
            </button>
            <Show when={todoExpanded()}>
              <div class="px-4 pb-1.5 space-y-1 max-h-60 overflow-auto border-t border-gray-6/50">
                <For each={todoList()}>
                  {(todo, index) => {
                    const done = () => todo.status === "completed";
                    const cancelled = () => todo.status === "cancelled";
                    const active = () => todo.status === "in_progress";
                    return (
                      <div class="flex items-start gap-2 pt-1 first:pt-1">
                        <div class="flex items-center gap-1.5 pt-0.5">
                          <div
                            class={`h-4.5 w-4.5 rounded-full border flex items-center justify-center ${
                              done()
                                ? "border-green-6 bg-green-2 text-green-11"
                                : active()
                                  ? "border-amber-6 bg-amber-2 text-amber-11"
                                  : cancelled()
                                    ? "border-gray-6 bg-gray-2 text-gray-8"
                                    : "border-gray-6 bg-gray-1 text-gray-8"
                            }`}
                          >
                            <Show when={done()}>
                              <Check size={10} />
                            </Show>
                            <Show when={!done() && active()}>
                              <span class="h-1.5 w-1.5 rounded-full bg-amber-9" />
                            </Show>
                          </div>
                        </div>
                        <div
                          class={`flex-1 text-[13px] leading-[1.35] ${
                            cancelled() ? "text-gray-9 line-through" : "text-gray-12"
                          }`}
                        >
                          <span class="text-gray-9 mr-1.5">{index() + 1}.</span>
                          {todo.content}
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </Show>

        )}
        composerArea={(
      <Show when={showFooterComposerArea()}>
        <>
              <Show when={visibleAiAccessBlockedReason()}>
                <div class="mx-auto mb-3 w-full max-w-[min(100%,72rem)] rounded-2xl border border-amber-7/30 bg-amber-2/30 px-4 py-3 text-sm text-amber-12">
                  {visibleAiAccessBlockedReason()}
                </div>
              </Show>
              <Show when={queuedDrafts().length > 0}>
                <div class={`mx-auto mb-2 w-full ${railWidthClass()}`}>
                  <QueuedMessageList
                    items={queuedDrafts()}
                    onEdit={handleEditQueuedDraft}
                    onCancel={handleCancelQueuedDraft}
                    onRetry={handleRetryQueuedDraft}
                    onMove={handleMoveQueuedDraft}
                  />
                </div>
              </Show>
              <Show when={visibleServerQueuedRuns().length > 0}>
                <div class={`mx-auto mb-2 w-full ${railWidthClass()}`}>
                  <ServerQueuedRunList items={visibleServerQueuedRuns()} />
                </div>
              </Show>
              <Show when={showFooterComposerTargetContext()}>
                <div class={`mx-auto mb-5 flex w-full ${railWidthClass()} flex-col items-center gap-3 text-center`}>
                  <ComposerTargetPicker
                    options={props.composerTargetOptions}
                    activeTargetId={props.activeComposerTargetId}
                    disabled={props.busy}
                    onSelect={(targetId) => {
                      void handleComposerTargetSelect(targetId);
                    }}
                  />
                  <h2
                    data-testid="composer-entry-target-heading"
                    class="font-product type-title-sm w-full text-balance text-dls-text"
                  >
                    {composerEntryHeading()}
                  </h2>
                </div>
              </Show>
              <Composer
                initialDraft={props.composerDraft}
                prompt={props.composerDraft.text}
                developerMode={props.developerMode}
                busy={composerBusy()}
                isStreaming={showRunIndicator()}
                recoveryBlocked={recoveryBlockedComposer()}
                stopShortcutConfirmPending={escapeStopConfirmationPending()}
                compactTopSpacing={todoCount() > 0}
                compactWidth={useCompactCenterColumn()}
                onSend={handleSendPrompt}
                onStop={cancelRun}
                onDraftChange={handleDraftChange}
                selectedAgent={props.selectedSessionAgent}
                onSelectAgent={(agent) => {
                  void applySessionAgent(agent);
                }}
                showNotionBanner={props.showTryNotionPrompt}
                onNotionBannerClick={props.onTryNotionPrompt}
                toast={toastMessage()}
                onToast={(message) => setToastMessage(message)}
                listAgents={props.listAgents}
                recentFiles={props.workingFiles}
                searchFiles={props.searchFiles}
                listCommands={props.listCommands}
                isRemoteWorkspace={props.activeWorkspaceDisplay.workspaceType === "remote"}
                localWorkspacePath={props.activeWorkspaceRoot}
                canChooseSessionFolder={props.canChooseSessionFolder}
                onChooseSessionFolder={chooseFolderForSession}
                attachmentsEnabled={attachmentsEnabled()}
                attachmentsDisabledReason={attachmentsDisabledReason()}
                engineReady={props.engineReady}
              />
              <div class="sticky bottom-0 z-20 -mt-3 bg-gray-1 px-8 pb-3">
                <div class={`mx-auto flex w-full ${chatBodyWidthClass()} justify-end`}>
                  <span class="text-[11px] leading-4 text-gray-9 text-right">
                    {tr("session.composer_disclaimer")}
                  </span>
                </div>
              </div>
        </>
      </Show>

        )}
      />

      <SessionRightSidebar
        dockedVisible={rightDockedVisible()}
        overlayOpen={overlayOpenSide() === "right"}
        developerMode={props.developerMode}
        advancedNavProps={{
          currentTab: props.tab,
          onSelect: openConfig,
        }}
        artifactsPanelProps={{
          id: "sidebar-artifacts",
          families: props.artifactFamilies,
          workspaceRoot: props.activeWorkspaceRoot,
          onRevealArtifact: revealArtifact,
        }}
        sessionCapabilitiesPanelProps={{
          state: props.sessionCapabilitiesStatus,
          skills: props.sessionCapabilities?.skills ?? [],
          mcp: props.sessionCapabilities?.mcp ?? [],
          error: props.sessionCapabilitiesError,
        }}
        onCloseOverlay={closeSidebarOverlay}
      />

      <Show when={commandPaletteOpen()}>
        <div
          class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
          onClick={closeCommandPalette}
        >
          <div
            class="w-full max-w-2xl mt-12 rounded-2xl border border-dls-border bg-dls-surface shadow-2xl overflow-hidden"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="border-b border-dls-border px-4 py-3 space-y-2">
              <div class="flex items-center gap-2">
                <Show when={commandPaletteMode() !== "root"}>
                <button
                  type="button"
                  class="h-8 px-2 rounded-md text-xs text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                  onClick={returnToCommandRoot}
                >
                  {tr("session.back")}
                </button>
                </Show>
                <Search size={14} class="text-dls-secondary shrink-0" />
                <input
                  ref={(el) => (commandPaletteInputEl = el)}
                  type="text"
                  value={commandPaletteQuery()}
                  onInput={(event) => setCommandPaletteQuery(event.currentTarget.value)}
                  placeholder={commandPalettePlaceholder()}
                  class="min-w-0 flex-1 bg-transparent text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
                  aria-label={commandPaletteTitle()}
                />
                <button
                  type="button"
                  class="h-8 w-8 flex items-center justify-center rounded-md text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                  onClick={closeCommandPalette}
                  aria-label={tr("session.close_quick_actions")}
                >
                  <X size={14} />
                </button>
              </div>
              <div class="text-[11px] text-dls-secondary">{commandPaletteTitle()}</div>
            </div>

            <div class="max-h-[56vh] overflow-y-auto p-2">
              <Show
                when={commandPaletteItems().length > 0}
                fallback={
                  <div class="px-3 py-6 text-sm text-dls-secondary text-center">
                    {tr("session.command_palette_no_matches")}
                  </div>
                }
              >
                <For each={commandPaletteItems()}>
                  {(item, index) => {
                    const idx = () => index();
                    return (
                      <button
                        ref={(el) => {
                          commandPaletteOptionRefs[idx()] = el;
                        }}
                        type="button"
                        disabled={item.disabled}
                        title={item.disabledReason}
                        class={`w-full text-left rounded-xl px-3 py-2.5 transition-colors ${
                          idx() === commandPaletteActiveIndex()
                            ? "bg-dls-active text-dls-text"
                            : "text-dls-text hover:bg-dls-hover"
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                        onMouseEnter={() => setCommandPaletteActiveIndex(idx())}
                        onClick={item.action}
                      >
                        <div class="flex items-start justify-between gap-3">
                          <div class="min-w-0">
                            <div class="text-sm font-medium truncate">{item.title}</div>
                            <Show when={item.detail}>
                              <div class="text-xs text-dls-secondary mt-1 truncate">{item.detail}</div>
                            </Show>
                          </div>
                          <Show when={item.meta}>
                            <span class="text-[10px] uppercase tracking-wide text-dls-secondary shrink-0">{item.meta}</span>
                          </Show>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </div>

            <div class="border-t border-dls-border px-3 py-2 text-[11px] text-dls-secondary flex items-center justify-between gap-2">
              <span>{tr("session.command_palette_navigation_hint")}</span>
              <span>{tr("session.command_palette_run_hint")}</span>
            </div>
          </div>
        </div>
      </Show>

      <RenameSessionModal
        open={renameModalOpen()}
        title={renameTitle()}
        busy={renameBusy()}
        canSave={renameCanSave()}
        onClose={closeRenameModal}
        onSave={submitRename}
        onTitleChange={setRenameTitle}
      />

      <ConfirmModal
        open={deleteSessionOpen()}
        title={tr("session.delete_session_title")}
        message={
          deleteSessionTargetTitle().trim()
            ? formatTr("session.delete_session_named", { title: deleteSessionTargetTitle().trim() })
            : tr("session.delete_session_unnamed")
        }
        confirmLabel={deleteSessionBusy() ? tr("session.deleting") : tr("session.delete_session_action")}
        cancelLabel={tr("session.cancel")}
        variant="danger"
        onConfirm={confirmDeleteSession}
        onCancel={closeDeleteSessionModal}
      />

      <ConfirmModal
        open={Boolean(implicitSkillConfirmation())}
        title={tr("session.implicit_skill_confirm_title")}
        message={formatTr("session.implicit_skill_confirm_body", {
          name: implicitSkillConfirmation()?.skillName ?? "",
        })}
        confirmLabel={tr("session.implicit_skill_confirm_run")}
        cancelLabel={tr("session.implicit_skill_confirm_send_prompt")}
        variant="warning"
        onConfirm={() => void runImplicitSkillCommand()}
        onCancel={() => void sendImplicitSkillAsPrompt()}
        onClose={() => {
          const pending = implicitSkillConfirmation();
          if (pending) removeImplicitSkillConfirmation(pending);
        }}
      />

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
          props.setView("dashboard");
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

      <FolderAccessConsentModal
        open={Boolean(activeFolderAccessRequest())}
        requestedPath={activeFolderAccessRequest()?.requestedPath ?? ""}
        pickerStartPath={activeFolderAccessRequest()?.pickerStartPath ?? ""}
        accessMode="read"
        duration="workspace"
        error={folderAccessError()}
        onChooseFolder={() => void chooseFolderForAccessRequest()}
        onCancel={cancelFolderAccessRequest}
      />

      <Show when={props.activePermission && !activeFolderAccessRequest()}>
        <div class="absolute inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-gray-2 border border-amber-7/30 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6">
              <div class="flex items-start gap-4 mb-4">
                <div class="p-3 bg-amber-7/10 rounded-full text-amber-6">
                  <Shield size={24} />
                </div>
                <div>
                  <h3 class="text-lg font-semibold text-gray-12">{tr("session.permission_required")}</h3>
                  <p class="text-sm text-gray-11 mt-1">{tr("session.permission_description")}</p>
                </div>
              </div>

              <div class="bg-gray-1/50 rounded-xl p-4 border border-gray-6 mb-6">
                <div class="text-xs text-gray-10 uppercase tracking-wider mb-2 font-semibold">{tr("session.permission_label")}</div>
                <div class="text-sm text-gray-12 font-mono">{props.activePermission?.permission}</div>

                <div class="text-xs text-gray-10 uppercase tracking-wider mt-4 mb-2 font-semibold">{tr("session.scope_label")}</div>
                <div class="flex items-start gap-2 text-sm font-mono text-amber-12 bg-amber-1/30 px-2 py-1 rounded border border-amber-7/20 whitespace-normal break-all">
                  <HardDrive size={12} />
                  {props.activePermission?.patterns.join(", ")}
                </div>

                <Show when={Object.keys(props.activePermission?.metadata ?? {}).length > 0}>
                  <details class="mt-4 rounded-lg bg-gray-1/20 p-2">
                    <summary class="cursor-pointer text-xs text-gray-11">{tr("session.details")}</summary>
                    <pre class="mt-2 whitespace-pre-wrap break-words text-xs text-gray-12">
                      {props.safeStringify(props.activePermission?.metadata)}
                    </pre>
                  </details>
                </Show>
              </div>

              <div class="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  class="w-full border-red-7/20 text-red-11 hover:bg-red-1/30"
                  onClick={() =>
                    props.activePermission && props.respondPermission(props.activePermission.id, "reject")
                  }
                  disabled={props.permissionReplyBusy}
                >
                  {tr("session.deny")}
                </Button>
                <div class="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    class="text-xs"
                    onClick={() => props.activePermission && props.respondPermission(props.activePermission.id, "once")}
                    disabled={props.permissionReplyBusy}
                  >
                    {tr("session.once")}
                  </Button>
                  <Button
                    variant="primary"
                    class="text-xs font-bold bg-amber-7 hover:bg-amber-8 text-gray-12 border-none shadow-amber-6/20"
                    onClick={() =>
                      props.activePermission &&
                      props.respondPermissionAndRemember(props.activePermission.id, "always")
                    }
                    disabled={props.permissionReplyBusy}
                  >
                    {tr("session.allow_for_session")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <QuestionModal
        open={Boolean(props.activeQuestion)}
        questions={props.activeQuestion?.questions ?? []}
        busy={props.questionReplyBusy}
        onClose={() => { }}
        onReply={(answers) => {
          if (props.activeQuestion) {
            props.respondQuestion(props.activeQuestion.id, answers);
          }
        }}
      />

      <For each={flyouts()}>
        {(item) => <FlyoutItem item={item} />}
      </For>
    </div>
  );
}
