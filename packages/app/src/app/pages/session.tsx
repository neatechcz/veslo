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
import { AI_ACCESS_LOADING_MESSAGE } from "../lib/ai-access";

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
  VesloServerSettings,
  VesloServerStatus,
  VesloSoulStatus,
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
  resolveFolderAccessRequestFromPermission,
  selectedFolderContainsRequestedPath,
} from "../lib/folder-access-request";
import {
  createSessionClientMessageId,
  type MaterializedSessionHandoff,
  type SessionSendOptionsBase,
  type SessionSendOrigin,
} from "../lib/session-send-contract";
import type { UiConversationRef } from "../lib/ui-conversation-scope";
import { resolveEscapeStopShortcut } from "./session-shortcuts";
import { currentLocale, t } from "../../i18n";
import type { UpdateDownloadRetryInfo } from "../context/updater";

import MessageList, { type PendingMessageState } from "../components/session/message-list";
import Composer from "../components/session/composer";
import type { ComposerSendOptions } from "../components/session/composer";
import ComposerTargetPicker from "../components/session/composer-target-picker";
import QueuedMessageList from "../components/session/queued-message-list";
import { getEditableUserMessageDraft, type EditableUserMessageDraft } from "../components/session/message-editability";
import {
  createPendingSubmittedDraft,
  pendingSubmittedDraftToEditable,
  pendingSubmittedDraftToMessage,
} from "../components/session/pending-submit-model";
import {
  createPendingSessionInstanceId,
  isPendingSessionInstanceId,
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
} from "../components/session/session-queue-model.js";
import { shouldShowSessionLoadingState } from "../components/session/session-loading-state-model";
import type { SidebarSectionState } from "../components/session/sidebar";
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
import { openSessionWithWorkspaceActivation, type SessionBrowseScope } from "./session-navigation";
import type { WorkspaceActivationOptions } from "../context/workspace-types";
import { availableChatWidthForLayout, reconcileSidebarLayoutForRootWidth } from "./session-layout-width";
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
  resetRunStateRecord,
  resolveSessionIdForQueueKey,
  resolveSessionQueueKeyForSessionId,
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
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../i18n";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import { readSessionStatus } from "../lib/scoped-session-status";
import type { WorkspaceBusyMap } from "../context/workspace-debug";

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

type TempRuntimeUiRenderSurface = "workspace-initial" | "conversation";

type TempRuntimeUiRenderSource = {
  source: string;
  reason: string;
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
  soulStatusByWorkspaceId: Record<string, VesloSoulStatus | null>;
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
    },
  ) => Promise<boolean>;
  replaceUserMessageAsync: (
    messageId: string,
    draft: ComposerDraft,
    options: SessionSendOptionsBase & { targetSessionId?: string | null },
  ) => Promise<boolean>;
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
  archiveSession: (workspaceId: string, sessionId: string) => Promise<void> | void;
  unarchiveSession: (workspaceId: string, sessionId: string) => Promise<void> | void;
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
  reloadWorkspaceEngine: () => Promise<void>;
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
  busySessionByWorkspaceId?: WorkspaceBusyMap;
  historyUnavailable: SessionHistoryUnavailableView | null;
  historyUnavailableRetrying: boolean;
  retryUnavailableHistory: (sessionId: string) => Promise<void> | void;
  hasEarlierMessages: boolean;
  loadingEarlierMessages: boolean;
  loadEarlierMessages: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string, workspaceId?: string) => Promise<void>;
};

const SESSION_TOAST_DISMISS_DELAY_MS = 4_000;
const MAIN_THREAD_LAG_INTERVAL_MS = 200;
const MAIN_THREAD_LAG_WARN_MS = 180;
const interpolate = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );

