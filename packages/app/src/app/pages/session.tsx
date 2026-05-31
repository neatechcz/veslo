import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Agent, Part } from "@opencode-ai/sdk/v2/client";
import type {
  ArtifactItem,
  DashboardTab,
  ComposerDraft,
  MessageGroup,
  MessageWithParts,
  McpServerEntry,
  McpStatusMap,
  PendingPermission,
  PendingQuestion,
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
  type EngineInfo,
  type VesloServerInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { acquireBlankNativeWindowTitleLease } from "../lib/native-window-title-lease";

import {
  Box,
  ChevronDown,
  Check,
  Circle,
  Cpu,
  HeartPulse,
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
  Zap,
} from "lucide-solid";

import Button from "../components/button";
import ConfirmModal from "../components/confirm-modal";
import RenameSessionModal from "../components/rename-session-modal";
import ShareWorkspaceModal from "../components/share-workspace-modal";
import SidebarStatusControls from "../components/sidebar-status-controls";
import SidebarAdvancedNav from "../components/session/sidebar-advanced-nav";
import SidebarDashboardNav from "../components/session/sidebar-dashboard-nav";
import {
  buildVesloConnectInviteUrl,
  buildVesloWorkspaceBaseUrl,
  createVesloServerClient,
  parseVesloWorkspaceIdFromUrl,
} from "../lib/veslo-server";
import type {
  VesloServerClient,
  VesloServerSettings,
  VesloServerStatus,
  VesloSoulStatus,
  VesloWorkspaceExport,
} from "../lib/veslo-server";
import { DEFAULT_VESLO_PUBLISHER_BASE_URL, publishVesloBundleJson } from "../lib/publisher";
import { join } from "@tauri-apps/api/path";
import {
  isUserVisiblePart,
  isTauriRuntime,
  isWindowsPlatform,
  normalizeDirectoryPath,
  parseTemplateFrontmatter,
} from "../utils";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
import { normalizeLocalFilePath } from "../lib/local-file-path";
import { shouldStopRunOnEscape } from "./session-shortcuts";
import { currentLocale, t } from "../../i18n";

import browserSetupTemplate from "../data/commands/browser-setup.md?raw";
import soulSetupTemplate from "../data/commands/give-me-a-soul.md?raw";

import MessageList, { type PendingMessageState } from "../components/session/message-list";
import Composer from "../components/session/composer";
import type { ComposerSendOptions } from "../components/session/composer";
import QueuedMessageList from "../components/session/queued-message-list";
import { getEditableUserMessageDraft, type EditableUserMessageDraft } from "../components/session/message-editability";
import {
  createPendingSubmittedDraft,
  markPendingSubmittedFailed,
  pendingSubmittedDraftToEditable,
  pendingSubmittedDraftToMessage,
  remapPendingSubmittedSession,
  type PendingSubmittedDraft,
} from "../components/session/pending-submit-model";
import {
  appendQueuedDraft,
  firstQueuedDraft,
  markQueuedDraftEditing,
  markQueuedDraftError,
  markQueuedDraftQueued,
  markQueuedDraftSending,
  moveQueuedDraft,
  removeQueuedDraft,
  resolveQueuedDraftSessionKey,
  updateQueuedDraft,
  type QueuedDraft,
} from "../components/session/session-queue-model.js";
import WorkspaceSessionList from "../components/session/workspace-session-list";
import { shouldShowSessionLoadingState } from "../components/session/session-loading-state-model";
import type { SidebarSectionState } from "../components/session/sidebar";
import TitlebarMenuToggles from "../components/titlebar-menu-toggles";
import {
  clampLeftSidebarWidth,
  readLeftSidebarWidth,
  writeLeftSidebarWidth,
} from "../components/layout/left-sidebar-width-prefs";
import {
  createInitialSidebarLayoutState,
  toggleSidebarFromButton,
  type SidebarDockedVisibility,
  type SidebarLayoutState,
  type SidebarSide,
} from "../components/session/sidebar-layout-model";
import FlyoutItem from "../components/flyout-item";
import QuestionModal from "../components/question-modal";
import ArtifactsPanel from "../components/session/artifacts-panel";
import type { ArtifactFamily } from "../components/session/artifact-family-model";
import SessionCapabilitiesPanel from "../components/session/session-capabilities-panel";
import type { SessionCapabilitiesSnapshot } from "../lib/session-capabilities";
import { openSessionWithWorkspaceActivation } from "./session-navigation";
import { availableChatWidthForLayout, reconcileSidebarLayoutForRootWidth } from "./session-layout-width";
import { resolveSessionTitlebarContext } from "./session-titlebar-context";
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../i18n";

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
  } catch {
    // ignore
  }
}

export type SessionViewProps = {
  selectedSessionId: string | null;
  activePendingDraftKey: string | null;
  setView: (view: View, sessionId?: string) => void;
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  onOpenFeedback: () => void;
  activeWorkspaceDisplay: WorkspaceDisplay;
  activeWorkspaceRoot: string;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  recoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean;
  editWorkspaceConnection: (workspaceId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
  soulStatusByWorkspaceId: Record<string, VesloSoulStatus | null>;
  openCreateWorkspace: () => void;
  openCreateRemoteWorkspace: () => void;
  openNewSessionWithDirectory: () => void;
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
  } | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  updateAutoDownload: boolean;
  anyActiveRuns: boolean;
  downloadUpdate: () => void;
  installUpdateAndRestart: () => void;
  createSessionAndOpen: () => Promise<string | undefined>;
  sendPromptAsync: (draft: ComposerDraft, options?: { targetSessionId?: string | null }) => Promise<boolean>;
  replaceUserMessageAsync: (
    messageId: string,
    draft: ComposerDraft,
    options?: { targetSessionId?: string | null },
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
  pendingSessionLoad: { sessionId: string; workspaceId: string; sessionTitle: string; workspaceName: string } | null;
  setPendingSessionLoad: (
    value: { sessionId: string; workspaceId: string; sessionTitle: string; workspaceName: string } | null
  ) => void;
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
  hasEarlierMessages: boolean;
  loadingEarlierMessages: boolean;
  loadEarlierMessages: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string, workspaceId?: string) => Promise<void>;
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

const BROWSER_AUTOMATION_QUICKSTART_PROMPT = (() => {
  const parsed = parseTemplateFrontmatter(browserSetupTemplate);
  return (parsed?.body ?? browserSetupTemplate).trim();
})();

const SOUL_SETUP_TEMPLATE = (() => {
  const parsed = parseTemplateFrontmatter(soulSetupTemplate);
  const name = parsed?.data?.name?.trim() || "give-me-a-soul";
  const description =
    parsed?.data?.description?.trim() ||
    "Enable optional soul mode with persistent memory and scheduled check-ins";
  const body = (parsed?.body ?? soulSetupTemplate).trim();
  return { name, description, body };
})();

const INITIAL_MESSAGE_WINDOW = 140;
const MESSAGE_WINDOW_LOAD_CHUNK = 120;
const MAX_SEARCH_MESSAGE_CHARS = 4_000;
const MAX_SEARCH_HITS = 2_000;
const SESSION_TOAST_DISMISS_DELAY_MS = 4_000;
const STREAM_SCROLL_MIN_INTERVAL_MS = 90;
const STREAM_RENDER_BATCH_MS = 220;
const MAIN_THREAD_LAG_INTERVAL_MS = 200;
const MAIN_THREAD_LAG_WARN_MS = 180;
const SIDEBAR_DOCKED_VISIBILITY_KEY = "veslo.global.sidebar.docked.v1";
const LEGACY_SIDEBAR_DOCKED_VISIBILITY_KEY = "veslo.session.sidebar.docked.v1";
const DEFAULT_SIDEBAR_DOCKED_VISIBILITY: SidebarDockedVisibility = {
  left: true,
  right: true,
};
const interpolate = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );

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