export default function SessionView(props: SessionViewProps) {
  const tr = (key: string) => t(key, currentLocale());
  const formatTr = (key: string, values: Record<string, string | number>) =>
    interpolate(tr(key), values);
  let messagesEndEl: HTMLDivElement | undefined;
  let bottomVisibilityEl: HTMLDivElement | undefined;
  let chatContainerEl: HTMLDivElement | undefined;
  let sessionLayoutRootEl: HTMLDivElement | undefined;
  let scrollMessageIntoViewById: ((messageId: string, behavior?: ScrollBehavior) => boolean) | null = null;
  const [isChatContainerReady, setIsChatContainerReady] = createSignal(false);
  let sessionMenuRef: HTMLDivElement | undefined;
  let searchInputEl: HTMLInputElement | undefined;
  let sidebarLayoutResizeFrame: number | undefined;

  const [toastMessage, setToastMessage] = createSignal<string | null>(null);
  const [renameModalOpen, setRenameModalOpen] = createSignal(false);
  const [renameTitle, setRenameTitle] = createSignal("");
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
  const [historyActionBusy, setHistoryActionBusy] = createSignal<"undo" | "redo" | "compact" | null>(null);

  const [layoutRootWidth, setLayoutRootWidth] = createSignal(0);
  const [leftSidebarWidth, setLeftSidebarWidth] = createSignal(readLeftSidebarWidth());
  const [leftSidebarResizing, setLeftSidebarResizing] = createSignal(false);
  const [sidebarLayoutState, setSidebarLayoutState] = createSignal<SidebarLayoutState>(
    createInitialSidebarLayoutState(readGlobalSidebarDockedPrefs()),
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
      await props.reloadWorkspaceEngine();
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
  const centerColumnWidthClass = (wideWidth: string) =>
    createMemo(() => (useCompactCenterColumn() ? "max-w-full" : wideWidth));
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
    sidebarLayoutResizeFrame = window.requestAnimationFrame(() => {
      sidebarLayoutResizeFrame = undefined;
      const rootWidth = sessionLayoutRootEl?.clientWidth ?? 0;
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
    const measuredRootWidth = layoutRootWidth() || sessionLayoutRootEl?.clientWidth || 0;
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
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - initialX;
      setLeftSidebarWidth(clampLeftSidebarWidth(initialWidth + delta));
      queueSidebarRootMeasurement();
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
    const root = sessionLayoutRootEl;
    if (!root) return;

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        queueSidebarRootMeasurement();
      });
      observer.observe(root);
      queueSidebarRootMeasurement();
      onCleanup(() => {
        observer.disconnect();
        if (sidebarLayoutResizeFrame !== undefined) {
          window.cancelAnimationFrame(sidebarLayoutResizeFrame);
          sidebarLayoutResizeFrame = undefined;
        }
      });
      return;
    }

    const onResize = () => queueSidebarRootMeasurement();
    window.addEventListener("resize", onResize);
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
  const composerResetKey = createMemo(() =>
    `${props.activeComposerTargetId ?? "__no-target"}:${props.selectedSessionId ?? "__no-session"}`
  );
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
  const statusForQueueKey = (sessionKey: string, statuses: Record<string, string>) => {
    const sessionId = sessionIdForQueueKey(sessionKey);
    if (!sessionId) return "idle";
    return readSessionStatus(statuses, workspaceIdForQueueKey(sessionKey), sessionId);
  };
  const statusForSessionId = (sessionId: string, statuses: Record<string, string>) =>
    readSessionStatus(statuses, workspaceIdForSessionQueue(sessionId), sessionId);
  const [pendingQueueKeyAwaitingSessionIdByBaseKey, setPendingQueueKeyAwaitingSessionIdByBaseKey] =
    createSignal<Record<string, string>>({});
  const currentSessionQueueKey = createMemo(() => {
    return resolveCurrentSessionQueueKey({
      ...queueKeyContext(),
      selectedSessionId: props.selectedSessionId,
      pendingQueueKeyAwaitingSessionIdByBaseKey: pendingQueueKeyAwaitingSessionIdByBaseKey(),
    });
  });
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
  const createTempRuntimeUiRenderSnapshot = (
    source: string,
    reason: string,
    extras: Pick<Partial<TempRuntimeUiRenderSource>, "clientMessageId" | "origin" | "detail"> = {},
  ): TempRuntimeUiRenderSource => ({
    source,
    reason,
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
    ...extras,
    at: Date.now(),
  });
  // TEMP: runtime UI flicker diagnostic. Remove after duplicated workspace/conversation render handoff is identified.
  const [tempRuntimeUiRenderSource, setTempRuntimeUiRenderSource] = createSignal<TempRuntimeUiRenderSource>(
    createTempRuntimeUiRenderSnapshot("SessionView.initialRender", "component-created"),
  );
  const markTempRuntimeUiRenderSource = (
    source: string,
    reason: string,
    extras: Pick<Partial<TempRuntimeUiRenderSource>, "clientMessageId" | "origin" | "detail"> = {},
  ) => {
    if (!props.developerMode) return;
    setTempRuntimeUiRenderSource(createTempRuntimeUiRenderSnapshot(source, reason, extras));
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
  const messagePartMessageIds = (message: MessageWithParts) =>
    message.parts
      .map((part) => {
        const messageID = (part as { messageID?: string | number }).messageID;
        return typeof messageID === "string" ? messageID : typeof messageID === "number" ? String(messageID) : "";
      })
      .filter(Boolean);
  const submittedDraftHasMessageInTranscript = (submitted: ReturnType<typeof optimisticSubmittedDraft>) => {
    if (!submitted) return false;
    const clientMessageId = submitted.clientMessageId.trim();
    if (clientMessageId) {
      const matchedById = props.messages.some((message) => {
        if ((message.info as { role?: string }).role !== "user") return false;
        if (messageIdFromInfo(message) === clientMessageId) return true;
        return messagePartMessageIds(message).some((messageID) => messageID === clientMessageId);
      });
      if (matchedById) return true;
    }

    const text = (submitted.draft.resolvedText ?? submitted.draft.text).trim();
    if (!text) return false;
    const baselineIds = new Set(submitted.transcriptMessageIdsAtSubmit ?? []);
    return props.messages.some((message) => {
      if ((message.info as { role?: string }).role !== "user") return false;
      const messageId = messageIdFromInfo(message);
      if (messageId && baselineIds.has(messageId)) return false;
      return message.parts.some((part) => part.type === "text" && (part.text ?? "").trim() === text);
    });
  };
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
  const resetRunState = (sessionKey = currentSessionQueueKey(), reason = "reset") => {
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
    recordSendTrace("run-state:has-begun", {
      sessionKey,
      hasBegun,
    });
    updateRunStateForSessionKey(sessionKey, (current) => ({ ...current, hasBegun }));
  };
  const setRunTickForSessionKey = (sessionKey: string, tick: number) => {
    updateRunStateForSessionKey(sessionKey, (current) => ({ ...current, tick }));
  };
  const setRunLastProgressAtForSessionKey = (sessionKey: string, lastProgressAt: number | null) => {
    updateRunStateForSessionKey(sessionKey, (current) => ({ ...current, lastProgressAt }));
  };
  const remapPendingRunStateToSession = (pendingKey: string, sessionId: string) => {
    const sessionKey = sessionQueueKeyForSessionId(sessionId);
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

  const optimisticSubmittedMessage = createMemo<MessageWithParts | null>(() => {
    const submitted = optimisticSubmittedDraft();
    if (!submitted) return null;
    if (submitted.sessionKey !== currentSessionQueueKey()) return null;
    return pendingSubmittedDraftToMessage(submitted, props.activeWorkspaceRoot);
  });
  createEffect(() => {
    const submitted = optimisticSubmittedDraft();
    if (!submitted || submitted.state !== "sending") return;
    if (!submittedDraftHasMessageInTranscript(submitted)) return;
    setPendingSubmittedDraftBySessionKey((current) =>
      removePendingSubmittedDraftForKey(current, submitted.sessionKey, submitted.id),
    );
  });

  const pendingMessageStateById = createMemo<Record<string, PendingMessageState>>(() => {
    const submitted = optimisticSubmittedDraft();
    if (!submitted) return {};
    if (submitted.sessionKey !== currentSessionQueueKey()) return {};
    if (submitted.state !== "error") return {};
    return {
      [submitted.id]: { state: submitted.state, error: submitted.error },
    };
  });

  const totalPartCount = createMemo(() => props.messages.reduce((total, message) => total + message.parts.length, 0));

  const transcriptViewport = createSessionTranscriptViewport({
    messages: () => props.messages,
    optimisticSubmittedMessage,
    searchActive,
    sessionStatus: () => props.sessionStatus,
    developerMode: () => props.developerMode,
    selectedSessionId: () => props.selectedSessionId,
    hasEarlierMessages: () => props.hasEarlierMessages,
    isChatContainerReady,
    totalPartCount,
    loadEarlierMessages: props.loadEarlierMessages,
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
    shouldShowSessionLoadingState({
      hasWorkspaceSetupEmptyState: showWorkspaceSetupEmptyState(),
      selectedSessionId: props.selectedSessionId,
      messageCount: effectiveRenderedMessages().length,
      loadingEarlierMessages: props.loadingEarlierMessages,
    })
  );
  const showComposerEntryState = createMemo(() =>
    effectiveRenderedMessages().length === 0 &&
    !composerEntryDismissed() &&
    !showWorkspaceSetupEmptyState() &&
    !showSessionLoadingState(),
  );
  const showFooterComposerTargetContext = createMemo(() =>
    !props.selectedSessionId &&
    !composerEntryDismissed(),
  );
  createEffect(() => {
    const effectiveMessageCount = effectiveRenderedMessages().length;
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
    const interval = window.setInterval(() => {
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
        renderedMessageCount: effectiveRenderedMessages().length,
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
  const [queuePausedAfterStopBySessionKey, setQueuePausedAfterStopBySessionKey] = createSignal<Record<string, boolean>>({});
  const [editingQueuedDraftId, setEditingQueuedDraftId] = createSignal<string | null>(null);
  const [editingTranscriptMessageId, setEditingTranscriptMessageId] = createSignal<string | null>(null);
  const [abortBusy, setAbortBusy] = createSignal(false);
  const [escapeStopConfirmationPending, setEscapeStopConfirmationPending] = createSignal(false);
  const [todoExpanded, setTodoExpanded] = createSignal(false);
  let escapeStopConfirmationSessionId = props.selectedSessionId;

  const queuedDrafts = createMemo(() => queuedDraftsBySessionKey()[currentSessionQueueKey()] ?? []);
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

  const remapPendingQueueToSession = (pendingKey: string, sessionId: string) => {
    const sessionKey = sessionQueueKeyForSessionId(sessionId);
    if (!pendingKey || pendingKey === sessionKey) return;

    setQueuedDraftsBySessionKey((current) =>
      remapPendingQueueToSessionRecord(current, pendingKey, sessionKey),
    );

    setQueuePausedAfterStopBySessionKey((current) =>
      remapQueuePausedToSession(current, pendingKey, sessionKey),
    );

    remapPendingRunStateToSession(pendingKey, sessionId);

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

  const restoreMaterializedQueueToPending = (pendingKey: string, sessionId: string | null | undefined) => {
    const materializedSessionId = sessionId?.trim();
    if (!pendingKey || !materializedSessionId) return;
    const sessionKey = sessionQueueKeyForSessionId(materializedSessionId);
    if (pendingKey === sessionKey) return;

    setQueuedDraftsBySessionKey((current) =>
      restoreMaterializedQueueToPendingRecord(current, pendingKey, sessionKey),
    );

    setQueuePausedAfterStopBySessionKey((current) =>
      restoreQueuePausedToPending(current, pendingKey, sessionKey),
    );
  };

  const appendDraftToCurrentQueue = (draft: ComposerDraft) => {
    updateCurrentQueue((queue) => appendQueuedDraft(queue, draft));
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

  const runPhase = createMemo(() => {
    if (props.error && (runStartedAt() !== null || runHasBegun())) return "error";
    const status = props.sessionStatus;
    const started = runStartedAt() !== null;
    if (status === "idle") {
      if (!started) return "idle";
      if (optimisticSubmittedDraft()) return "responding";
      if (responseStarted()) return "responding";
      return "sending";
    }
    if (status === "retry") return responseStarted() ? "responding" : "retrying";
    if (responseStarted()) return "responding";
    return "thinking";
  });

  const showRunIndicator = createMemo(() => runPhase() !== "idle");
  const showFooterRunIndicator = createMemo(() => showRunIndicator());
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
      const record = part as any;
      const tool = typeof record.tool === "string" ? record.tool : "";
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
      const text = cleanReasoning(typeof (part as any).text === "string" ? (part as any).text : "");
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
      const text = typeof (part as any).text === "string" ? (part as any).text : "";
      return `${part.type}:${text.length}:${text.slice(-48)}:parts:${partTotal}:todos:${props.todos.length}`;
    }

    if (part.type === "tool") {
      const state = (part as any).state ?? {};
      const status = typeof state.status === "string" ? state.status : "";
      const outputSize =
        typeof state.output === "string"
          ? state.output.length
          : Array.isArray(state.output)
            ? state.output.length
            : 0;
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

  const runElapsedLabel = createMemo(() => `${Math.round(runElapsedMs()).toLocaleString()}ms`);

  onMount(() => {
    setTimeout(() => setIsInitialLoad(false), 2000);
  });

  createEffect(
    on(
      () => props.selectedSessionId,
      (sessionId, previousSessionId) => {
        if (sessionId === previousSessionId) {
          return;
        }
        markTempRuntimeUiRenderSource(
          "SessionView.selectedSessionIdEffect",
          sessionId ? "selected-session-changed" : "selected-session-cleared",
          { detail: `previous=${previousSessionId ?? "none"}` },
        );
        setSearchQuery("");
        closeSearch();

        const pendingBaseKey = pendingSessionQueueKey();
        const pendingKey = !previousSessionId
          ? pendingQueueKeyAwaitingSessionIdByBaseKey()[pendingBaseKey] ?? null
          : null;
        const previousSessionKey = previousSessionId ? sessionQueueKeyForSessionId(previousSessionId) : null;
        // Switching sessions is navigation, not a runtime lifecycle operation:
        // preserve the previous keyed run UI state and let scoped runtime
        // status clear it when that conversation actually becomes idle.
        if (!pendingKey && previousSessionKey) {
          preserveRunStateOnSessionSwitch(previousSessionKey);
        }
        conversationFlow.handleSessionSwitchEditState(previousSessionId);

        if (!sessionId) return;
        const materializedPendingSubmit =
          pendingKey ? pendingSubmittedDraftBySessionKey()[pendingKey]?.state === "sending" : false;
        if (pendingKey && !isPendingSessionInstanceId(sessionId)) {
          remapPendingQueueToSession(pendingKey, sessionId);
          clearPendingQueueKeyAwaitingSessionIdForBaseKey(pendingBaseKey, pendingKey);
        }
        const sessionKey = sessionQueueKeyForSessionId(sessionId);
        if (
          !materializedPendingSubmit &&
          statusForSessionId(sessionId, props.sessionStatusById) === "idle" &&
          !queuePausedForSessionKey(sessionKey)
        ) {
          void drainNextQueuedDraft("queue-drain", sessionKey);
        }
        transcriptViewport.markSelectedSessionForInitialAnchor(sessionId);
      },
    ),
  );

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
    if (status === "running" || status === "retry") {
      const sessionKey = currentSessionQueueKey();
      startRun(sessionKey);
      setRunHasBegunForSessionKey(sessionKey, true);
    }
  });

  createEffect(
    on(
      () => props.sessionStatus,
      (status, previousStatus) => {
        if (previousStatus === undefined || previousStatus === "idle" || status !== "idle") return;
        const sessionKey = currentSessionQueueKey();
        if (queuePausedForSessionKey(sessionKey)) return;
        void drainNextQueuedDraft("queue-drain", sessionKey);
      },
    ),
  );

  createEffect(
    on(
      () => props.sessionStatusById,
      (statuses, previousStatuses) => {
        if (!previousStatuses) return;
        for (const sessionKey of Object.keys(queuedDraftsBySessionKey())) {
          const sessionId = sessionIdForQueueKey(sessionKey);
          if (!sessionId) continue;
          if (statusForQueueKey(sessionKey, previousStatuses) === "idle") continue;
          if (statusForQueueKey(sessionKey, statuses) !== "idle") continue;
          if (queuePausedForSessionKey(sessionKey)) continue;
          void drainNextQueuedDraft("queue-drain", sessionKey);
        }
        for (const [sessionKey, runState] of Object.entries(untrack(runStateBySessionKey))) {
          if (!runState.startedAt && !runState.hasBegun) continue;
          const sessionId = sessionIdForQueueKey(sessionKey);
          if (!sessionId) continue;
          const previousStatus = statusForQueueKey(sessionKey, previousStatuses);
          const status = statusForQueueKey(sessionKey, statuses);
          if (!isActiveRunStatus(previousStatus) || isActiveRunStatus(status)) continue;
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
    if (props.sessionStatus === "idle" && (runHasBegun() || responseStarted())) {
      resetRunState(currentSessionQueueKey());
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
    const timer = setTimeout(() => {
      if (
        runStartedAt() &&
        props.sessionStatus === "idle" &&
        optimisticSubmittedDraft()?.state !== "sending" &&
        !runHasBegun() &&
        !responseStarted()
      ) {
        resetRunState(currentSessionQueueKey());
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
    await conversationFlow.cancelRun();
  };

  const retryRun = async () => {
    await conversationFlow.retryRun();
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

  const deleteSessionTargetId = createMemo(() => deleteSessionTarget()?.sessionId ?? props.selectedSessionId ?? null);
  const deleteSessionTargetTitle = createMemo(() => sessionTitleById(deleteSessionTargetId()));

  const renameCanSave = createMemo(() => {
    if (renameBusy()) return false;
    const next = renameTitle().trim();
    if (!next) return false;
    return next !== selectedSessionTitle().trim();
  });

  const openRenameModal = () => {
    setSessionMenuOpen(false);
    if (!props.selectedSessionId) {
      setToastMessage(tr("session.no_session_selected_toast"));
      return;
    }
    setRenameTitle(selectedSessionTitle());
    setRenameModalOpen(true);
  };

  const closeRenameModal = () => {
    if (renameBusy()) return;
    setRenameModalOpen(false);
  };

  const submitRename = async () => {
    const sessionId = props.selectedSessionId;
    if (!sessionId) return;
    const next = renameTitle().trim();
    if (!next || !renameCanSave()) return;
    setRenameBusy(true);
    try {
      await props.renameSession(sessionId, next);
      setRenameModalOpen(false);
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

  const aiAccessLoading = createMemo(() => props.aiAccessBlockedReason === AI_ACCESS_LOADING_MESSAGE);

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
      clearComposerDraftForSession: props.clearComposerDraftForSession,
      currentDraftMode: () => props.composerDraft.mode,
      setComposerDraft: props.setComposerDraft,
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
      retryLastPrompt: props.retryLastPrompt,
      runPhase,
      setAbortBusy,
      setEscapeStopConfirmationPending,
    },
    runState: {
      resetRunState,
      showRunIndicator,
      startRun,
    },
    viewport: {
      scheduleScrollToLatest,
      setStickToBottom,
    },
    transport: {
      replaceUserMessageAsync: (messageId, draft, options) =>
        props.replaceUserMessageAsync(messageId, draft, options),
      sendPromptAsync: (draft, options) => props.sendPromptAsync(draft, options),
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
  const drainNextQueuedDraft = conversationFlow.drainNextQueuedDraft;

  const handleEditQueuedDraft = (id: string) => {
    conversationFlow.handleEditQueuedDraft(id);
  };

  const handleCancelQueuedDraft = (id: string) => {
    conversationFlow.handleCancelQueuedDraft(id);
  };

  const handleMoveQueuedDraft = (id: string, targetIndex: number) => {
    conversationFlow.handleMoveQueuedDraft(id, targetIndex);
  };

  const handleEditUserMessage = (editable: EditableUserMessageDraft) => {
    conversationFlow.handleEditUserMessage(editable);
  };

  const handleSendPrompt = async (draft: ComposerDraft, options: ComposerSendOptions = {}) => {
    recordSendTrace("handleSendPrompt:start", {
      sendTraceId: options.sendTraceId ?? null,
      sendNow: options.sendNow,
      source: options.source,
      editingQueuedDraftId: editingQueuedDraftId(),
      queuePaused: queuePaused(),
      showRunIndicator: showRunIndicator(),
    });
    if (showComposerEntryState() || showFooterComposerTargetContext()) {
      dismissComposerEntryForSessionKey();
    }
    return conversationFlow.handleSendPrompt(draft, {
      sendNow: options.sendNow,
      sendTraceId: options.sendTraceId,
    });
  };

  const tempRuntimeUiDiagnosticBadge = (visibleSurface: TempRuntimeUiRenderSurface) => (
    <Show when={props.developerMode}>
      <div
        class="mb-3 rounded-lg border border-red-7/30 bg-red-1/80 px-3 py-2 font-mono text-[10px] leading-4 text-red-12"
        data-temp-runtime-ui-render-source={visibleSurface}
      >
        TEMP UI render source: {tempRuntimeUiRenderSource().source} | reason: {tempRuntimeUiRenderSource().reason} |
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

  const openSessionFromList = (workspaceId: string, sessionId: string) => {
    const group = props.workspaceSessionGroups.find((g) => g.workspace.id === workspaceId);
    const workspaceRoot =
      group?.workspace.directory?.trim() ||
      group?.workspace.path?.trim() ||
      "";

    const session = group?.sessions.find((s) => s.id === sessionId);
    const openRealSession = (nextSessionId: string) => {
      props.setSessionBrowseScope({
        sessionId: nextSessionId,
        workspaceId,
        workspaceRoot: workspaceRoot,
        directory: session?.directory ?? workspaceRoot,
        conversationId: session?.conversationId ?? null,
        opencodeSessionId: session?.opencodeSessionId ?? nextSessionId,
      });
      void Promise.resolve(props.selectSession(nextSessionId))
        .catch((error) => reportError(error, "session.openSessionFromList.selectSession"));
      props.setView("session", nextSessionId);
    };

    if (isPendingSessionInstanceId(sessionId)) {
      const openPendingSidebarSession = (nextSessionId: string) => {
        props.setSessionBrowseScope({
          sessionId: nextSessionId,
          workspaceId,
          workspaceRoot,
          directory: session?.directory ?? workspaceRoot,
          conversationId: null,
          opencodeSessionId: null,
        });
        props.setView("session", nextSessionId);
      };

      void openSessionWithWorkspaceActivation({
        activeWorkspaceId: props.activeWorkspaceId,
        getActiveWorkspaceId: () => props.activeWorkspaceId,
        workspaceId,
        sessionId,
        activateWorkspace: props.activateWorkspace,
        activateWorkspaceBeforeOpen: true,
        openSession: openPendingSidebarSession,
      }).catch((error) => reportError(error, "session.openPendingSessionFromList"));
      return;
    }

    void openSessionWithWorkspaceActivation({
      activeWorkspaceId: props.activeWorkspaceId,
      getActiveWorkspaceId: () => props.activeWorkspaceId,
      workspaceId,
      sessionId,
      activateWorkspace: props.activateWorkspace,
      // Route-driven selection handles normal id changes. Also select
      // explicitly after recording the browse scope because the user can
      // return to the same /session/:id route after switching projects; in
      // that case the route effect is deduped and would leave the main
      // transcript on the empty workspace screen.
      openSession: openRealSession,
    })
      .catch((error) => reportError(error, "session.openSessionFromList"));
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
      class="flex h-screen w-full bg-dls-sidebar text-gray-12 font-sans overflow-hidden"
    >
      <TitlebarMenuToggles
        leftActive={leftSidebarToggleActive()}
        rightActive={rightSidebarToggleActive()}
        centerContent={sessionTitlebarContext()}
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
          pendingPermissionCountByWs: props.pendingPermissionCountByWs,
          allowSelectedParentExpansion: true,
          sessionStatusById: props.sessionStatusById,
          busySessionByWorkspaceId: props.busySessionByWorkspaceId,
          connectingWorkspaceId: props.connectingWorkspaceId,
          workspaceConnectionStateById: props.workspaceConnectionStateById,
          readyEngineWorkspaceIds: props.readyEngineWorkspaceIds,
          newTaskDisabled: props.newTaskDisabled,
          importingWorkspaceConfig: props.importingWorkspaceConfig,
          showRemoteActions: props.showRemoteActions,
          soulStatusByWorkspaceId: props.soulStatusByWorkspaceId,
          isPrivateWorkspacePath: props.isPrivateWorkspacePath,
          onActivateWorkspace: props.activateWorkspace,
          onOpenSession: openSessionFromList,
          onDeleteSession: openDeleteSessionModalForSession,
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
          vesloServerStatus: props.vesloServerStatus,
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
        <Show when={props.showSkillReloadBanner}>
          <div class="border-b border-amber-6/50 bg-amber-2/70 px-6 py-3">
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
                  onClick={props.dismissReloadBanner}
                >
                  {tr("reload.toast_dismiss")}
                </button>
              </div>
            </div>
          </div>
        </Show>
        )}
        transcript={(
        <div class="flex-1 flex overflow-hidden">
          <div class="flex-1 min-w-0 relative overflow-hidden bg-gray-1">
            <div
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
                        busy={props.busy}
                        isStreaming={showRunIndicator()}
                        stopShortcutConfirmPending={escapeStopConfirmationPending()}
                        compactWidth={useCompactCenterColumn()}
                        onSend={handleSendPrompt}
                        onStop={cancelRun}
                        onDraftChange={handleDraftChange}
                        selectedAgent={props.selectedSessionAgent}
                        onSelectAgent={(agent) => {
                          applySessionAgent(agent);
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
            messages={effectiveRenderedMessages()}
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
                      <span class="truncate">{(runPhase() === "error" && props.error) ? props.error : (thinkingStatus() || runLabel())}</span>
                      <Show when={props.developerMode}>
                        <span class="text-[10px] text-gray-8 ml-auto shrink-0">{runElapsedLabel()}</span>
                      </Show>
                    </div>
                  </div>
                </div>
              ) : undefined
            }
          />

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
      <Show when={!showWorkspaceSetupEmptyState() && !showComposerEntryState()}>
        <>
              <Show when={props.aiAccessBlockedReason}>
                <div class="mx-auto mb-3 w-full max-w-[min(100%,72rem)] rounded-2xl border border-amber-7/30 bg-amber-2/30 px-4 py-3 text-sm text-amber-12">
                  {props.aiAccessBlockedReason}
                </div>
              </Show>
              <Show when={queuedDrafts().length > 0}>
                <div class={`mx-auto mb-2 w-full ${railWidthClass()}`}>
                  <QueuedMessageList
                    items={queuedDrafts()}
                    onEdit={handleEditQueuedDraft}
                    onCancel={handleCancelQueuedDraft}
                    onMove={handleMoveQueuedDraft}
                  />
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
                busy={props.busy || aiAccessLoading()}
                isStreaming={showRunIndicator()}
                stopShortcutConfirmPending={escapeStopConfirmationPending()}
                compactTopSpacing={todoCount() > 0}
                compactWidth={useCompactCenterColumn()}
                onSend={handleSendPrompt}
                onStop={cancelRun}
                onDraftChange={handleDraftChange}
                selectedAgent={props.selectedSessionAgent}
                onSelectAgent={(agent) => {
                  applySessionAgent(agent);
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