type CommandPaletteMode = "root" | "sessions";

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
  let scrollFrame: number | undefined;
  let trailingAutoScrollTimer: number | undefined;
  let pendingScrollBehavior: ScrollBehavior = "auto";
  let lastAutoScrollAt = 0;
  let streamRenderBatchTimer: number | undefined;
  let streamRenderBatchQueuedAt = 0;
  let streamRenderBatchReschedules = 0;
  const topInitializedSessionIds = new Set<string>();

  const [toastMessage, setToastMessage] = createSignal<string | null>(null);
  const [renameModalOpen, setRenameModalOpen] = createSignal(false);
  const [renameTitle, setRenameTitle] = createSignal("");
  const [renameBusy, setRenameBusy] = createSignal(false);

  const [sessionMenuOpen, setSessionMenuOpen] = createSignal(false);
  const [deleteSessionOpen, setDeleteSessionOpen] = createSignal(false);
  const [deleteSessionBusy, setDeleteSessionBusy] = createSignal(false);
  const [deleteSessionTarget, setDeleteSessionTarget] = createSignal<{
    sessionId: string;
    workspaceId: string | null;
  } | null>(null);
  const [nearBottom, setNearBottom] = createSignal(true);
  const [stickToBottom, setStickToBottom] = createSignal(true);
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchQueryDebounced, setSearchQueryDebounced] = createSignal("");
  const [activeSearchHitIndex, setActiveSearchHitIndex] = createSignal(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = createSignal(false);
  const [commandPaletteMode, setCommandPaletteMode] = createSignal<CommandPaletteMode>("root");
  const [commandPaletteQuery, setCommandPaletteQuery] = createSignal("");
  const [commandPaletteActiveIndex, setCommandPaletteActiveIndex] = createSignal(0);
  const [historyActionBusy, setHistoryActionBusy] = createSignal<"undo" | "redo" | "compact" | null>(null);
  const [messageWindowStart, setMessageWindowStart] = createSignal(0);
  const [messageWindowSessionId, setMessageWindowSessionId] = createSignal<string | null>(null);
  const [messageWindowExpanded, setMessageWindowExpanded] = createSignal(false);
  const [initialAnchorPending, setInitialAnchorPending] = createSignal(false);

  const [layoutRootWidth, setLayoutRootWidth] = createSignal(0);
  const [leftSidebarWidth, setLeftSidebarWidth] = createSignal(readLeftSidebarWidth());
  const [leftSidebarResizing, setLeftSidebarResizing] = createSignal(false);
  const [sidebarLayoutState, setSidebarLayoutState] = createSignal<SidebarLayoutState>(
    createInitialSidebarLayoutState(readSidebarDockedVisibility()),
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
        writeSidebarDockedVisibility(toggled.dockedPreference);
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
  const todoList = createMemo(() => props.todos.filter((todo) => todo.content.trim()));
  const todoCount = createMemo(() => todoList().length);
  const todoCompletedCount = createMemo(() =>
    todoList().filter((todo) => todo.status === "completed").length
  );
  const hasWorkspaceConfigured = createMemo(() => props.workspaces.length > 0);
  const showWorkspaceSetupEmptyState = createMemo(
    () => !hasWorkspaceConfigured() && !props.selectedSessionId && props.messages.length === 0,
  );
  const showSessionLoadingState = createMemo(() =>
    shouldShowSessionLoadingState({
      hasWorkspaceSetupEmptyState: showWorkspaceSetupEmptyState(),
      hasPendingSessionLoad: Boolean(props.pendingSessionLoad),
      selectedSessionId: props.selectedSessionId,
      messageCount: props.messages.length,
      loadingEarlierMessages: props.loadingEarlierMessages,
    })
  );
  const sessionWorkspaceContextLabel = createMemo(() => {
    if (showWorkspaceSetupEmptyState()) return "";
    if (props.activeWorkspaceDisplay.workspaceType !== "local") return "";
    if (!props.activeWorkspaceRoot.trim()) return "";
    return props.canChooseSessionFolder ? tr("sidebar.private_workspace") : workspaceLabel(props.activeWorkspaceDisplay);
  });

  const commandPaletteSessionOptions = createMemo(() => {
    const out: Array<{
      workspaceId: string;
      sessionId: string;
      title: string;
      workspaceTitle: string;
      updatedAt: number;
      searchText: string;
    }> = [];

    for (const group of props.workspaceSessionGroups) {
      const workspaceId = group.workspace.id?.trim() ?? "";
      if (!workspaceId) continue;
      const workspaceTitle = workspaceLabel(group.workspace);
      for (const session of group.sessions) {
        const sessionId = session.id?.trim() ?? "";
        if (!sessionId) continue;
        const title = session.title?.trim() || tr("session.untitled");
        const slug = session.slug?.trim() ?? "";
        const updatedAt = session.time?.updated ?? session.time?.created ?? 0;
        out.push({
          workspaceId,
          sessionId,
          title,
          workspaceTitle,
          updatedAt,
          searchText: [title, workspaceTitle, slug].join(" ").toLowerCase(),
        });
      }
    }

    out.sort((a, b) => {
      const aActive = a.workspaceId === props.activeWorkspaceId;
      const bActive = b.workspaceId === props.activeWorkspaceId;
      if (aActive !== bActive) return aActive ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });

    return out;
  });

  const totalSessionCount = createMemo(() => commandPaletteSessionOptions().length);

  type SearchHit = {
    messageId: string;
  };

  type CommandPaletteItem = {
    id: string;
    title: string;
    detail?: string;
    meta?: string;
    action: () => void;
  };

  const messageIdFromInfo = (message: MessageWithParts) => {
    const id = (message.info as { id?: string | number }).id;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
    return "";
  };

  const messageTextForSearch = (message: MessageWithParts) => {
    const chunks: string[] = [];
    let used = 0;
    const push = (value: string) => {
      const next = value.trim();
      if (!next) return;
      if (used >= MAX_SEARCH_MESSAGE_CHARS) return;
      const remaining = MAX_SEARCH_MESSAGE_CHARS - used;
      if (next.length > remaining) {
        chunks.push(next.slice(0, Math.max(0, remaining)));
        used = MAX_SEARCH_MESSAGE_CHARS;
        return;
      }
      chunks.push(next);
      used += next.length;
    };

    for (const part of message.parts) {
      if (!isUserVisiblePart(part)) {
        continue;
      }
      if (part.type === "text") {
        const text = (part as { text?: string }).text ?? "";
        push(text);
        continue;
      }
      if (part.type === "agent") {
        const name = (part as { name?: string }).name ?? "";
        push(name ? `@${name}` : "");
        continue;
      }
      if (part.type === "file") {
        const file = part as { label?: string; path?: string; filename?: string };
        const label = file.label ?? file.path ?? file.filename ?? "";
        push(label);
        continue;
      }
      if (part.type === "tool") {
        const state = (part as { state?: { title?: string; output?: string; error?: string } }).state;
        push(state?.title ?? "");
        push(state?.output ?? "");
        push(state?.error ?? "");
      }
    }
    return chunks.join("\n");
  };

  createEffect(() => {
    const value = searchQuery();
    if (typeof window === "undefined") {
      setSearchQueryDebounced(value);
      return;
    }
    const id = window.setTimeout(() => setSearchQueryDebounced(value), 90);
    onCleanup(() => window.clearTimeout(id));
  });

  const searchHits = createMemo<SearchHit[]>(() => {
    if (!searchOpen()) return [];
    const query = searchQueryDebounced().trim().toLowerCase();
    if (!query) return [];

    const startedAt = perfNow();
    const hits: SearchHit[] = [];
    let capped = false;

    outer: for (const message of props.messages) {
      const messageId = messageIdFromInfo(message);
      if (!messageId) continue;
      const haystack = messageTextForSearch(message).toLowerCase();
      if (!haystack) continue;
      let index = haystack.indexOf(query);
      while (index !== -1) {
        hits.push({ messageId });
        if (hits.length >= MAX_SEARCH_HITS) {
          capped = true;
          break outer;
        }
        index = haystack.indexOf(query, index + Math.max(1, query.length));
      }
    }

    const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
    if (props.developerMode && (elapsedMs >= 8 || capped)) {
      recordPerfLog(true, "session.search", "scan", {
        queryLength: query.length,
        messageCount: props.messages.length,
        hitCount: hits.length,
        capped,
        ms: elapsedMs,
      });
    }

    return hits;
  });

  const searchMatchMessageIds = createMemo(() => {
    const out = new Set<string>();
    for (const hit of searchHits()) out.add(hit.messageId);
    return out;
  });

  const activeSearchHit = createMemo<SearchHit | null>(() => {
    const hits = searchHits();
    if (!hits.length) return null;
    const size = hits.length;
    const raw = activeSearchHitIndex();
    const index = ((raw % size) + size) % size;
    return hits[index] ?? null;
  });

  const activeSearchPositionLabel = createMemo(() => {
    const hits = searchHits();
    if (!hits.length) return tr("session.search_no_matches");
    const size = hits.length;
    const raw = activeSearchHitIndex();
    const index = ((raw % size) + size) % size;
    return `${index + 1}/${size}`;
  });

  const pendingSessionQueueKey = () => {
    const pendingDraftKey = props.activePendingDraftKey?.trim();
    if (pendingDraftKey) return `pending-draft:${props.activePendingDraftKey}`;
    return `pending-workspace:${props.activeWorkspaceId || "default"}`;
  };
  const sessionQueueKeyForSessionId = (sessionId: string | null | undefined) =>
    sessionId?.trim() || pendingSessionQueueKey();
  const sessionIdForQueueKey = (sessionKey: string) =>
    sessionKey.startsWith("pending:") ||
    sessionKey.startsWith("pending-draft:") ||
    sessionKey.startsWith("pending-workspace:")
      ? null
      : sessionKey;
  const currentSessionQueueKey = createMemo(() => sessionQueueKeyForSessionId(props.selectedSessionId));
  const [optimisticSubmittedDraft, setOptimisticSubmittedDraft] = createSignal<PendingSubmittedDraft | null>(null);

  const optimisticSubmittedMessage = createMemo<MessageWithParts | null>(() => {
    const submitted = optimisticSubmittedDraft();
    if (!submitted) return null;
    if (submitted.sessionKey !== currentSessionQueueKey()) return null;
    return pendingSubmittedDraftToMessage(submitted, props.activeWorkspaceRoot);
  });

  const pendingMessageStateById = createMemo<Record<string, PendingMessageState>>(() => {
    const submitted = optimisticSubmittedDraft();
    if (!submitted) return {};
    if (submitted.sessionKey !== currentSessionQueueKey()) return {};
    const state: PendingMessageState = submitted.error
      ? { state: submitted.state, error: submitted.error }
      : { state: submitted.state };
    return {
      [submitted.id]: state,
    };
  });

  const searchActive = createMemo(() => searchOpen() && searchQuery().trim().length > 0);
  const totalPartCount = createMemo(() => props.messages.reduce((total, message) => total + message.parts.length, 0));

  const renderedMessages = createMemo(() => {
    const optimisticMessage = optimisticSubmittedMessage();
    const sourceMessages = optimisticMessage ? [...props.messages, optimisticMessage] : props.messages;
    if (messageWindowExpanded() || searchActive()) return sourceMessages;

    const start = messageWindowStart();
    if (start <= 0) return sourceMessages;
    if (start >= sourceMessages.length) return [];
    return sourceMessages.slice(start);
  });

  const [batchedRenderedMessages, setBatchedRenderedMessages] = createSignal<MessageWithParts[]>(renderedMessages());

  // Bypass the batching signal and always use the memo directly.
  // The signal-based batching path has a SolidJS reactivity gap that
  // causes messages to flash/disappear during state transitions
  // (idle → running, browsing → engine start).  The memo path is
  // reliable because SolidJS memos propagate synchronously.
  const effectiveRenderedMessages = renderedMessages;

  createEffect(() => {
    const next = renderedMessages();
    const sourceMessageCount = props.messages.length;
    const sourcePartCount = totalPartCount();
    if (props.sessionStatus === "idle") {
      if (streamRenderBatchTimer !== undefined) {
        window.clearTimeout(streamRenderBatchTimer);
        streamRenderBatchTimer = undefined;
      }
      setBatchedRenderedMessages(next);
      streamRenderBatchQueuedAt = 0;
      streamRenderBatchReschedules = 0;
      return;
    }

    if (streamRenderBatchQueuedAt <= 0) {
      streamRenderBatchQueuedAt = perfNow();
    } else {
      streamRenderBatchReschedules += 1;
    }

    if (streamRenderBatchTimer !== undefined) {
      window.clearTimeout(streamRenderBatchTimer);
      streamRenderBatchTimer = undefined;
    }

    streamRenderBatchTimer = window.setTimeout(() => {
      const applyStartedAt = perfNow();
      setBatchedRenderedMessages(next);
      streamRenderBatchTimer = undefined;
      const applyMs = Math.round((perfNow() - applyStartedAt) * 100) / 100;
      const queuedMs = streamRenderBatchQueuedAt > 0 ? Math.round((perfNow() - streamRenderBatchQueuedAt) * 100) / 100 : 0;
      const reschedules = streamRenderBatchReschedules;
      streamRenderBatchQueuedAt = 0;
      streamRenderBatchReschedules = 0;

      if (props.developerMode) {
        window.requestAnimationFrame(() => {
          const paintMs = Math.round((perfNow() - applyStartedAt) * 100) / 100;
          if (queuedMs >= 180 || applyMs >= 8 || paintMs >= 24 || reschedules >= 3) {
            recordPerfLog(true, "session.render", "batch-commit", {
              queuedMs,
              applyMs,
              paintMs,
              reschedules,
              sessionID: props.selectedSessionId,
              status: props.sessionStatus,
              sourceMessageCount,
              sourcePartCount,
              renderedMessageCount: next.length,
            });
          }
        });
      }
    }, STREAM_RENDER_BATCH_MS);
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

  const hiddenMessageCount = createMemo(() => {
    if (messageWindowExpanded() || searchActive()) return 0;
    const hidden = props.messages.length - renderedMessages().length;
    return hidden > 0 ? hidden : 0;
  });

  const nextRevealCount = createMemo(() => {
    const hidden = hiddenMessageCount();
    if (hidden <= 0) return 0;
    return Math.min(hidden, MESSAGE_WINDOW_LOAD_CHUNK);
  });

  const hasServerEarlierMessages = createMemo(
    () => !searchActive() && Boolean(props.selectedSessionId) && props.hasEarlierMessages,
  );

  const revealEarlierMessages = async () => {
    const hidden = hiddenMessageCount();
    if (hidden > 0) {
      const nextStart = Math.max(0, messageWindowStart() - MESSAGE_WINDOW_LOAD_CHUNK);
      if (props.developerMode) {
        recordPerfLog(true, "session.window", "reveal", {
          sessionID: props.selectedSessionId,
          hiddenBefore: hidden,
          nextStart,
        });
      }
      setMessageWindowStart(nextStart);
      if (nextStart === 0) {
        setMessageWindowExpanded(true);
      }
      return;
    }

    if (!hasServerEarlierMessages()) return;
    if (!props.selectedSessionId) return;
    setMessageWindowExpanded(true);
    setMessageWindowStart(0);
    await props.loadEarlierMessages(props.selectedSessionId);
    if (props.developerMode) {
      recordPerfLog(true, "session.window", "load-earlier", {
        sessionID: props.selectedSessionId,
      });
    }
  };

  let lastWindowPerfSignature = "";
  createEffect(() => {
    if (!props.developerMode) {
      lastWindowPerfSignature = "";
      return;
    }

    const signature = [
      props.selectedSessionId ?? "",
      props.messages.length,
      totalPartCount(),
      renderedMessages().length,
      hiddenMessageCount(),
      messageWindowExpanded() ? "1" : "0",
      searchActive() ? "1" : "0",
    ].join("|");

    if (signature === lastWindowPerfSignature) return;
    lastWindowPerfSignature = signature;

    recordPerfLog(true, "session.window", "state", {
      sessionID: props.selectedSessionId,
      messageCount: props.messages.length,
      renderedMessageCount: renderedMessages().length,
      hiddenMessageCount: hiddenMessageCount(),
      partCount: totalPartCount(),
      expanded: messageWindowExpanded(),
      searchActive: searchActive(),
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
        ? ` (tried ${candidates.length} paths: workspace root and outbox fallbacks)`
        : "";
    return {
      ok: false as const,
      reason: `${lastError instanceof Error ? lastError.message : "File open failed"}${suffix}`,
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
  let initialAnchorRafA: number | undefined;
  let initialAnchorRafB: number | undefined;
  let initialAnchorGuardTimer: ReturnType<typeof setTimeout> | undefined;
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

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    setStickToBottom(true);
    messagesEndEl?.scrollIntoView({ behavior, block: "end" });
  };

  const pinToLatestNow = () => {
    setStickToBottom(true);
    messagesEndEl?.scrollIntoView({ behavior: "auto", block: "end" });
  };

  const scheduleScrollToLatest = (behavior: ScrollBehavior = "auto") => {
    if (behavior === "smooth") {
      pendingScrollBehavior = "smooth";
    }
    if (scrollFrame !== undefined) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = undefined;
      const nextBehavior = pendingScrollBehavior;
      pendingScrollBehavior = "auto";
      const now = Date.now();
      const remainingMs = STREAM_SCROLL_MIN_INTERVAL_MS - (now - lastAutoScrollAt);
      if (nextBehavior === "auto" && remainingMs > 0) {
        if (trailingAutoScrollTimer === undefined) {
          trailingAutoScrollTimer = window.setTimeout(() => {
            trailingAutoScrollTimer = undefined;
            if (!stickToBottom()) return;
            scheduleScrollToLatest("auto");
          }, remainingMs);
        }
        return;
      }
      if (trailingAutoScrollTimer !== undefined) {
        window.clearTimeout(trailingAutoScrollTimer);
        trailingAutoScrollTimer = undefined;
      }
      lastAutoScrollAt = now;
      scrollToLatest(nextBehavior);
    });
  };

  const cancelInitialAnchorFrames = () => {
    if (initialAnchorRafA !== undefined) {
      window.cancelAnimationFrame(initialAnchorRafA);
      initialAnchorRafA = undefined;
    }
    if (initialAnchorRafB !== undefined) {
      window.cancelAnimationFrame(initialAnchorRafB);
      initialAnchorRafB = undefined;
    }
    if (initialAnchorGuardTimer) {
      clearTimeout(initialAnchorGuardTimer);
      initialAnchorGuardTimer = undefined;
    }
  };

  const applyInitialBottomAnchor = (sessionId: string) => {
    cancelInitialAnchorFrames();
    initialAnchorGuardTimer = setTimeout(() => {
      initialAnchorGuardTimer = undefined;
      if (props.selectedSessionId !== sessionId) return;
      setInitialAnchorPending(false);
    }, 200);
    pinToLatestNow();
    initialAnchorRafA = window.requestAnimationFrame(() => {
      initialAnchorRafA = undefined;
      pinToLatestNow();
      initialAnchorRafB = window.requestAnimationFrame(() => {
        initialAnchorRafB = undefined;
        pinToLatestNow();
        if (props.selectedSessionId !== sessionId) return;
        setInitialAnchorPending(false);
      });
    });
  };

  onCleanup(() => {
    cancelInitialAnchorFrames();
    if (scrollFrame !== undefined) {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
    }
    if (trailingAutoScrollTimer !== undefined) {
      window.clearTimeout(trailingAutoScrollTimer);
      trailingAutoScrollTimer = undefined;
    }
    if (streamRenderBatchTimer !== undefined) {
      window.clearTimeout(streamRenderBatchTimer);
      streamRenderBatchTimer = undefined;
    }
    streamRenderBatchQueuedAt = 0;
    streamRenderBatchReschedules = 0;
  });

  createEffect(
    on(
      () => [props.selectedSessionId, props.messages.length] as const,
      ([sessionId, count], previous) => {
        const previousSessionId = previous?.[0] ?? null;
        if (sessionId !== previousSessionId) {
          setMessageWindowSessionId(null);
          setMessageWindowExpanded(false);
          setMessageWindowStart(0);
        }

        if (!sessionId) return;
        if (messageWindowExpanded()) return;
        if (count === 0) return;

        const targetStart = count > INITIAL_MESSAGE_WINDOW ? count - INITIAL_MESSAGE_WINDOW : 0;
        if (messageWindowSessionId() !== sessionId) {
          setMessageWindowStart(targetStart);
          setMessageWindowSessionId(sessionId);
          return;
        }

        const currentStart = messageWindowStart();
        if (currentStart <= 0 && targetStart > 0) {
          setMessageWindowStart(targetStart);
          return;
        }

        if (stickToBottom() && targetStart > currentStart) {
          setMessageWindowStart(targetStart);
        }
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const count = props.messages.length;
    const start = messageWindowStart();
    if (start <= count) return;
    setMessageWindowStart(count);
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
  const [runStartedAt, setRunStartedAt] = createSignal<number | null>(null);
  const [runHasBegun, setRunHasBegun] = createSignal(false);
  const [runTick, setRunTick] = createSignal(Date.now());
  const [runLastProgressAt, setRunLastProgressAt] = createSignal<number | null>(null);
  const [runBaseline, setRunBaseline] = createSignal<{ assistantId: string | null; partCount: number }>({
    assistantId: null,
    partCount: 0,
  });
  const resetRunState = () => {
    setRunStartedAt(null);
    setRunHasBegun(false);
    setRunLastProgressAt(null);
    setRunBaseline({ assistantId: null, partCount: 0 });
  };
  const [queuedDraftsBySessionKey, setQueuedDraftsBySessionKey] = createSignal<Record<string, QueuedDraft[]>>({});
  const [queuePausedAfterStopBySessionKey, setQueuePausedAfterStopBySessionKey] = createSignal<Record<string, boolean>>({});
  const [pendingQueueKeyAwaitingSessionId, setPendingQueueKeyAwaitingSessionId] = createSignal<string | null>(null);
  const [editingQueuedDraftId, setEditingQueuedDraftId] = createSignal<string | null>(null);
  const [editingTranscriptMessageId, setEditingTranscriptMessageId] = createSignal<string | null>(null);
  const [abortBusy, setAbortBusy] = createSignal(false);
  const [todoExpanded, setTodoExpanded] = createSignal(false);
  let queueDrainAttemptInFlight = false;

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

    setQueuedDraftsBySessionKey((current) => {
      const pendingQueue = current[pendingKey] ?? [];
      if (!pendingQueue.length) return current;
      const existingRealQueue = current[sessionKey] ?? [];
      const { [pendingKey]: _removedPendingQueue, ...rest } = current;
      return {
        ...rest,
        [sessionKey]: [...existingRealQueue, ...pendingQueue],
      };
    });

    setQueuePausedAfterStopBySessionKey((current) => {
      if (!(pendingKey in current)) return current;
      const pendingPaused = Boolean(current[pendingKey]);
      const { [pendingKey]: _removedPendingPaused, ...rest } = current;
      return {
        ...rest,
        [sessionKey]: pendingPaused || Boolean(current[sessionKey]),
      };
    });

    setOptimisticSubmittedDraft((current) =>
      current?.sessionKey === pendingKey
        ? { ...remapPendingSubmittedSession(current, sessionId), sessionKey }
        : current,
    );
  };

  const restoreMaterializedQueueToPending = (pendingKey: string, sessionId: string | null | undefined) => {
    const materializedSessionId = sessionId?.trim();
    if (!pendingKey || !materializedSessionId) return;
    const sessionKey = sessionQueueKeyForSessionId(materializedSessionId);
    if (pendingKey === sessionKey) return;

    setQueuedDraftsBySessionKey((current) => {
      const materializedQueue = current[sessionKey] ?? [];
      if (!materializedQueue.length) return current;
      const existingPendingQueue = current[pendingKey] ?? [];
      const { [sessionKey]: _removedMaterializedQueue, ...rest } = current;
      return {
        ...rest,
        [pendingKey]: [...existingPendingQueue, ...materializedQueue],
      };
    });

    setQueuePausedAfterStopBySessionKey((current) => {
      if (!(sessionKey in current)) return current;
      const materializedPaused = Boolean(current[sessionKey]);
      const { [sessionKey]: _removedMaterializedPaused, ...rest } = current;
      return {
        ...rest,
        [pendingKey]: materializedPaused || Boolean(current[pendingKey]),
      };
    });
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

  const restoreEditingQueuedDraft = (sessionKey: string, id: string | null) => {
    if (!id) return;
    updateQueueForSessionKey(sessionKey, (queue) => markQueuedDraftQueued(queue, id));
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

  const captureRunBaseline = () => {
    const snapshot = lastAssistantSnapshot();
    setRunBaseline({ assistantId: snapshot.id, partCount: snapshot.partCount });
  };

  const startRun = () => {
    if (runStartedAt()) return;
    const now = Date.now();
    setRunStartedAt(now);
    setRunLastProgressAt(now);
    setRunHasBegun(false);
    captureRunBaseline();
  };

  const responseStarted = createMemo(() => {
    if (!runStartedAt()) return false;
    const baseline = runBaseline();
    const snapshot = lastAssistantSnapshot();
    if (!snapshot.id && !baseline.assistantId) return false;
    if (snapshot.id && snapshot.id !== baseline.assistantId) return true;
    return snapshot.id === baseline.assistantId && snapshot.partCount > baseline.partCount;
  });

  const runPhase = createMemo(() => {
    if (props.error && (runStartedAt() !== null || runHasBegun())) return "error";
    const status = props.sessionStatus;
    const started = runStartedAt() !== null;
    if (status === "idle") {
      if (!started) return "idle";
      if (responseStarted()) return "responding";
      return optimisticSubmittedDraft() ? "thinking" : "sending";
    }
    if (status === "retry") return responseStarted() ? "responding" : "retrying";
    if (responseStarted()) return "responding";
    return "thinking";
  });

  const showRunIndicator = createMemo(() => runPhase() !== "idle");
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
        return tr("session.run_responding");
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

  const jumpToLatest = (behavior: ScrollBehavior = "smooth") => {
    setStickToBottom(true);
    scheduleScrollToLatest(behavior);
  };

  const isAtLatest = (container: HTMLElement, sentinel: HTMLElement) => {
    const containerRect = container.getBoundingClientRect();
    const sentinelRect = sentinel.getBoundingClientRect();
    return sentinelRect.bottom <= containerRect.bottom + 1;
  };

  onMount(() => {
    const container = chatContainerEl;
    const sentinel = bottomVisibilityEl;
    if (!container || !sentinel) return;

    const updateNearBottom = () => {
      const atLatest = isAtLatest(container, sentinel);
      setNearBottom(atLatest);
      setStickToBottom(atLatest);
    };

    updateNearBottom();
    container.addEventListener("scroll", updateNearBottom, { passive: true });

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const atLatest = Boolean(entry?.isIntersecting) || isAtLatest(container, sentinel);
        if (atLatest) {
          setNearBottom(true);
          setStickToBottom(true);
          return;
        }
        if (!stickToBottom()) {
          setNearBottom(false);
        }
      },
      {
        root: container,
        rootMargin: "0px",
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    onCleanup(() => {
      container.removeEventListener("scroll", updateNearBottom);
      observer.disconnect();
    });
  });

  createEffect(
    on(
      () => props.selectedSessionId,
      (sessionId, previousSessionId) => {
        if (sessionId === previousSessionId) {
          return;
        }
        setSearchOpen(false);
        setSearchQuery("");
        setSearchQueryDebounced("");
        setActiveSearchHitIndex(0);

        // Reset run state when switching sessions so a stuck error from a
        // previous session doesn't bleed into the new one.
        resetRunState();
        const previousEditingQueuedDraftId = editingQueuedDraftId();
        restoreEditingQueuedDraft(sessionQueueKeyForSessionId(previousSessionId), previousEditingQueuedDraftId);
        if (previousEditingQueuedDraftId) {
          props.clearComposerDraftForSession(previousSessionId);
        }
        setEditingQueuedDraftId(null);
        setEditingTranscriptMessageId(null);

        if (!sessionId) return;
        const pendingKey = previousSessionId ? null : pendingQueueKeyAwaitingSessionId();
        if (pendingKey) {
          remapPendingQueueToSession(pendingKey, sessionId);
          setPendingQueueKeyAwaitingSessionId(null);
        }
        const sessionKey = sessionQueueKeyForSessionId(sessionId);
        if (props.sessionStatusById[sessionId] === "idle" && !queuePausedForSessionKey(sessionKey)) {
          void drainNextQueuedDraft("queue-drain", sessionKey);
        }
        const firstVisit = !topInitializedSessionIds.has(sessionId);
        topInitializedSessionIds.add(sessionId);
        setInitialAnchorPending(true);
        setStickToBottom(true);

        if (!firstVisit) {
          queueMicrotask(() => {
            applyInitialBottomAnchor(sessionId);
          });
          return;
        }

        queueMicrotask(() => {
          applyInitialBottomAnchor(sessionId);
        });
      },
    ),
  );

  createEffect(
    on(
      () => [props.selectedSessionId, props.messages.length, isChatContainerReady(), initialAnchorPending()] as const,
      ([sessionId, count, ready, pending]) => {
        if (!pending) return;
        if (!sessionId) {
          setInitialAnchorPending(false);
          return;
        }
        if (!ready) return;
        if (count === 0) {
          setInitialAnchorPending(false);
          return;
        }
        queueMicrotask(() => applyInitialBottomAnchor(sessionId));
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const hits = searchHits();
    if (!hits.length) {
      setActiveSearchHitIndex(0);
      return;
    }
    setActiveSearchHitIndex((current) => {
      if (current < 0 || current >= hits.length) return 0;
      return current;
    });
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
    focusCommandPaletteInput();
  });

  createEffect(() => {
    if (!commandPaletteOpen()) return;
    const total = commandPaletteItems().length;
    if (total === 0) {
      setCommandPaletteActiveIndex(0);
      return;
    }
    setCommandPaletteActiveIndex((current) => Math.max(0, Math.min(current, total - 1)));
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
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (commandPaletteOpen()) {
          closeCommandPalette();
        } else {
          openCommandPalette();
        }
        return;
      }

      if (commandPaletteOpen()) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeCommandPalette();
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          stepCommandPaletteIndex(1, commandPaletteItems().length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          stepCommandPaletteIndex(-1, commandPaletteItems().length);
          return;
        }
        if (event.key === "Enter") {
          if (event.isComposing || event.keyCode === 229) return;
          const item = commandPaletteItems()[commandPaletteActiveIndex()];
          if (!item) return;
          event.preventDefault();
          item.action();
          return;
        }
        if (event.key === "Backspace" && !commandPaletteQuery().trim() && commandPaletteMode() !== "root") {
          event.preventDefault();
          returnToCommandRoot();
        }
        return;
      }

      if (mod && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openSearch();
        return;
      }
      if (searchOpen()) {
        if (mod && !event.altKey && event.key.toLowerCase() === "g") {
          event.preventDefault();
          moveSearchHit(event.shiftKey ? -1 : 1);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeSearch();
          return;
        }
      }

      if (
        shouldStopRunOnEscape({
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
        })
      ) {
        event.preventDefault();
        void cancelRun();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  createEffect(() => {
    const status = props.sessionStatus;
    if (status === "running" || status === "retry") {
      startRun();
      setRunHasBegun(true);
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
          if (!sessionIdForQueueKey(sessionKey)) continue;
          if (previousStatuses[sessionKey] === undefined || previousStatuses[sessionKey] === "idle") continue;
          if (statuses[sessionKey] !== "idle") continue;
          if (queuePausedForSessionKey(sessionKey)) continue;
          void drainNextQueuedDraft("queue-drain", sessionKey);
        }
      },
    ),
  );

  createEffect(() => {
    if (responseStarted()) {
      setRunHasBegun(true);
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
      resetRunState();
    }
  });

  // Safety net: if the server reports idle but neither runHasBegun nor
  // responseStarted ever flipped (e.g. "running" + "idle" SSE events
  // arrived in the same SolidJS batch so effects only saw the final "idle"),
  // force-reset after a short grace period.
  createEffect(() => {
    if (!runStartedAt()) return;
    if (props.sessionStatus !== "idle") return;
    if (runHasBegun() || responseStarted()) return;
    const timer = setTimeout(() => {
      if (runStartedAt() && props.sessionStatus === "idle" && !runHasBegun() && !responseStarted()) {
        resetRunState();
      }
    }, 2_000);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    if (!showRunIndicator()) return;
    setRunTick(Date.now());
    const id = window.setInterval(() => setRunTick(Date.now()), 50);
    onCleanup(() => window.clearInterval(id));
  });

  createEffect(() => {
    if (!showRunIndicator()) return;
    runProgressSignature();
    if (initialAnchorPending()) return;
    if (!stickToBottom()) return;
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
        if (mLen > prevM || tLen > prevT || pCount > prevP) {
          if (!initialAnchorPending() && stickToBottom()) {
            scheduleScrollToLatest("auto");
          }
          if (showRunIndicator()) {
            setRunLastProgressAt(Date.now());
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
    if (abortBusy()) return;

    setQueuePausedForCurrentSession(true);

    // If the run is already in error state (e.g. model failed before responding),
    // the session is already idle server-side. Just dismiss the stuck indicator locally.
    if (runPhase() === "error") {
      resetRunState();
      return;
    }

    if (!props.selectedSessionId) {
      setToastMessage(tr("session.no_session_selected_toast"));
      return;
    }

    setAbortBusy(true);
    setToastMessage(tr("session.stopping_run"));
    try {
      await props.abortSession(props.selectedSessionId);
      setToastMessage(tr("session.run_stopped"));
    } catch (error) {
      const message = error instanceof Error ? error.message : tr("session.failed_to_stop");
      setToastMessage(message);
    } finally {
      setAbortBusy(false);
    }
  };

  const retryRun = async () => {
    const text = props.lastPromptSent.trim();
    if (!text) {
      setToastMessage(tr("session.nothing_to_retry"));
      return;
    }

    if (abortBusy()) return;
    setAbortBusy(true);
    setToastMessage(tr("session.trying_again"));
    try {
      if (showRunIndicator() && props.selectedSessionId) {
        await props.abortSession(props.selectedSessionId);
      }
    } catch {
      // If abort fails, still allow the retry. Users care more about forward motion.
    } finally {
      setAbortBusy(false);
    }

    props.retryLastPrompt();
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

  const openCommandPalette = (mode: CommandPaletteMode = "root") => {
    setCommandPaletteMode(mode);
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
    setCommandPaletteOpen(true);
    focusCommandPaletteInput();
  };

  const closeCommandPalette = () => {
    setCommandPaletteOpen(false);
    setCommandPaletteMode("root");
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
  };

  const stepCommandPaletteIndex = (delta: number, total: number) => {
    if (total <= 0) {
      setCommandPaletteActiveIndex(0);
      return;
    }
    setCommandPaletteActiveIndex((current) => {
      const normalized = ((current % total) + total) % total;
      return (normalized + delta + total) % total;
    });
  };

  const returnToCommandRoot = () => {
    if (commandPaletteMode() === "root") return;
    setCommandPaletteMode("root");
    setCommandPaletteQuery("");
    setCommandPaletteActiveIndex(0);
    focusCommandPaletteInput();
  };

  const openSearch = () => {
    setSearchOpen(true);
    focusSearchInput();
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQueryDebounced("");
  };

  const moveSearchHit = (offset: number) => {
    const total = searchHits().length;
    if (!total) return;
    setActiveSearchHitIndex((current) => {
      const normalized = ((current % total) + total) % total;
      return (normalized + offset + total) % total;
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
          label: t("share.invite_link_label", currentLocale()),
          value: inviteUrl,
          secret: true,
          placeholder: !isTauriRuntime() ? t("app.error.tauri_required", currentLocale()) : t("config.starting_server", currentLocale()),
          hint: t("share.invite_link_hint", currentLocale()),
        },
        {
          label: t("share.worker_url_label", currentLocale()),
          value: url,
          placeholder: !isTauriRuntime() ? t("app.error.tauri_required", currentLocale()) : t("config.starting_server", currentLocale()),
          hint: mountedUrl
            ? t("share.use_connecting_to_worker", currentLocale())
            : hostUrl
              ? t("share.worker_url_resolving", currentLocale())
              : undefined,
        },
        {
          label: t("dashboard.veslo_host_token_label", currentLocale()),
          value: token,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : t("app.error.tauri_required", currentLocale()),
          hint: mountedUrl
            ? t("share.use_connecting_to_worker", currentLocale())
            : t("share.use_connecting_to_host", currentLocale()),
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
          label: t("share.invite_link_label", currentLocale()),
          value: inviteUrl,
          secret: true,
          hint: t("share.invite_link_hint", currentLocale()),
        },
        {
          label: t("share.worker_url_label", currentLocale()),
          value: url,
        },
        {
          label: t("dashboard.veslo_host_token_label", currentLocale()),
          value: token,
          secret: true,
          placeholder: token ? undefined : t("share.set_token_in_workspace_settings", currentLocale()),
          hint: t("share.token_grants_access", currentLocale()),
        },
      ];
    }

    const baseUrl = ws.baseUrl?.trim() || ws.path?.trim() || "";
    const directory = ws.directory?.trim() || "";
    return [
      {
        label: t("share.opencode_base_url_label", currentLocale()),
        value: baseUrl,
      },
      {
        label: t("onboarding.directory", currentLocale()),
        value: directory,
        placeholder: "(auto)",
      },
    ];
  });

  const shareNote = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return null;
    if (ws.workspaceType === "local" && props.engineInfo?.runtime === "direct") {
      return t("share.direct_runtime_note", currentLocale());
    }
    return null;
  });

  const shareServiceDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return t("share.select_worker_first", currentLocale());
    if (ws.workspaceType === "remote" && ws.remoteType !== "veslo") {
      return t("share.veslo_workers_only", currentLocale());
    }
    if (ws.workspaceType !== "remote") {
      const baseUrl = props.vesloServerHostInfo?.baseUrl?.trim() ?? "";
      const token = props.vesloServerHostInfo?.clientToken?.trim() ?? "";
      if (!baseUrl || !token) {
        return t("share.local_host_not_ready", currentLocale());
      }
    } else {
      const hostUrl = ws.vesloHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const token = ws.vesloToken?.trim() || props.vesloServerSettings.token?.trim() || "";
      if (!hostUrl) return t("share.missing_host_url", currentLocale());
      if (!token) return t("share.missing_token", currentLocale());
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
      throw new Error(t("share.select_worker_first", currentLocale()));
    }

    if (ws.workspaceType !== "remote") {
      const baseUrl = props.vesloServerHostInfo?.baseUrl?.trim() ?? "";
      const token = props.vesloServerHostInfo?.clientToken?.trim() ?? "";
      if (!baseUrl || !token) {
        throw new Error(t("share.local_host_not_ready", currentLocale()));
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
        throw new Error(t("share.resolve_local_worker_failed", currentLocale()));
      }

      return { client, workspaceId, workspace: ws };
    }

    if (ws.remoteType !== "veslo") {
      throw new Error(t("share.veslo_workers_only", currentLocale()));
    }

    const hostUrl = ws.vesloHostUrl?.trim() || ws.baseUrl?.trim() || "";
    const token = ws.vesloToken?.trim() || props.vesloServerSettings.token?.trim() || "";
    if (!hostUrl || !token) {
      throw new Error(t("share.host_url_token_required", currentLocale()));
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
      throw new Error(t("share.resolve_remote_worker_failed", currentLocale()));
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
        description: t("share.workspace_profile_description", currentLocale()),
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
      setShareWorkspaceProfileError(error instanceof Error ? error.message : t("share.publish_workspace_failed", currentLocale()));
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
        throw new Error(t("share.no_skills_found", currentLocale()));
      }

      const payload: SkillsSetBundleV1 = {
        schemaVersion: 1,
        type: "skills-set",
        name: `${workspaceLabel(workspace)} skills`,
        description: t("share.skills_set_description", currentLocale()),
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
      setShareSkillsSetError(error instanceof Error ? error.message : t("share.publish_skills_failed", currentLocale()));
    } finally {
      setShareSkillsSetBusy(false);
    }
  };

  const exportDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return t("share.export_local_desktop", currentLocale());
    if (ws.workspaceType === "remote") return t("share.export_local_only", currentLocale());
    if (!isTauriRuntime()) return t("share.export_desktop_only", currentLocale());
    if (props.exportWorkspaceBusy) return t("share.export_running", currentLocale());
    return null;
  });

  const sendPromptImmediate = async (
    draft: ComposerDraft,
    options: {
      reason?: "normal" | "queue-drain" | "send-now" | "replacement";
      expectedSessionKey?: string;
      replaceMessageId?: string;
      restoreDraftOnFailure?: boolean;
    } = {},
  ) => {
    const expectedSessionKey = options.expectedSessionKey;
    const targetSessionId = expectedSessionKey ? sessionIdForQueueKey(expectedSessionKey) : null;
    recordSendTrace("sendPromptImmediate:start", {
      aiAccessBlockedReason: props.aiAccessBlockedReason,
      busyHint: props.busyHint ?? null,
      busyLabel: props.busyLabel ?? null,
      expectedSessionKey: expectedSessionKey ?? null,
      targetSessionId,
      reason: options.reason ?? "normal",
    });
    if (expectedSessionKey && currentSessionQueueKey() !== expectedSessionKey && !targetSessionId) return false;
    const showOptimisticSubmit = !options.replaceMessageId && options.reason !== "queue-drain";
    const sessionKey = expectedSessionKey ?? currentSessionQueueKey();
    const pendingSessionKeyBeforeHandoff = !targetSessionId && !sessionIdForQueueKey(sessionKey) ? sessionKey : null;
    if (pendingSessionKeyBeforeHandoff) {
      setPendingQueueKeyAwaitingSessionId(pendingSessionKeyBeforeHandoff);
    }
    const pendingSubmitId = `optimistic-submit:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const clearMatchingPendingSubmit = () => {
      setOptimisticSubmittedDraft((current) => (current?.id === pendingSubmitId ? null : current));
    };
    const markMatchingPendingSubmitFailed = (errorMessage: string) => {
      let materializedSessionIdToRestore: string | null = null;
      setOptimisticSubmittedDraft((current) => {
        if (current?.id !== pendingSubmitId) return current;
        const failed = markPendingSubmittedFailed(current, errorMessage);
        if (pendingSessionKeyBeforeHandoff) {
          materializedSessionIdToRestore = current.sessionId;
          return { ...failed, sessionKey: pendingSessionKeyBeforeHandoff, sessionId: null };
        }
        return failed;
      });
      if (pendingSessionKeyBeforeHandoff) {
        restoreMaterializedQueueToPending(pendingSessionKeyBeforeHandoff, materializedSessionIdToRestore);
      }
    };
    if (showOptimisticSubmit) {
      setOptimisticSubmittedDraft(
        createPendingSubmittedDraft({
          id: pendingSubmitId,
          sessionKey,
          createdAt: Date.now(),
          sessionId: targetSessionId ?? props.selectedSessionId,
          draft,
        }),
      );
      setStickToBottom(true);
      scheduleScrollToLatest("auto");
      startRun();
    }
    if (props.aiAccessBlockedReason) {
      recordSendTrace("sendPromptImmediate:blocked-ai-access", {
        aiAccessBlockedReason: props.aiAccessBlockedReason,
        expectedSessionKey: expectedSessionKey ?? null,
        targetSessionId,
        reason: options.reason ?? "normal",
      });
      if (showOptimisticSubmit) {
        markMatchingPendingSubmitFailed(props.aiAccessBlockedReason);
        resetRunState();
      }
      if (pendingSessionKeyBeforeHandoff) {
        setPendingQueueKeyAwaitingSessionId(null);
      }
      setToastMessage(props.aiAccessBlockedReason);
      return false;
    }

    try {
      const accepted = await (options.replaceMessageId
        ? props.replaceUserMessageAsync(options.replaceMessageId, draft, targetSessionId ? { targetSessionId } : undefined)
        : props.sendPromptAsync(draft, targetSessionId ? { targetSessionId } : undefined)
      );
      recordSendTrace("sendPromptImmediate:result", {
        accepted,
        error: props.error ?? null,
        expectedSessionKey: expectedSessionKey ?? null,
        targetSessionId,
        reason: options.reason ?? "normal",
      });
      if (!accepted) {
        if (showOptimisticSubmit) {
          const errorMessage = props.error ?? tr("session.connect_server_to_attach");
          markMatchingPendingSubmitFailed(errorMessage);
          resetRunState();
        }
        if (pendingSessionKeyBeforeHandoff) {
          setPendingQueueKeyAwaitingSessionId(null);
        }
        setToastMessage(props.error ?? tr("session.connect_server_to_attach"));
        return false;
      }
      if (accepted && pendingSessionKeyBeforeHandoff) {
        const materializedSessionId = props.selectedSessionId?.trim();
        if (materializedSessionId) {
          remapPendingQueueToSession(pendingSessionKeyBeforeHandoff, materializedSessionId);
          setPendingQueueKeyAwaitingSessionId(null);
        }
      }
      if (options.expectedSessionKey && currentSessionQueueKey() !== options.expectedSessionKey) {
        if (showOptimisticSubmit) {
          clearMatchingPendingSubmit();
        }
        return accepted;
      }
      if (accepted && showOptimisticSubmit) {
        clearMatchingPendingSubmit();
      }
      setStickToBottom(true);
      scheduleScrollToLatest("auto");
      startRun();
      return true;
    } catch (e) {
      if (showOptimisticSubmit) {
        const errorMessage = props.error ?? (e instanceof Error ? e.message : tr("session.connect_server_to_attach"));
        markMatchingPendingSubmitFailed(errorMessage);
        resetRunState();
      }
      if (pendingSessionKeyBeforeHandoff) {
        setPendingQueueKeyAwaitingSessionId(null);
      }
      reportError(e, "session.sendPrompt");
      setToastMessage(props.error ?? tr("session.connect_server_to_attach"));
      return false;
    }
  };

  const drainNextQueuedDraft = async (
    reason: "normal" | "queue-drain",
    sessionKey = currentSessionQueueKey(),
  ) => {
    if (queueDrainAttemptInFlight) return;
    if (queuePausedForSessionKey(sessionKey)) return;

    const item = firstQueuedDraft(queuedDraftsBySessionKey()[sessionKey] ?? []);
    if (!item) return;

    queueDrainAttemptInFlight = true;
    updateQueueForSessionKey(sessionKey, (queue) => markQueuedDraftSending(queue, item.id));
    try {
      if (currentSessionQueueKey() !== sessionKey && !sessionIdForQueueKey(sessionKey)) {
        const queuedSessionKey = resolveQueueKeyForQueuedDraft(sessionKey, item.id);
        updateQueueForSessionKey(queuedSessionKey, (queue) => markQueuedDraftQueued(queue, item.id));
        return;
      }

      const accepted = await sendPromptImmediate(item.draft, { reason, expectedSessionKey: sessionKey });
      if (accepted) {
        const acceptedSessionKey = resolveQueueKeyForQueuedDraft(sessionKey, item.id);
        updateQueueForSessionKey(acceptedSessionKey, (queue) => removeQueuedDraft(queue, item.id));
        return;
      }
      if (currentSessionQueueKey() !== sessionKey && !sessionIdForQueueKey(sessionKey)) {
        const queuedSessionKey = resolveQueueKeyForQueuedDraft(sessionKey, item.id);
        updateQueueForSessionKey(queuedSessionKey, (queue) => markQueuedDraftQueued(queue, item.id));
        return;
      }
      const errorSessionKey = resolveQueueKeyForQueuedDraft(sessionKey, item.id);
      updateQueueForSessionKey(errorSessionKey, (queue) =>
        markQueuedDraftError(queue, item.id, props.error ?? tr("session.connect_server_to_attach")),
      );
    } finally {
      queueDrainAttemptInFlight = false;
    }
  };

  const handleEditQueuedDraft = (id: string) => {
    const item = queuedDrafts().find((draft) => draft.id === id);
    if (!item || item.state === "sending") return;
    const currentEditingId = editingQueuedDraftId();
    if (currentEditingId && currentEditingId !== id) {
      restoreEditingQueuedDraft(currentSessionQueueKey(), currentEditingId);
    }
    setEditingQueuedDraftId(id);
    updateCurrentQueue((queue) => markQueuedDraftEditing(queue, id));
    props.setComposerDraft(item.draft);
  };

  const handleCancelQueuedDraft = (id: string) => {
    const item = queuedDrafts().find((draft) => draft.id === id);
    if (!item || item.state === "sending") return;
    updateCurrentQueue((queue) => removeQueuedDraft(queue, id));
    if (editingQueuedDraftId() === id) {
      setEditingQueuedDraftId(null);
      props.setComposerDraft(emptyComposerDraft(props.composerDraft.mode));
    }
  };

  const handleMoveQueuedDraft = (id: string, targetIndex: number) => {
    updateCurrentQueue((queue) => moveQueuedDraft(queue, id, targetIndex));
  };

  const handleEditUserMessage = (editable: EditableUserMessageDraft) => {
    const submitted = optimisticSubmittedDraft();
    const pendingEditable =
      submitted?.sessionKey === currentSessionQueueKey() ? pendingSubmittedDraftToEditable(submitted) : null;
    if (pendingEditable?.messageId === editable.messageId) {
      setOptimisticSubmittedDraft(null);
      setEditingTranscriptMessageId(null);
      props.setComposerDraft(pendingEditable.draft);
      return;
    }
    if (editableUserMessage()?.messageId !== editable.messageId) return;
    setEditingTranscriptMessageId(editable.messageId);
    props.setComposerDraft(editable.draft);
  };

  const handleSendPrompt = async (draft: ComposerDraft, options: ComposerSendOptions = {}) => {
    recordSendTrace("handleSendPrompt:start", {
      sendNow: options.sendNow,
      source: options.source,
      editingQueuedDraftId: editingQueuedDraftId(),
      queuePaused: queuePaused(),
      showRunIndicator: showRunIndicator(),
    });

    const sendNow = Boolean(options.sendNow);
    const editingId = editingQueuedDraftId();
    if (editingId) {
      if (!sendNow) {
        const sessionKey = currentSessionQueueKey();
        updateCurrentQueue((queue) => markQueuedDraftQueued(updateQueuedDraft(queue, editingId, draft), editingId));
        setEditingQueuedDraftId(null);
        props.setComposerDraft(emptyComposerDraft(draft.mode));
        if (!showRunIndicator() && !queuePausedForSessionKey(sessionKey)) {
          void drainNextQueuedDraft("normal", sessionKey);
        }
        return true;
      }

      const sessionKey = currentSessionQueueKey();
      const wasPaused = queuePausedForSessionKey(sessionKey);
      updateQueueForSessionKey(sessionKey, (queue) =>
        markQueuedDraftSending(updateQueuedDraft(queue, editingId, draft), editingId),
      );
      if (currentSessionQueueKey() === sessionKey) {
        setEditingQueuedDraftId(null);
        props.setComposerDraft(emptyComposerDraft(draft.mode));
      }
      const accepted = await sendPromptImmediate(draft, {
        reason: "send-now",
        expectedSessionKey: sessionKey,
        restoreDraftOnFailure: false,
      });
      const resultSessionKey = resolveQueueKeyForQueuedDraft(sessionKey, editingId);
      if (!accepted) {
        updateQueueForSessionKey(resultSessionKey, (queue) =>
          markQueuedDraftError(queue, editingId, props.error ?? tr("session.connect_server_to_attach")),
        );
        return false;
      }
      updateQueueForSessionKey(resultSessionKey, (queue) => removeQueuedDraft(queue, editingId));
      if (accepted && wasPaused) {
        setQueuePausedForSessionKey(sessionKey, false);
      }
      return true;
    }

    const transcriptEditMessageId = editingTranscriptMessageId();
    if (transcriptEditMessageId) {
      const sessionKey = currentSessionQueueKey();
      setEditingTranscriptMessageId(null);
      const accepted = await sendPromptImmediate(draft, {
        reason: "replacement",
        expectedSessionKey: sessionKey,
        replaceMessageId: transcriptEditMessageId,
      });
      if (!accepted) return false;
      return true;
    }

    if (queuePaused() && !sendNow) {
      const sessionKey = currentSessionQueueKey();
      appendDraftToCurrentQueue(draft);
      setQueuePausedForSessionKey(sessionKey, false);
      void drainNextQueuedDraft("normal", sessionKey);
      return true;
    }

    if (queuedDrafts().length > 0 && !sendNow) {
      const sessionKey = currentSessionQueueKey();
      appendDraftToCurrentQueue(draft);
      if (!showRunIndicator() && !queuePausedForSessionKey(sessionKey)) {
        void drainNextQueuedDraft("normal", sessionKey);
      }
      return true;
    }

    if (showRunIndicator() && !sendNow) {
      appendDraftToCurrentQueue(draft);
      return true;
    }

    if (sendNow) {
      const sessionKey = currentSessionQueueKey();
      const wasPaused = queuePausedForSessionKey(sessionKey);
      const accepted = await sendPromptImmediate(draft, { reason: "send-now", expectedSessionKey: sessionKey });
      if (accepted && wasPaused) {
        setQueuePausedForSessionKey(sessionKey, false);
      }
      return accepted;
    }

    return sendPromptImmediate(draft, { reason: "normal" });
  };

  const handleBrowserAutomationQuickstart = () => {
    const text =
      BROWSER_AUTOMATION_QUICKSTART_PROMPT ||
      "Try Chrome DevTools MCP now. If it is unavailable, explain how to connect Control Chrome in Veslo and ask me to retry.";
    handleSendPrompt({
      mode: "prompt",
      text,
      resolvedText: text,
      parts: [{ type: "text", text }],
      attachments: [],
    });
  };

  const handleSoulQuickstart = async () => {
    const name = SOUL_SETUP_TEMPLATE.name;
    const slashCommand = `/${name}`;
    try {
      const commands = await props.listCommands();
      const hasCommand = commands.some((cmd) => cmd.name === name);
      if (hasCommand) {
        handleSendPrompt({
          mode: "prompt",
          text: slashCommand,
          resolvedText: slashCommand,
          parts: [{ type: "text", text: slashCommand }],
          attachments: [],
          command: { name, arguments: "" },
        });
        return;
      }
    } catch {
      // Fall back to prompt-based setup below.
    }

    const text =
      currentLocale() === "cs"
        ? tr("session.quickstart_soul_prompt")
        : SOUL_SETUP_TEMPLATE.body || tr("session.quickstart_soul_prompt");
    handleSendPrompt({
      mode: "prompt",
      text,
      resolvedText: text,
      parts: [{ type: "text", text }],
      attachments: [],
    });
  };

  const isSandboxWorkspace = createMemo(() => Boolean((props.activeWorkspaceDisplay as any)?.sandboxContainerName?.trim()));
  let pendingSessionLoadAttempt = 0;

  const handleDraftChange = (draft: ComposerDraft) => {
    props.setComposerDraft(draft);
  };

  const openSessionFromList = (workspaceId: string, sessionId: string) => {
    const attempt = ++pendingSessionLoadAttempt;
    const shouldShowOverlay = sessionId !== props.selectedSessionId;

    // Show loading overlay immediately when switching to a different session.
    if (shouldShowOverlay) {
      const group = props.workspaceSessionGroups.find((g) => g.workspace.id === workspaceId);
      const session = group?.sessions.find((s) => s.id === sessionId);
      const workspaceName = group?.workspace.displayName ?? group?.workspace.name ?? "";
      const sessionTitle = session?.title ?? "";
      props.setPendingSessionLoad({
        sessionId,
        workspaceId,
        sessionTitle,
        workspaceName,
      });
    }
    void openSessionWithWorkspaceActivation({
      activeWorkspaceId: props.activeWorkspaceId,
      getActiveWorkspaceId: () => props.activeWorkspaceId,
      workspaceId,
      sessionId,
      activateWorkspace: props.activateWorkspace,
      // Route-driven selection: navigate first and let the route effect own selectSession.
      openSession: (nextSessionId) => props.setView("session", nextSessionId),
    })
      .then((result) => {
        if (!shouldShowOverlay) return;
        if (attempt !== pendingSessionLoadAttempt) return;
        // Opened routes keep the inline loading state until selectSession
        // completes transcript hydration and fires onSessionLoadComplete.
        if (result === "blocked" || result === "superseded") {
          props.setPendingSessionLoad(null);
        }
      })
      .catch(() => {
        if (!shouldShowOverlay) return;
        if (attempt !== pendingSessionLoadAttempt) return;
        props.setPendingSessionLoad(null);
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
      console.warn("[session.loaded-session-prefetch] failed", {
        workspaceId,
        serverWorkspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const commandPaletteRootItems = createMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [
      {
        id: "new-session",
        title: tr("session.command_palette_create_session"),
        detail: tr("session.command_palette_create_session_detail"),
        meta: tr("session.command_palette_meta_create"),
        action: () => {
          closeCommandPalette();
          void Promise.resolve(props.createSessionAndOpen()).catch((error) => {
            const message = error instanceof Error ? error.message : tr("session.failed_create_session");
            setToastMessage(message);
          });
        },
      },
      {
        id: "sessions",
        title: tr("session.command_palette_search_sessions"),
        detail: formatTr("session.command_palette_search_sessions_detail", {
          count: totalSessionCount().toLocaleString(),
        }),
        meta: tr("session.command_palette_meta_jump"),
        action: () => {
          setCommandPaletteMode("sessions");
          setCommandPaletteQuery("");
          setCommandPaletteActiveIndex(0);
          focusCommandPaletteInput();
        },
      },
    ];

    const query = commandPaletteQuery().trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => `${item.title} ${item.detail ?? ""}`.toLowerCase().includes(query));
  });

  const commandPaletteSessionItems = createMemo<CommandPaletteItem[]>(() => {
    const query = commandPaletteQuery().trim().toLowerCase();
    const candidates = query
      ? commandPaletteSessionOptions().filter((item) => item.searchText.includes(query))
      : commandPaletteSessionOptions();

    return candidates.slice(0, 80).map((item) => ({
      id: `session:${item.workspaceId}:${item.sessionId}`,
      title: item.title,
      detail: item.workspaceTitle,
      meta:
        item.workspaceId === props.activeWorkspaceId
          ? tr("session.command_palette_meta_current_workspace")
          : tr("session.command_palette_meta_switch"),
      action: () => {
        closeCommandPalette();
        openSessionFromList(item.workspaceId, item.sessionId);
      },
    }));
  });

  const commandPaletteItems = createMemo<CommandPaletteItem[]>(() => {
    const mode = commandPaletteMode();
    if (mode === "sessions") return commandPaletteSessionItems();
    return commandPaletteRootItems();
  });

  const commandPaletteTitle = createMemo(() => {
    const mode = commandPaletteMode();
    if (mode === "sessions") return tr("session.command_palette_search_sessions");
    return tr("session.quick_actions");
  });

  const commandPalettePlaceholder = createMemo(() => {
    const mode = commandPaletteMode();
    if (mode === "sessions") return tr("session.command_palette_find_by_session_or_workspace");
    return tr("session.command_palette_search_actions");
  });

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

  const openSoul = (workspaceId?: string) => {
    const id = (workspaceId ?? props.activeWorkspaceId).trim();
    if (!id) return;
    void (async () => {
      if (id !== props.activeWorkspaceId) {
        await Promise.resolve(props.activateWorkspace(id));
      }
      props.setTab("soul");
      props.setView("dashboard");
    })();
  };

  const soulModeEnabled = createMemo(() =>
    Boolean(props.soulStatusByWorkspaceId[props.activeWorkspaceId]?.enabled)
  );

  const runtimeAvailableWithoutClient = createMemo(() => {
    if (props.clientConnected) return false;
    if (props.vesloServerStatus !== "connected") return false;
    if (props.activeWorkspaceDisplay.workspaceType !== "local") return false;
    return (props.workspaceConnectionStateById[props.activeWorkspaceId]?.status ?? "idle") === "connected";
  });

  const soulNavIconClass = () => (soulModeEnabled() ? "soul-nav-icon-active" : "");
  const leftSidebarContent = () => (
    <>
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
            unreadSessionIds={props.unreadSessionIds}
            archivedSessionIds={props.archivedSessionIds}
            activeWorkspaceId={props.activeWorkspaceId}
            selectedSessionId={props.selectedSessionId}
            pendingSelectedSessionId={props.pendingSessionLoad?.sessionId ?? null}
            pendingSelectedWorkspaceId={props.pendingSessionLoad?.workspaceId ?? null}
            suspendProjectReorder={Boolean(props.pendingSessionLoad)}
            sessionStatusById={props.sessionStatusById}
            connectingWorkspaceId={props.connectingWorkspaceId}
            workspaceConnectionStateById={props.workspaceConnectionStateById}
            newTaskDisabled={props.newTaskDisabled}
            importingWorkspaceConfig={props.importingWorkspaceConfig}
            showRemoteActions={props.showRemoteActions}
            soulStatusByWorkspaceId={props.soulStatusByWorkspaceId}
            isPrivateWorkspacePath={props.isPrivateWorkspacePath}
            onActivateWorkspace={props.activateWorkspace}
            onOpenSession={openSessionFromList}
            onDeleteSession={openDeleteSessionModalForSession}
            onOpenPendingDirectoryDraftInWorkspace={props.openPendingDirectoryDraftInWorkspace}
            onOpenRenameWorkspace={props.openRenameWorkspace}
            onShareWorkspace={(workspaceId) => setShareWorkspaceId(workspaceId)}
            onOpenSoul={openSoul}
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
            onOpenSessionSearch={() => openCommandPalette("sessions")}
          />
        </div>
        <SidebarDashboardNav
          currentTab={props.tab}
          onSelect={(tab) => {
            if (tab === "soul") {
              openSoul();
              return;
            }
            openDashboardTab(tab);
          }}
          soulIconClass={soulNavIconClass()}
        />
      </div>
      <SidebarStatusControls
        clientConnected={props.clientConnected}
        vesloServerStatus={props.vesloServerStatus}
        runtimeAvailableWithoutClient={runtimeAvailableWithoutClient()}
        authenticatedUser={props.authenticatedUser}
        onOpenSettings={() => openSettings("general")}
        onLogout={props.onLogout}
        onSignIn={props.onSignIn}
      />
    </>
  );

  const rightSidebarContent = () => (
    <div class="flex-1 overflow-y-auto space-y-5 pt-2">
      <Show when={props.developerMode}>
        <div class="space-y-1 mb-2">
          <SidebarAdvancedNav currentTab={props.tab} onSelect={openConfig} />
        </div>
      </Show>

      <ArtifactsPanel
        id="sidebar-artifacts"
        families={props.artifactFamilies}
        workspaceRoot={props.activeWorkspaceRoot}
        onRevealArtifact={revealArtifact}
      />
      <SessionCapabilitiesPanel
        state={props.sessionCapabilitiesStatus}
        skills={props.sessionCapabilities?.skills ?? []}
        mcp={props.sessionCapabilities?.mcp ?? []}
        error={props.sessionCapabilitiesError}
      />
    </div>
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

      <Show when={leftDockedVisible()}>
        <aside
          class={`relative flex shrink-0 flex-col bg-dls-sidebar border-r border-gray-6/70 p-3 pt-12 ${
            leftSidebarResizing() ? "cursor-col-resize" : ""
          }`}
          style={leftSidebarDockedStyle()}
        >
          {leftSidebarContent()}
          <div
            class="absolute inset-y-0 right-0 w-2 cursor-col-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={__vesloT("ui.literal.resize_left_sidebar_1nybbn", __vesloCurrentLocale())}
            onPointerDown={startLeftSidebarResize}
          />
        </aside>
      </Show>

      <main class="flex-1 flex flex-col overflow-hidden bg-gray-1 pt-12">

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
                  setActiveSearchHitIndex(0);
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
                    class="font-product type-ui-md rounded-2xl border border-gray-7 bg-gray-12 px-4 py-3 font-semibold text-gray-1 transition-colors hover:bg-gray-11"
                    onClick={() => {
                      void props.openNewSessionWithDirectory();
                    }}
                  >
                    {tr("session.new_session_label")}
                  </button>
                </div>
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
                      {props.pendingSessionLoad?.sessionTitle || tr("session.opening_conversation")}
                    </h3>
                    <Show when={props.pendingSessionLoad?.workspaceName}>
                      {(workspaceName) => (
                        <p class="font-product type-ui-sm text-gray-10">{workspaceName()}</p>
                      )}
                    </Show>
                    <p class="font-reading type-ui-md text-gray-10">{tr("session.opening_conversation")}</p>
                  </div>
                </div>
              </div>
            </Show>
            <Show when={props.messages.length === 0 && !showWorkspaceSetupEmptyState() && !showSessionLoadingState()}>
              <div class="text-center py-16 px-6 space-y-6">
                <div class="w-16 h-16 bg-dls-hover rounded-3xl mx-auto flex items-center justify-center border border-dls-border">
                  <Zap class="text-dls-secondary" />
                </div>
              <div class="space-y-2">
                <h3 class="font-product type-title-sm">{tr("session.quickstart_title")}</h3>
                <p class="font-reading type-reading-md text-dls-secondary max-w-sm mx-auto">
                  {tr("session.quickstart_description")}
                </p>
              </div>
              <div class="grid gap-3 sm:grid-cols-2 max-w-2xl mx-auto text-left">
                <button
                  type="button"
                  class="rounded-2xl border border-dls-border bg-dls-hover p-4 transition-all hover:bg-dls-active hover:border-gray-7"
                  onClick={() => {
                    void handleBrowserAutomationQuickstart();
                  }}
                >
                  <div class="font-product type-ui-md font-semibold text-dls-text">{tr("session.quickstart_browser_title")}</div>
                  <div class="font-reading type-ui-sm mt-1 text-dls-secondary">
                    {tr("session.quickstart_browser_description")}
                  </div>
                </button>
                <button
                  type="button"
                  class="rounded-2xl border border-dls-border bg-dls-hover p-4 transition-all hover:bg-dls-active hover:border-gray-7"
                  onClick={() => {
                    void handleSoulQuickstart();
                  }}
                >
                  <div class="font-product type-ui-md font-semibold text-dls-text">{tr("session.quickstart_soul_title")}</div>
                  <div class="font-reading type-ui-sm mt-1 text-dls-secondary">
                    {tr("session.quickstart_soul_description")}
                  </div>
                </button>
              </div>
            </div>
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
              showRunIndicator() ? (
                <div class="flex justify-start pl-2">
                  <div class={`w-full ${railWidthClass()}`}>
                    <div
                      class={`flex items-center gap-2 text-xs py-1 ${runPhase() === "error" ? "text-red-11" : "text-gray-9"}`}
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

      <Show when={!showWorkspaceSetupEmptyState()}>
        <Show when={props.selectedSessionId ?? "__no-session"} keyed>
          {(_sessionKey) => (
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
              <Composer
                initialDraft={props.composerDraft}
                prompt={props.composerDraft.text}
                developerMode={props.developerMode}
                busy={props.busy}
                isStreaming={showRunIndicator()}
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
                isSandboxWorkspace={isSandboxWorkspace()}
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
          )}
        </Show>
      </Show>

      </main>

      <Show when={rightDockedVisible()}>
        <aside class="w-[280px] flex shrink-0 flex-col bg-dls-sidebar border-l border-gray-6/70 p-3 pt-12">
          {rightSidebarContent()}
        </aside>
      </Show>

      <Show when={overlayOpenSide() === "left"}>
        <div
          class="fixed inset-0 z-40 bg-gray-12/20 backdrop-blur-[1px]"
          onClick={() => closeSidebarOverlay()}
        />
        <aside
          class={`fixed inset-y-0 left-0 z-[45] flex flex-col bg-dls-sidebar border-r border-gray-6/80 p-3 pt-12 shadow-xl shadow-gray-12/20 ${
            leftSidebarResizing() ? "cursor-col-resize" : ""
          }`}
          style={leftSidebarOverlayStyle()}
          onClick={(event) => event.stopPropagation()}
        >
          {leftSidebarContent()}
          <div
            class="absolute inset-y-0 right-0 w-2 cursor-col-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={__vesloT("ui.literal.resize_left_sidebar_1nybbn", __vesloCurrentLocale())}
            onPointerDown={startLeftSidebarResize}
          />
        </aside>
      </Show>

      <Show when={overlayOpenSide() === "right"}>
        <div
          class="fixed inset-0 z-40 bg-gray-12/20 backdrop-blur-[1px]"
          onClick={() => closeSidebarOverlay()}
        />
        <aside
          class="fixed inset-y-0 right-0 z-[45] flex w-[min(280px,calc(100vw-32px))] max-w-[280px] flex-col bg-dls-sidebar border-l border-gray-6/80 p-3 pt-12 shadow-xl shadow-gray-12/20"
          onClick={(event) => event.stopPropagation()}
        >
          {rightSidebarContent()}
        </aside>
      </Show>

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
                        class={`w-full text-left rounded-xl px-3 py-2.5 transition-colors ${
                          idx() === commandPaletteActiveIndex()
                            ? "bg-dls-active text-dls-text"
                            : "text-dls-text hover:bg-dls-hover"
                        }`}
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

      <Show when={props.activePermission}>
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
