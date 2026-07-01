import {
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import { useLocation, useNavigate } from "@solidjs/router";

import type {
  Agent,
  Part,
  Session,
} from "@opencode-ai/sdk/v2/client";

import { reportError } from "./lib/error-reporter";
import { recordSendWorkflowTrace } from "./lib/send-workflow-trace";
import { resolveRunningVesloServerHostInfo } from "./lib/veslo-server-host";
import {
  readSessionStatus,
  withoutSessionStatus,
} from "./lib/scoped-session-status";
import {
  COMPACTION_THRESHOLD_RATIO,
  resolveCompactionThreshold,
  shouldAutoCompact,
} from "./lib/auto-compaction";
import {
  DEFAULT_UPDATE_AUTO_DOWNLOAD,
  shouldAutoCheckForUpdatesAt,
} from "./context/updater";
import {
  type EngineSourcePreference,
} from "./lib/engine-source";
import {
  clearLegacySessionModelPersistence,
  parseDefaultModelFromConfig,
  resolveWorkspaceDefaultModel,
} from "./lib/model-persistence";
import {
  DEFAULT_MODEL_VARIANT,
  MODEL_VARIANT_OPTIONS,
  normalizeModelVariant,
  resolveCodexReasoningEffort,
} from "./lib/model-variant";
import { resolveGlobalRuntimeModel } from "./lib/global-model-runtime";
import {
  resolveSendPromptBusyOwnership,
} from "./controllers/send-orchestration-controller";
import { partitionVesloUtilitySessions } from "./lib/veslo-utility-session";
import {
  createSessionClientMessageId,
  normalizeSessionSendCorrelation,
  type MaterializedSessionHandoff,
  type SessionSendOptionsBase,
} from "./lib/session-send-contract";
import { createUiConversationKey } from "./lib/ui-conversation-scope";
import {
  createWorkspaceSessionSelection,
} from "./context/workspace-session-selection";
import type { WorkspaceBusyMap } from "./context/workspace-debug";
import {
  createWorkspaceSendTarget,
  type SendTargetWorkspaceScope,
} from "./context/workspace-send-target";
import {
  createManagedAiAccessStore,
  type ManagedAiAccessStore,
} from "./context/managed-ai-access-store";
import { createManagedAiRuntimeConfigSync } from "./context/managed-ai-runtime-config";
import {
  createConversationService,
  type ConversationAbortTarget,
  type ConversationWorkspaceResolution,
} from "./context/conversation-service";
import { createPendingSessionDraftController } from "./context/pending-session-draft-controller";
import { createComposerTargetController } from "./context/composer-target-controller";
import { createAppShellEnvironment } from "./context/app-shell-environment";
import { createFeedbackWorkflow } from "./context/feedback-workflow";
import { createDenDesktopAuthWorkflow } from "./context/den-desktop-auth-workflow";
import { createSessionArchiveStore } from "./context/session-archive-store";
import {
  createWorkspaceRuntimeDebugProbe,
  debugProbeCall,
  debugProbeSkipped,
  debugSummarizeWorkspace,
  debugWorkspaceIdFromMountedBaseUrl,
  type WorkspaceRuntimeDebugRoot,
} from "./context/workspace-runtime-debug-probe";
import { createSessionSidebarDecorations } from "./context/session-sidebar-decorations";
import {
  createSendRuntimeReadiness,
  type SendRuntimePreflightContext,
  type SendRuntimePreflightTargetWorkspace,
} from "./context/send-runtime-readiness";
import { createAppRouteSync } from "./context/app-route-sync";
import { createSessionRouteSync } from "./context/session-route-sync";
import { createAppDeepLinkWorkflow } from "./context/app-deep-link-workflow";
import { createAppStartupHydration } from "./context/app-startup-hydration";
import { createMcpConnectionWorkflow } from "./context/mcp-connection-workflow";
import {
  createVesloServerConnection,
  isLoopbackVesloServerConnectionUrl,
} from "./context/veslo-server-connection";
import { createSessionCapabilitiesStore } from "./context/session-capabilities-store";
import ResetModal from "./components/reset-modal";
import ConfirmModal from "./components/confirm-modal";
import WorkspaceSwitchOverlay from "./components/workspace-switch-overlay";
import DesktopContextMenu from "./components/desktop-context-menu";
import VesloLogo from "./components/veslo-logo";
import CreateRemoteWorkspaceModal from "./components/create-remote-workspace-modal";
import CreateWorkspaceModal from "./components/create-workspace-modal";
import FeedbackModal from "./components/feedback-modal";
import RenameWorkspaceModal from "./components/rename-workspace-modal";
import McpAuthModal from "./components/mcp-auth-modal";
import OnboardingView from "./pages/onboarding";
import DashboardView from "./pages/dashboard";
import SessionView from "./pages/session";
import { createScheduledAutomationStore } from "./pages/scheduled-automation-store";
import {
  createSessionCreationWorkflow,
  type SessionCreationWorkflowCreateOptions,
} from "./pages/session-creation-workflow";
import { createSessionMutationWorkflow } from "./pages/session-mutation-workflow";
import { createSoulDataStore } from "./pages/soul-data-store";
import { isPendingSessionInstanceId } from "./components/session/pending-session-instance-model";
import ProtoWorkspacesView from "./pages/proto-workspaces";
import ProtoV1UxView from "./pages/proto-v1-ux";
import {
  createEmptyComposerDraft,
  deleteSessionComposerDraft,
  getSessionComposerDraft,
  setSessionComposerDraft,
  setSessionComposerPrompt,
} from "./pages/session-composer-drafts";
import {
  GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
  resolveComposerStorageKey,
} from "./lib/pending-session-drafts";
import {
  createClient,
  unwrap,
  waitForHealthy,
} from "./lib/opencode";
import {
  abortSession as abortSessionTyped,
  abortSessionSafe,
  revertSession,
  unrevertSession,
  listCommands as listCommandsTyped,
} from "./lib/opencode-session";
import { clearPerfLogs, finishPerf, perfNow, recordPerfLog } from "./lib/perf-log";
import {
  createMcpAutoRefreshScheduler,
  createPermissionPollingScheduler,
} from "./lib/workspace-runtime-schedulers";
import { createMcpServersRefresher } from "./lib/mcp-server-refresh";
import { createSkillReloadGuard } from "./lib/skill-reload-guard";
import { createSkillRegistryOrchestrator } from "./context/skill-registry-orchestrator";
import {
  classifyNewSessionDisabledReason,
  clearBootstrapDiagnosticsCloudContext,
  recordBootstrapDiagnostic,
  setBootstrapDiagnosticsCloudContext,
} from "./lib/bootstrap-diagnostics";
import {
  AUTO_COMPACT_CONTEXT_PREF_KEY,
  ENGINE_CUSTOM_BIN_PATH_PREF_KEY,
  ENGINE_SOURCE_EXPLICIT_PREF_KEY,
  ENGINE_SOURCE_PREF_KEY,
  DEFAULT_MODEL,
  HIDE_TITLEBAR_PREF_KEY,
  LANGUAGE_PREF_KEY,
  MCP_QUICK_CONNECT,
  MODEL_PREF_KEY,
  SUGGESTED_PLUGINS,
  THINKING_PREF_KEY,
  MAX_ENGINES_PREF_KEY,
  IDLE_SUSPEND_MS_PREF_KEY,
  VARIANT_PREF_KEY,
  type McpDirectoryInfo,
} from "./constants";
import {
  canRemoveMcpFromProjectConfig,
  quickConnectEntryKey,
  removeMcpFromConfig,
  validateMcpServerName,
} from "./mcp";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "./types";
import type {
  Client,
  MessageWithParts,
  PlaceholderAssistantMessage,
  StartupPreference,
  EngineRuntime,
  ModelRef,
  OnboardingStep,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
  ResetVesloMode,
  SettingsTab,
  SkillCard,
  PendingSidebarSessionMetadata,
  SidebarSessionItem,
  TodoItem,
  WorkspaceDisplay,
  McpServerEntry,
  McpStatusMap,
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  ComposerTargetOption,
  ComposerTargetSwitchResult,
  ProviderListItem,
  SessionErrorTurn,
  UpdateHandle,
  OpencodeConnectStatus,
  SuggestedPlugin,
} from "./types";
import {
  clearStartupPreference,
  deriveArtifacts,
  deriveWorkingFiles,
  formatBytes,
  formatModelLabel,
  formatModelRef,
  formatRelativeTime,
  groupMessageParts,
  isVisibleTextPart,
  lastUserModelFromMessages,
  isTauriRuntime,
  modelEquals,
  normalizeDirectoryQueryPath,
  normalizeDirectoryPath,
  preferredSessionWorkspaceRoot,
  sessionDirectoryMatchesRoot,
} from "./utils";
import {
  readDenAuth,
  readDenKeepSignedIn,
  writeDenKeepSignedIn,
} from "./lib/den-auth";
import { currentLocale, isLanguage, setLocale, t, type Language } from "../i18n";
import {
  isWindowsPlatform,
  isMacPlatform,
  // normalizeDirectoryPath,
  parseModelRef,
  safeStringify,
  summarizeStep,
  addOpencodeCacheHint,
  normalizeTodoItems,
} from "./utils";
import {
  getInitialThemeMode,
  type ThemeMode,
} from "./theme";

import { createSystemState } from "./system-state";
import { relaunch } from "@tauri-apps/plugin-process";
import { createSessionStore } from "./context/session";
import type { ReconnectNotice } from "./context/session-reconnect";
import { createSidebarWorkspaceSessions } from "./context/sidebar-workspace-sessions";
import { createWorkspaceSessionSnapshots } from "./context/workspace-session-snapshots";
import { createExtensionsStore } from "./context/extensions";
import { useGlobalSync } from "./context/global-sync";
import { createWorkspaceStore } from "./context/workspace";
import { WorkspaceServerSync } from "./context/workspace-server-sync";
import { createWorkspaceSwitchOverlayState } from "./context/workspace-switch-overlay-state";
import {
  createWorkspaceRouting,
  isWorkspaceClientStaleError,
  WorkspaceRoutingProvider,
} from "./context/workspace-routing";
import {
  createRuntimeOwnedRouting,
  createRuntimeOwner,
} from "./context/runtime-owner";
import {
  activateWorkspaceWithBrowsePolicy,
  isPassiveLocalBrowseActivationOrigin,
} from "./context/workspace-activation-controller";
import {
  accessProofAiClear,
  accessProofAiRead,
  accessProofAiWrite,
  pendingSessionDraftsDelete,
  pendingSessionDraftsGet,
  pendingSessionDraftsList,
  pendingSessionDraftsPut,
  readOpencodeConfig,
  writeOpencodeConfig,
  engineInfo,
  workspaceBootstrap,
  vesloServerInfo,
  vesloServerRestart,
  orchestratorStatus,
  orchestratorEnginesList,
  workspaceCopyIntoFolder,
  workspaceVesloRead,
  workspaceVesloWrite,
  logUiEvent,
  opencodeDbUpdateSessionDirectory,
  type VesloServerInfo,
  type WorkspaceInfo,
} from "./lib/tauri";
import {
  parseVesloWorkspaceIdFromUrl,
  createVesloServerClient,
  normalizeVesloServerUrl,
  requestManagedAiAccessBundle,
  readVesloServerSettings,
  writeVesloServerSettings,
  clearVesloServerSettings,
  type VesloSessionLatestRunArtifacts,
  type VesloConversationRunInput,
  type VesloServerClient,
  VesloServerError,
} from "./lib/veslo-server";
import {
  getVesloRequestBrokerSnapshot,
  isLocalVesloTransportError,
} from "./lib/veslo-server/request-broker";
import { routeStagedAttachmentsForModel } from "./lib/attachment-prompt-routing";
import { createSessionAttachmentStaging } from "./pages/session-attachment-staging";
import { resolveArtifactFamilies } from "./components/session/artifact-family-model";
import {
  clearUnreadSession,
  markUnreadAfterAssistantResponse,
  pruneUnreadSessions,
  type UnreadSessionMap,
} from "./components/session/session-unread-model";
import type { EffectiveRuntimeSandboxState } from "./lib/runtime-sandbox-state";
import { waitForManagedAiBootstrapReady } from "./lib/managed-ai-bootstrap-ready";
import { describeRequestError } from "./lib/client-errors";
import { CLOUD_ONLY_MODE, resolveVesloCloudEnvironment } from "./lib/cloud-policy";
import { isRemoteUiEnabled } from "./lib/runtime-policy";

type SendTraceRoot = typeof window & {
  __vesloSendTrace?: Array<Record<string, unknown>>;
  __vesloActiveSendTraceId?: string | null;
  __vesloSendTraceSeq?: number;
  __vesloSendTraceStartPerfMsById?: Record<string, number>;
};

type SendPreflightContext = SendRuntimePreflightContext & {
  traceId: string;
  managedAiReady: boolean;
  runtimeHealthOk: boolean;
  enginePrepared: boolean;
  effectiveSandbox: EffectiveRuntimeSandboxState | null;
  targetWorkspace: SendTargetWorkspaceScope | null;
  conversationWorkspaceByDirectory: Map<string, Promise<ConversationWorkspaceResolution<VesloServerClient> | null>>;
};

type AppSendPromptOptions = SessionSendOptionsBase & {
  targetSessionId?: string | null;
  onMaterializedSessionId?: (handoff: MaterializedSessionHandoff) => void;
  pendingSession?: PendingSidebarSessionMetadata | null;
};

const SEND_TRACE_LIMIT = 500;

const roundSendTraceMs = (value: number) => Math.round(value * 100) / 100;

const sendTraceErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const makeSendTraceId = () => {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  return `send_${suffix.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)}`;
};

const createSendPreflightContext = (traceId?: string | null): SendPreflightContext => ({
  traceId: traceId?.trim() || makeSendTraceId(),
  managedAiReady: false,
  runtimeHealthOk: false,
  enginePrepared: false,
  effectiveSandbox: null,
  targetWorkspace: null,
  conversationWorkspaceByDirectory: new Map(),
});

const activeSendTraceId = () => {
  if (typeof window === "undefined") return null;
  return (window as SendTraceRoot).__vesloActiveSendTraceId ?? null;
};

function recordSendTrace(event: string, payload?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const root = window as SendTraceRoot;
    const logs = root.__vesloSendTrace ?? [];
    const seq = (root.__vesloSendTraceSeq ?? 0) + 1;
    root.__vesloSendTraceSeq = seq;
    const payloadTraceId = typeof payload?.traceId === "string" ? payload.traceId.trim() : "";
    const traceId = payloadTraceId || root.__vesloActiveSendTraceId || undefined;
    const perfMs = roundSendTraceMs(perfNow());
    const startPerfMsById = root.__vesloSendTraceStartPerfMsById ?? (root.__vesloSendTraceStartPerfMsById = {});
    const relativeMs =
      traceId
        ? roundSendTraceMs(perfMs - (startPerfMsById[traceId] ?? (startPerfMsById[traceId] = perfMs)))
        : undefined;
    const entry = {
      id: seq,
      at: new Date().toISOString(),
      ts: Date.now(),
      perfMs,
      ...(relativeMs !== undefined ? { relativeMs } : {}),
      source: "app",
      ...(traceId ? { traceId } : {}),
      event,
      ...(payload ?? {}),
    };
    logs.push(entry);
    if (logs.length > SEND_TRACE_LIMIT) logs.splice(0, logs.length - SEND_TRACE_LIMIT);
    root.__vesloSendTrace = logs;
    recordSendWorkflowTrace("app", event, payload);
    console.log(`[SENDTRACE] app:${event}`, entry);
    logUiEvent("send-trace", event, entry);
  } catch {
    // ignore
  }
}

const sendTraceStep = async <T,>(
  event: string,
  fn: () => Promise<T>,
  payload?: Record<string, unknown>,
): Promise<T> => {
  const startedAt = perfNow();
  recordSendTrace(`${event}:start`, payload);
  try {
    const result = await fn();
    recordSendTrace(`${event}:end`, {
      ...(payload ?? {}),
      durationMs: roundSendTraceMs(perfNow() - startedAt),
      outcome: "ok",
    });
    return result;
  } catch (error) {
    recordSendTrace(`${event}:error`, {
      ...(payload ?? {}),
      durationMs: roundSendTraceMs(perfNow() - startedAt),
      outcome: "error",
      message: sendTraceErrorMessage(error),
    });
    throw error;
  }
};

const recordExternalSendTraceEntries = (entries: unknown) => {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const event = typeof record.event === "string" ? record.event.trim() : "";
    if (!event) continue;
    const { event: _event, ...payload } = record;
    recordSendTrace(event, payload);
  }
};

function resolveDeveloperModeFromSearch(search: string) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!params.has("debug")) return false;
  const value = params.get("debug")?.trim().toLowerCase() ?? "";
  return value === "" || value === "1" || value === "true" || value === "yes" || value === "on";
}

export default function App() {
  const cloudEnvironment = resolveVesloCloudEnvironment(import.meta.env as Record<string, string | undefined>);
  const envVesloWorkspaceId = cloudEnvironment.workspaceId ?? null;
  const location = useLocation();
  const navigate = useNavigate();
  const developerMode = () => resolveDeveloperModeFromSearch(location.search);
  const appShellEnvironment = createAppShellEnvironment({
    isTauriRuntime,
  });
  const documentVisible = appShellEnvironment.documentVisible;
  const appFocused = appShellEnvironment.appFocused;

  const workspaceDebugTraceEnabled = () => {
    const root = globalThis as typeof globalThis & { __vesloWorkspaceDebugEnabled?: boolean };
    if (root.__vesloWorkspaceDebugEnabled) return true;
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem("veslo:workspace-debug") === "1";
    } catch {
      return false;
    }
  };

  // Workspace switch tracing is noisy, so only emit in developer mode.
  // Keep the runtime flag separate from developerMode so tracing can be enabled
  // without exposing developer-only UI panels.
  const wsDebugEnabled = () => developerMode() || workspaceDebugTraceEnabled();

  const wsDebug = (label: string, payload?: unknown) => {
    if (!wsDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
    } catch {
      // ignore
    }
  };

  const [creatingSession, setCreatingSession] = createSignal(false);
  const [sessionViewLockUntil, setSessionViewLockUntil] = createSignal(0);
  const appRouteSync = createAppRouteSync({
    pathname: () => location.pathname,
    navigate: (to, options) => navigate(to, options),
    isTauriRuntime,
    creatingSession,
    sessionViewLockUntil,
  });
  const {
    currentView,
    isProtoV1Ux,
    tab,
    goToDashboard,
    setTab,
    setView,
    goToSession,
  } = appRouteSync;

  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("general");

  const [startupPreference, setStartupPreference] = createSignal<StartupPreference | null>(null);
  const initialOnboardingStep = (): OnboardingStep => {
    if (typeof window === "undefined") return "welcome";
    try {
      const stored = window.localStorage.getItem(LANGUAGE_PREF_KEY);
      return isLanguage(stored) ? "welcome" : "language";
    } catch {
      return "welcome";
    }
  };
  const [onboardingStep, setOnboardingStep] =
    createSignal<OnboardingStep>(initialOnboardingStep());
  const [rememberStartupChoice, setRememberStartupChoice] = createSignal(false);
  const [denKeepSignedIn, setDenKeepSignedIn] = createSignal(readDenKeepSignedIn());
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(getInitialThemeMode());

  const setDenKeepSignedInPreference = (value: boolean) => {
    writeDenKeepSignedIn(value);
    setDenKeepSignedIn(value);
  };

  const toggleDenKeepSignedIn = () => {
    setDenKeepSignedInPreference(!denKeepSignedIn());
  };

  const [engineSource, setEngineSource] = createSignal<"path" | "sidecar" | "custom">(
    isTauriRuntime() ? "sidecar" : "path"
  );
  const [engineSourceExplicit, setEngineSourceExplicit] = createSignal(false);

  const [engineCustomBinPath, setEngineCustomBinPath] = createSignal("");

  const [engineRuntime, setEngineRuntime] = createSignal<EngineRuntime>("veslo-orchestrator");

  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:4096");
  const [clientDirectory, setClientDirectory] = createSignal("");

  const [authenticatedAccountId, setAuthenticatedAccountId] = createSignal<string | null>(null);
  const vesloServerConnection = createVesloServerConnection({
    startupPreference,
    opencodeBaseUrl: baseUrl,
    authenticatedAccountId,
    cloudEnvironment,
    documentVisible,
    developerMode: () => developerMode(),
    isTauriRuntime,
    workspace: {
      workspacesHydrated: () => workspaceStore.workspacesHydrated(),
      activeWorkspaceDisplay: () => workspaceStore.activeWorkspaceDisplay(),
      activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
      activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
      createRemoteWorkspaceFlow: (input) => workspaceStore.createRemoteWorkspaceFlow(input),
      refreshEngine: () => workspaceStore.refreshEngine(),
    },
    routedClient: () => routedClient(),
    reportError,
    setError: (message) => setError(message),
    addOpencodeCacheHint,
  });
  const {
    vesloServerSettings,
    setVesloServerSettings,
    updateVesloServerSettings,
    resetVesloServerSettings,
    vesloServerUrl,
    vesloServerStatus,
    setVesloServerStatus,
    vesloServerCapabilities,
    setVesloServerCapabilitiesStable,
    vesloServerRecentlyReachable,
    vesloServerCheckedAt,
    setVesloServerCheckedAt,
    vesloServerWorkspaceId,
    setVesloServerWorkspaceId,
    vesloServerHostInfo,
    setVesloServerHostInfoStable,
    vesloServerDiagnostics,
    vesloReconnectBusy,
    opencodeRouterInfoState,
    orchestratorStatusState,
    orchestratorEnginesState,
    readyEngineWorkspaceIds,
    vesloAuditEntries,
    setVesloAuditEntries,
    vesloAuditStatus,
    setVesloAuditStatus,
    vesloAuditError,
    setVesloAuditError,
    devtoolsWorkspaceId,
    setDevtoolsWorkspaceId,
    activeVesloServerHostInfo,
    activeVesloServerRoutingInfo,
    vesloServerBaseUrl,
    vesloServerAuth,
    vesloServerClient,
    sessionArchiveOwnerKey,
    vesloArchiveClient,
    gatewayVesloServerClient,
    managedAiGatewayBaseUrl,
    devtoolsVesloClient,
    checkVesloServer,
    testVesloServerConnection,
    reconnectVesloServer,
    ensureLocalVesloServerRunning,
  } = vesloServerConnection;
  const directoryQueryPathMode = () =>
    resolveRuntimeSandboxStateForTarget().directoryQueryMode;
  const updateEngineSource = (
    value: EngineSourcePreference,
    options?: {
      explicit?: boolean;
    },
  ) => {
    setEngineSource(value);
    setEngineSourceExplicit(options?.explicit === true);
  };

  const [client, setClient] = createSignal<Client | null>(null);

  // VSLO-171 F3Ú9 — Performance pool settings forwarded to orchestrator.
  const [maxEngines, setMaxEngines] = createSignal(16);
  const [idleSuspendMs, setIdleSuspendMs] = createSignal(0);

  // VSLO-171 — workspace routing service. Multi mode is the only mode (no
  // single-active fallback, no feature flag). Instantiated before
  // createSessionStore so memos that read routing.mode() at init can resolve.
  let workspaceStoreRef: ReturnType<typeof createWorkspaceStore> | null = null;
  const [workspaceStoreRefVersion, setWorkspaceStoreRefVersion] = createSignal(0);
  const currentWorkspaceStoreRef = () => {
    workspaceStoreRefVersion();
    return workspaceStoreRef;
  };
  const activateWorkspaceThroughBrowsePolicy = (
    workspaceId: string | undefined,
    options: Parameters<ReturnType<typeof createWorkspaceStore>["activateWorkspace"]>[1],
  ) => {
    const store = currentWorkspaceStoreRef();
    if (!store) return Promise.resolve(false);
    return activateWorkspaceWithBrowsePolicy(store, workspaceId, options);
  };
  const workspaceRouting = createWorkspaceRouting({
    clientSource: client,
    activeWorkspaceId: () => currentWorkspaceStoreRef()?.activeWorkspaceId().trim() ?? "",
    createClient: (baseUrl, directory, auth) => createClient(baseUrl, directory, auth),
    waitForHealthy: (c, opts) => waitForHealthy(c, opts),
  });

  const [connectedVersion, setConnectedVersion] = createSignal<string | null>(
    null
  );
  const [sseConnected, setSseConnected] = createSignal(false);
  const [sessionReconnectNotice, setSessionReconnectNotice] = createSignal<ReconnectNotice | null>(null);

  const [busy, setBusy] = createSignal(false);
  const [busyLabel, setBusyLabel] = createSignal<string | null>(null);
  const [busyStartedAt, setBusyStartedAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [opencodeConnectStatus, setOpencodeConnectStatus] = createSignal<OpencodeConnectStatus | null>(null);
  const [booting, setBooting] = createSignal(true);
  const openDesktopAuthUrl = async (url: string) => {
    if (isTauriRuntime()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };
  let managedAiAccessStoreRef: ManagedAiAccessStore | null = null;
  let pendingManagedAiAccessRefreshFromAuth = false;
  const requestManagedAiAccessRefreshFromAuth = () => {
    if (managedAiAccessStoreRef) {
      managedAiAccessStoreRef.requestManagedAiAccessRefresh();
      return;
    }
    pendingManagedAiAccessRefreshFromAuth = true;
  };
  const clearManagedAiAccessCacheFromAuth = () => {
    managedAiAccessStoreRef?.clearManagedAiAccessCache();
  };
  const denDesktopAuthWorkflow = createDenDesktopAuthWorkflow({
    isTauriRuntime,
    workspace: {
      activeWorkspaceId: () => currentWorkspaceStoreRef()?.activeWorkspaceId() ?? "",
      bootstrapOnboarding: async () => currentWorkspaceStoreRef()?.bootstrapOnboarding() ?? false,
    },
    ui: {
      setError,
      setOnboardingStep,
      setView,
      setBooting,
    },
    managedAi: {
      clearManagedAiAccessCache: clearManagedAiAccessCacheFromAuth,
      requestManagedAiAccessRefresh: requestManagedAiAccessRefreshFromAuth,
    },
    account: {
      setAuthenticatedAccountId,
    },
    diagnostics: {
      setBootstrapDiagnosticsCloudContext,
      clearBootstrapDiagnosticsCloudContext,
      recordBootstrapDiagnostic,
    },
    browser: {
      openDesktopAuthUrl,
    },
    safeStringify,
  });
  const {
    denAuthRevision,
    authCompleteExchangeBusy,
    authenticatedUser,
    logout: logoutLocalDenAuth,
    startDesktopBrowserSignIn,
    resumeDesktopBrowserSignIn,
    queueAuthCompleteDeepLink,
  } = denDesktopAuthWorkflow;
  // Send-timeout fix 2026-06-10 — boots false: on cold/lazy boot no engine is
  // running, and the old initial `true` opened a window where engineReady
  // guards (permission polls, MCP status, capabilities) passed and their GETs
  // cold-spawned the engine through the orchestrator proxy (up to 60s each).
  // connectToServer/onEngineStable flips this true after a successful connect.
  const [engineReady, setEngineReady] = createSignal(false);
  const runtimeOwner = createRuntimeOwner({
    activeWorkspaceId: () => currentWorkspaceStoreRef()?.activeWorkspaceId().trim() ?? "",
    activeLegacyEngineReady: () => engineReady(),
    readyEngineWorkspaceIds,
    requiresOrchestratorReadiness: (workspaceId) => {
      if (!isTauriRuntime() || engineRuntime() !== "veslo-orchestrator") return false;
      const workspace = currentWorkspaceStoreRef()?.workspaces().find((entry) => entry.id === workspaceId);
      return workspace?.workspaceType === "local";
    },
    workspaceBusy: () => currentWorkspaceStoreRef()?.workspaceBusy() ?? {},
    routing: workspaceRouting,
  });
  const runtimeOwnedRouting = createRuntimeOwnedRouting(workspaceRouting, runtimeOwner);
  const routedClient = (workspaceId?: string) => runtimeOwner.client(workspaceId);
  const isWorkspaceRuntimeReady = runtimeOwner.isWorkspaceRuntimeReady;

  // VSLO-171 F3Ú8: cross-workspace takeover confirmation dialog removed.
  // See comment in sendPrompt about replacement strategy.

  const mountTime = Date.now();

  createEffect(() => {
    if (developerMode()) return;
    clearPerfLogs();
  });

  const pendingSessionDraftController = createPendingSessionDraftController({
    isTauriRuntime,
    createSessionAndOpen,
    createEmptyComposerDraft,
    pendingSessionDraftsList,
    pendingSessionDraftsGet,
    pendingSessionDraftsPut,
    pendingSessionDraftsDelete,
    workspace: {
      activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
      activeWorkspaceDisplay: () => workspaceStore.activeWorkspaceDisplay(),
      workspaces: () => workspaceStore.workspaces(),
      activateWorkspace: activateWorkspaceThroughBrowsePolicy,
      createScratchWorkspace: () => workspaceStore.createScratchWorkspace(),
      forgetWorkspace: (workspaceId, options) => workspaceStore.forgetWorkspace(workspaceId, options),
      pickWorkspaceFolder: () => workspaceStore.pickWorkspaceFolder(),
      ensureWorkspaceForFolder: (folder) => workspaceStore.ensureWorkspaceForFolder(folder),
    },
    publishRegisteredWorkspaceToSidebar: (workspaceId) => publishRegisteredWorkspaceToSidebar(workspaceId),
    setComposerDraftBySessionId: (updater) => setComposerDraftBySessionId(updater),
    clearDisplayedSession: () => {
      batch(() => {
        setSelectedSessionId(null);
        setMessages([]);
        setTodos([]);
      });
    },
    setView,
    setError,
    reportError,
    onOpenNewSessionFailure: (input) => {
      if (!isTauriRuntime()) return;
      void recordBootstrapDiagnostic("new-session:open-failed", {
        scope: input.scope,
        workspaceId: input.workspaceId?.trim() || null,
        directory: input.directory?.trim() || null,
        message: input.error instanceof Error ? input.error.message : safeStringify(input.error),
      });
    },
    safeStringify,
    addOpencodeCacheHint,
  });
  const openNewSessionWithDirectory = async () => {
    const opened = await pendingSessionDraftController.openNewSessionWithDirectory();
    if (opened !== false && isTauriRuntime()) {
      void ensureLocalVesloServerRunning({ ignoreStartupPreference: true }).catch((error) => {
        reportError(error, "veslo-server.ensure.new-chat");
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
      });
    }
    return opened;
  };
  const {
    activePendingDraftKey,
    setActivePendingDraftKey,
    activePendingDraftMeta,
    setActivePendingDraftMeta,
    activePendingDraftStorageReady,
    markPendingDraftConsumed,
    clearConsumedPendingDraftId,
    clearActivePendingDraftState,
  } = pendingSessionDraftController;
  const workspaceSessionSelection = createWorkspaceSessionSelection({
    activeWorkspaceId: () => currentWorkspaceStoreRef()?.activeWorkspaceId() ?? "",
    activeWorkspaceRoot: () => currentWorkspaceStoreRef()?.activeWorkspaceRoot().trim() ?? "",
    workspaces: () => currentWorkspaceStoreRef()?.workspaces() ?? [],
  });
  const {
    selectedSessionId,
    setSelectedSessionId,
    rememberConversationScope,
    resolveSelectedSessionBrowseScope,
    captureDisplayedConversationGuard,
    displayedConversationStillMatches,
    rememberLatestConversationRunId,
    resolveLatestConversationRunId,
    setSessionBrowseScope,
    resolveWorkspaceRootForConversationScope,
    rememberConversationScopesFromSessions,
    rememberConversationScopeFromTranscript,
    clearWorkspaceLastSessionIfSelected,
    moveWorkspaceLastSession,
    activeWorkspaceLastSessionId,
    scopedSessionIds,
    activeUiConversationRef,
    activeUiScopeToken,
    isUiScopeTokenCurrent,
  } = workspaceSessionSelection;
  const [unreadSessionIds, setUnreadSessionIds] = createSignal<UnreadSessionMap>({});
  const SESSION_DIRECTORY_OVERRIDE_KEY = "veslo.session-workspace-override.v1";
  const readSessionDirectoryOverrides = () => {
    if (typeof window === "undefined") return {} as Record<string, string>;
    try {
      const raw = window.localStorage.getItem(SESSION_DIRECTORY_OVERRIDE_KEY);
      if (!raw) return {} as Record<string, string>;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {} as Record<string, string>;
      return parsed as Record<string, string>;
    } catch {
      return {} as Record<string, string>;
    }
  };
  const writeSessionDirectoryOverrides = (map: Record<string, string>) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SESSION_DIRECTORY_OVERRIDE_KEY, JSON.stringify(map));
    } catch {
      // ignore
    }
  };
  const [sessionDirectoryOverrideById, setSessionDirectoryOverrideById] = createSignal<
    Record<string, string>
  >(readSessionDirectoryOverrides());
  const persistSessionDirectoryOverride = (sessionID: string, directory?: string | null) => {
    const id = sessionID.trim();
    if (!id) return;
    const normalized = normalizeDirectoryPath(directory ?? "");
    setSessionDirectoryOverrideById((current) => {
      const next = { ...current };
      if (normalized) {
        next[id] = normalized;
      } else {
        delete next[id];
      }
      writeSessionDirectoryOverrides(next);
      return next;
    });
  };
  const resolveSessionDirectory = (session: Pick<Session, "id" | "directory">) =>
    normalizeDirectoryPath(sessionDirectoryOverrideById()[session.id] ?? session.directory ?? "");
  const applySessionDirectoryOverride = <T extends Session | SidebarSessionItem>(session: T): T => {
    const override = sessionDirectoryOverrideById()[session.id]?.trim() ?? "";
    if (!override) return session;
    if ((session.directory ?? "").trim() === override) return session;
    return { ...session, directory: override } as T;
  };
  const BACKEND_PLACEHOLDER_SESSION_TITLE_PATTERN = /^New session(?:\s*[-–—]\s*.+)?$/i;
  const isBackendPlaceholderSessionTitle = (title?: string | null) => {
    const normalized = title?.trim() ?? "";
    return !normalized || BACKEND_PLACEHOLDER_SESSION_TITLE_PATTERN.test(normalized);
  };
  const [pendingInitialSessionTitleById, setPendingInitialSessionTitleById] = createSignal<
    Record<string, string>
  >({});
  const registerPendingInitialSessionTitle = (sessionId: string, title: string) => {
    const id = sessionId.trim();
    const cleanTitle = title.trim();
    if (!id || !cleanTitle) return;
    setPendingInitialSessionTitleById((current) => ({ ...current, [id]: cleanTitle }));
  };
  const applyPendingInitialSessionTitle = <T extends Session | SidebarSessionItem>(session: T): T => {
    const pendingTitle = pendingInitialSessionTitleById()[session.id]?.trim() ?? "";
    if (!pendingTitle || !isBackendPlaceholderSessionTitle(session.title)) return session;
    if (session.title === pendingTitle) return session;
    return { ...session, title: pendingTitle } as T;
  };
  const [sessionModelOverrideById, setSessionModelOverrideById] = createSignal<
    Record<string, ModelRef>
  >({});
  const [sessionModelById, setSessionModelById] = createSignal<
    Record<string, ModelRef>
  >({});
  const [workspaceDefaultModelReady, setWorkspaceDefaultModelReady] = createSignal(false);
  const [legacyDefaultModel, setLegacyDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [defaultModelExplicit, setDefaultModelExplicit] = createSignal(false);
  const [sessionAgentById, setSessionAgentById] = createSignal<Record<string, string>>({});

  const SKILL_HOT_RELOAD_GRACE_MS = 5000;
  let markReloadRequiredHandler: ((reason: ReloadReason, trigger?: ReloadTrigger) => void) | undefined;
  let onHotReloadAppliedHandler: (() => void) | undefined;
  const [pendingSkillFallbackAutoReload, setPendingSkillFallbackAutoReload] = createSignal(false);
  const skillReloadGuard = createSkillReloadGuard({
    graceMs: SKILL_HOT_RELOAD_GRACE_MS,
    onFallbackNeeded: (trigger) => {
      markReloadRequiredHandler?.("skills", trigger);
      setPendingSkillFallbackAutoReload(true);
    },
  });

  const markReloadRequired = (reason: ReloadReason, trigger?: ReloadTrigger) => {
    if (reason === "skills") {
      skillReloadGuard.scheduleSkillFallback(trigger);
      return;
    }

    markReloadRequiredHandler?.(reason, trigger);
  };

  onCleanup(() => {
    skillReloadGuard.dispose();
  });

  const conversationService = createConversationService({
    vesloServerClient,
    vesloServerStatus,
    isTauriRuntime,
    startupPreference,
    ensureLocalVesloServerRunning: () => ensureLocalVesloServerRunning(),
    workspaces: () => workspaceStore.workspaces(),
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId().trim(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot().trim(),
    sessionDirectoryOverrideById,
    resolveSelectedSessionBrowseScope,
    resolveWorkspaceRootForConversationScope,
    rememberConversationScope,
    rememberConversationScopesFromSessions,
    rememberConversationScopeFromTranscript,
    rememberLatestConversationRunId,
    resolveLatestConversationRunId,
    managedAiAccess: () => managedAiAccess(),
    activeSendTraceId,
    recordSendTrace,
    sendTraceStep,
    recordExternalSendTraceEntries,
    engineInfo: (workspaceId, directory) => engineInfo(workspaceId, directory),
    wsDebug: (event, payload) => wsDebug(event, payload),
  });
  const {
    resolveConversationServerWorkspaceId,
    resolvePassiveConversationReadClient,
    ensureConversationReadWorkspaceRegistered,
    resolveConversationServerWorkspaceForSend,
    listConversationsFromVesloReadApi,
    backfillConversationsToVesloReadApi,
    getTranscriptFromVesloReadApi,
    createConversationFromVesloWriteApi,
    runConversationFromVesloWriteApi,
    resolveConversationAbortScope,
    abortConversationFromVesloWriteApi,
    resolveConversationRunForSession,
    readConversationRunStatus,
  } = conversationService;
  const sessionStore = createSessionStore({
    client,
    routing: runtimeOwnedRouting,
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot().trim(),
    selectedSessionId,
    setSelectedSessionId,
    directoryQueryPathMode,
    selectSessionScopeKey: (sessionId) => {
      const id = sessionId.trim();
      const scope = id ? resolveSelectedSessionBrowseScope(id) : null;
      const workspaceId = scope?.workspaceId?.trim() || workspaceStore.activeWorkspaceId().trim();
      const scopedId = [
        id,
        scope?.conversationId?.trim() ?? "",
        scope?.opencodeSessionId?.trim() ?? "",
      ].filter(Boolean).join("\0") || id;
      return createUiConversationKey({
        workspaceId,
        kind: "session",
        id: scopedId,
      });
    },
    resolveSessionWorkspaceId: (sessionId) =>
      resolveSelectedSessionBrowseScope(sessionId)?.workspaceId ?? null,
    sessionDirectoryOverrideById,
    developerMode: wsDebugEnabled,
    setError,
    setSseConnected,
    onReconnectNotice: (notice) => setSessionReconnectNotice(notice),
    markReloadRequired,
    onHotReloadApplied: () => {
      onHotReloadAppliedHandler?.();
    },
    conversationReader: () => ({
      listConversations: async (workspaceId, directory, options) => {
        const result = await listConversationsFromVesloReadApi(workspaceId, directory, options);
        return { items: result.items, source: result.source };
      },
    }),
    shouldBrowseSessionFromDb: (sessionId) => {
      const transcriptScope = resolveSelectedSessionBrowseScope(sessionId);
      if (transcriptScope) return true;
      return !isWorkspaceRuntimeReady(workspaceStore.activeWorkspaceId().trim());
    },
    onAssistantResponseObserved: (sessionId) => {
      setUnreadSessionIds((current) =>
        markUnreadAfterAssistantResponse(current, {
          responseSessionId: sessionId,
          selectedSessionId: selectedSessionId(),
          appFocused: appFocused(),
        }),
      );
    },
    loadOfflineTranscript: async (sessionId, limit) => {
      const transcriptScope = resolveSelectedSessionBrowseScope(sessionId);
      const transcriptWorkspaceId = transcriptScope?.workspaceId ?? workspaceStore.activeWorkspaceId().trim();
      const workspaceRoot = transcriptScope?.workspaceRoot || workspaceStore.activeWorkspaceRoot().trim();
      const transcriptDirectory = transcriptScope?.directory || workspaceRoot;
      if (!workspaceRoot) return null;
      return await getTranscriptFromVesloReadApi(
        transcriptWorkspaceId,
        sessionId,
        limit,
        transcriptDirectory || undefined,
      );
    },
    resolveConversationRunForSession,
    readConversationRunStatus,
    appendTranscriptSnapshot: async (input) => {
      const workspaceId = input.workspaceId.trim();
      const sessionId = input.sessionId.trim();
      const directory = input.directory?.trim() || undefined;
      const hasDeletedMessages = (input.deletedMessageIds?.length ?? 0) > 0;
      const hasDeletedParts = Object.values(input.deletedPartsByMessageId ?? {})
        .some((partIds) => partIds.length > 0);
      if (!workspaceId || !sessionId || (input.messages.length === 0 && !hasDeletedMessages && !hasDeletedParts)) return;
      const serverClient = hydratedVesloServerClient();
      if (!serverClient) return;
      const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
      if (!serverWorkspaceId) return;
      await serverClient.appendSessionTranscript(serverWorkspaceId, sessionId, {
        directory,
        limit: input.limit,
        reason: input.reason,
        messages: input.messages,
        partsByMessageId: input.partsByMessageId,
        deletedMessageIds: input.deletedMessageIds,
        deletedPartsByMessageId: input.deletedPartsByMessageId,
      });
    },
    // VSLO-86 — selectSession uses this to decide between the offline DB
    // transcript (browse mode) and a live SDK call that would cold-spawn the
    // engine. engineReady() flips to true only after sendPrompt has driven
    // the engine through ensureEngineForWorkspace.
    engineReady: () => engineReady(),
    isWorkspaceRuntimeReady,
    onSessionBusyChange: (sessionId, busy, sourceWorkspaceId) => {
      const wsId = sourceWorkspaceId?.trim() || workspaceStore.activeWorkspaceId().trim();
      if (!wsId) return;
      if (busy) workspaceStore.markWorkspaceBusy(wsId, sessionId);
      else workspaceStore.clearWorkspaceBusy(wsId, sessionId);
    },
  });

  const {
    sessions,
    sessionStatusById,
    selectedSession,
    messages,
    todos,
    pendingPermissions,
    permissionReplyBusy,
    pendingQuestions,
    activeQuestion,
    questionReplyBusy,
    events,
    activePermission,
    loadSessions,
    refreshPendingPermissions,
    refreshPendingQuestions,
    selectSession,
    loadEarlierMessages,
    renameSession,
    respondPermission,
    respondQuestion,
    setSessions,
    setSessionStatusById,
    setMessages,
    setTodos,
    setPendingPermissions,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    hydrateTranscriptSnapshot,
    hasWarmTranscript,
  } = sessionStore;

  const [visibleRuntimeActivityHold, setVisibleRuntimeActivityHold] = createSignal<{
    sessionId: string;
    token: string;
    expiresAt: number;
  } | null>(null);
  let visibleRuntimeActivityHoldTimer: number | null = null;
  onCleanup(() => {
    if (visibleRuntimeActivityHoldTimer !== null) {
      window.clearTimeout(visibleRuntimeActivityHoldTimer);
      visibleRuntimeActivityHoldTimer = null;
    }
  });
  const holdVisibleRuntimeActivity = (sessionId: string | null | undefined, reason: string) => {
    const id = sessionId?.trim();
    if (!id || isPendingSessionInstanceId(id)) return;
    const token = `run-handoff:${id}`;
    const expiresAt = Date.now() + 3_000;
    setVisibleRuntimeActivityHold({ sessionId: id, token, expiresAt });
    if (visibleRuntimeActivityHoldTimer !== null) {
      window.clearTimeout(visibleRuntimeActivityHoldTimer);
    }
    visibleRuntimeActivityHoldTimer = window.setTimeout(() => {
      visibleRuntimeActivityHoldTimer = null;
      setVisibleRuntimeActivityHold((current) => (current?.token === token ? null : current));
    }, Math.max(0, expiresAt - Date.now()));
    recordPerfLog(developerMode(), "session.run", "visible-runtime-hold", {
      sessionId: id,
      reason,
      token,
    });
  };

  const workspaceIdForSessionStatus = (sessionId: string | null | undefined) => {
    const id = sessionId?.trim() ?? "";
    const scope = id ? resolveSelectedSessionBrowseScope(id) : null;
    return scope?.workspaceId?.trim() || workspaceStore.activeWorkspaceId().trim();
  };

  const statusForSession = (
    sessionId: string | null | undefined,
    workspaceId?: string | null,
  ) => {
    const id = sessionId?.trim() ?? "";
    if (!id) return "idle";
    const scope = resolveSelectedSessionBrowseScope(id);
    const resolvedWorkspaceId = workspaceId?.trim() || scope?.workspaceId?.trim() || workspaceIdForSessionStatus(id);
    const ids = [
      id,
      scope?.opencodeSessionId?.trim() ?? "",
      scope?.conversationId?.trim() ?? "",
    ].filter(Boolean);
    for (const candidate of [...new Set(ids)]) {
      const status = readSessionStatus(sessionStatusById(), resolvedWorkspaceId, candidate);
      if (status !== "idle") return status;
    }
    return "idle";
  };

  const visibleSelectedSessionStatus = createMemo(() => {
    const ref = activeUiConversationRef();
    return statusForSession(ref.sessionId, ref.workspaceId);
  });

  const activeVisibleRuntimeActivityId = () => {
    const sendTraceId = activeSendTraceId()?.trim();
    if (sendTraceId) return sendTraceId;

    const sessionId = selectedSessionId()?.trim();
    if (!sessionId || isPendingSessionInstanceId(sessionId)) return null;
    const status = statusForSession(sessionId);
    if (status === "running" || status === "retry") return `run:${sessionId}`;
    const hold = visibleRuntimeActivityHold();
    if (hold?.sessionId === sessionId && hold.expiresAt > Date.now()) return hold.token;
    return null;
  };

  createEffect(() => {
    const pending = pendingInitialSessionTitleById();
    const currentSessions = sessions();
    let changed = false;
    const next = { ...pending };
    for (const session of currentSessions) {
      if (!pending[session.id]) continue;
      if (isBackendPlaceholderSessionTitle(session.title)) continue;
      delete next[session.id];
      changed = true;
    }
    if (changed) setPendingInitialSessionTitleById(next);
  });

  const selectedSessionDisplayTitle = createMemo(() => {
    const session = selectedSession();
    return session ? applyPendingInitialSessionTitle(session).title ?? null : null;
  });

  createEffect(() => {
    const id = selectedSessionId();
    if (!id) return;
    setUnreadSessionIds((current) => clearUnreadSession(current, id));
  });

  createEffect(() => {
    if (!appFocused()) return;
    const id = selectedSessionId();
    if (!id) return;
    setUnreadSessionIds((current) => clearUnreadSession(current, id));
  });

  const hydratedVesloServerClient = createMemo<VesloServerClient | null>(() => {
    const client = vesloServerClient();
    if (!client) return null;

    const hydratedClient: VesloServerClient = {
      ...client,
      prefetchSessionTranscripts: async (workspaceId, input) => {
        const result = await client.prefetchSessionTranscripts(workspaceId, input);
        for (const item of result.items) {
          rememberConversationScopeFromTranscript(workspaceId, undefined, item);
          hydrateTranscriptSnapshot(item);
        }
        return result;
      },
      getSessionTranscript: async (workspaceId, sessionId, limit = 140, directory) => {
        const snapshot = await client.getSessionTranscript(workspaceId, sessionId, limit, directory);
        rememberConversationScopeFromTranscript(workspaceId, directory, snapshot);
        hydrateTranscriptSnapshot(snapshot);
        return snapshot;
      },
      appendSessionTranscript: async (workspaceId, sessionId, input) => {
        const snapshot = await client.appendSessionTranscript(workspaceId, sessionId, input);
        rememberConversationScopeFromTranscript(workspaceId, input.directory ?? undefined, snapshot);
        hydrateTranscriptSnapshot(snapshot, { allowShorter: true });
        return snapshot;
      },
    };

    return hydratedClient;
  });

  const ARTIFACT_SCAN_MESSAGE_WINDOW = 220;
  const artifacts = createMemo(() =>
    deriveArtifacts(messages(), { maxMessages: ARTIFACT_SCAN_MESSAGE_WINDOW }),
  );
  const workingFiles = createMemo(() => deriveWorkingFiles(artifacts()));
  const [latestRunArtifactResponse, setLatestRunArtifactResponse] = createSignal<VesloSessionLatestRunArtifacts | undefined>(undefined);
  const activeSessionId = createMemo(() => selectedSessionId());
  const activeSessions = createMemo(() => sessions());
  const activeSessionStatusById = createMemo(() => sessionStatusById());
  const busySessionByWorkspaceId = createMemo<WorkspaceBusyMap>(
    () => currentWorkspaceStoreRef()?.workspaceBusy() ?? {},
  );
  const hasWorkspaceBusySessions = (
    busyByWorkspace: WorkspaceBusyMap,
    workspaceId: string | null | undefined,
  ) => Object.keys(busyByWorkspace[workspaceId?.trim() ?? ""] ?? {}).length > 0;
  const hasAnyWorkspaceBusySessions = (busyByWorkspace: WorkspaceBusyMap) =>
    Object.values(busyByWorkspace).some((sessions) => Object.keys(sessions).length > 0);
  const activeConversationBusy = createMemo(() => {
    const sessionId = activeSessionId();
    const scope = sessionId ? resolveSelectedSessionBrowseScope(sessionId) : null;
    const workspaceId = scope?.workspaceId?.trim() || currentWorkspaceStoreRef()?.activeWorkspaceId().trim() || "";
    const sessionsForWorkspace = workspaceId ? busySessionByWorkspaceId()[workspaceId] : null;
    if (!sessionsForWorkspace || !sessionId) return false;
    return [
      sessionId,
      scope?.opencodeSessionId?.trim() ?? "",
      scope?.conversationId?.trim() ?? "",
    ].filter(Boolean).some((id) => Boolean(sessionsForWorkspace[id]));
  });
  const activeComposerBusy = createMemo(() => {
    if (activeConversationBusy()) return true;
    const label = busyLabel();
    if (label === "status.running") return false;
    return busy();
  });
  const activeMessages = createMemo(() => messages());
  const activeTodos = createMemo(() => todos());
  const activeArtifacts = createMemo(() => artifacts());
  const activeWorkingFiles = createMemo(() => workingFiles());
  const [latestRunArtifactResponseKey, setLatestRunArtifactResponseKey] = createSignal("");
  const latestRunArtifactScope = createMemo(() => {
    const sessionId = selectedSessionId()?.trim() ?? "";
    if (!sessionId) return null;
    if (isPendingSessionInstanceId(sessionId)) return null;
    const scope = resolveSelectedSessionBrowseScope(sessionId);
    const workspaceId = scope?.workspaceId?.trim() || workspaceStore.activeWorkspaceId().trim();
    const workspaceRoot = scope?.workspaceRoot?.trim() || workspaceStore.activeWorkspaceRoot().trim();
    const directory = scope?.directory?.trim() || sessionDirectoryOverrideById()[sessionId]?.trim() || workspaceRoot;
    if (!workspaceId || !directory) return null;
    return { sessionId, workspaceId, directory };
  });
  const latestRunArtifactRefreshKey = createMemo(() => {
    const client = vesloServerClient();
    const scope = latestRunArtifactScope();
    if (!client || !scope || vesloServerStatus() !== "connected") return "";

    const list = messages();
    let partCount = 0;
    let lastUserMessageId = "";
    for (const message of list) {
      partCount += Array.isArray(message.parts) ? message.parts.length : 0;
      const role = typeof message.info?.role === "string" ? message.info.role : "";
      if (role === "user" && typeof message.info?.id === "string") {
        lastUserMessageId = message.info.id;
      }
    }

    return [
      scope.workspaceId,
      scope.directory,
      scope.sessionId,
      lastUserMessageId,
      String(partCount),
    ].join(":");
  });
  const currentLatestRunArtifactResponse = createMemo(() => {
    const response = latestRunArtifactResponse();
    const key = latestRunArtifactRefreshKey();
    if (!response || !key || latestRunArtifactResponseKey() !== key) return undefined;
    return response;
  });
  createEffect(() => {
    const key = latestRunArtifactRefreshKey();
    if (!key) {
      setLatestRunArtifactResponse(undefined);
      setLatestRunArtifactResponseKey("");
      return;
    }

    const client = vesloServerClient();
    const scope = latestRunArtifactScope();
    if (!client || !scope) {
      setLatestRunArtifactResponse(undefined);
      setLatestRunArtifactResponseKey("");
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(
          client,
          scope.workspaceId,
          scope.directory,
        );
        if (!serverWorkspaceId) return null;
        return await client.getSessionLatestRunArtifacts(serverWorkspaceId, scope.sessionId, scope.directory);
      })()
        .then((response) => {
          if (cancelled) return;
          if (!response) {
            setLatestRunArtifactResponse(undefined);
            setLatestRunArtifactResponseKey("");
            return;
          }
          if (response.sessionId !== scope.sessionId) return;
          setLatestRunArtifactResponse(response);
          setLatestRunArtifactResponseKey(key);
        })
        .catch(() => {
          if (cancelled) return;
          setLatestRunArtifactResponse(undefined);
          setLatestRunArtifactResponseKey("");
        });
    }, 120);

    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
  });

  type SessionsLoadReadyState = {
    workspaceId: string;
    workspaceRoot: string;
    scopeRoot: string;
    loadedAt: number;
  };

  const [sessionsLoadReady, setSessionsLoadReady] = createSignal<SessionsLoadReadyState | null>(null);
  const normalizeSessionLoadRoot = (value?: string | null) => normalizeDirectoryPath(value?.trim() ?? "");
  const resolveSessionsLoadReadyScope = (scopeRoot?: string): Omit<SessionsLoadReadyState, "loadedAt"> => {
    const requestedRoot = normalizeSessionLoadRoot(scopeRoot);
    const activeId = workspaceStore.activeWorkspaceId().trim();
    const activeRoot = normalizeSessionLoadRoot(workspaceStore.activeWorkspaceRoot());
    const workspaceByRoot = requestedRoot
      ? workspaceStore.workspaces().find((item) => {
        const candidates = [
          normalizeSessionLoadRoot(item.path),
          normalizeSessionLoadRoot(item.directory),
        ].filter(Boolean);
        return candidates.includes(requestedRoot);
      })
      : undefined;
    const workspaceByActiveId = activeId
      ? workspaceStore.workspaces().find((item) => item.id === activeId)
      : undefined;
    const workspace = workspaceByRoot || workspaceByActiveId || null;
    const workspaceRoot =
      normalizeSessionLoadRoot(workspace?.path) ||
      normalizeSessionLoadRoot(workspace?.directory) ||
      requestedRoot ||
      activeRoot;
    return {
      workspaceId: workspace?.id?.trim() || activeId,
      workspaceRoot,
      scopeRoot: requestedRoot || workspaceRoot,
    };
  };
  const loadSessionsWithReady = async (scopeRoot?: string) => {
    const readyScope = resolveSessionsLoadReadyScope(scopeRoot);
    await loadSessions(scopeRoot);
    setSessionsLoadReady({ ...readyScope, loadedAt: Date.now() });
  };

  const activeWorkspaceIsHydrated = () => {
    const activeWorkspaceId = workspaceStore.activeWorkspaceId().trim();
    if (!activeWorkspaceId || !workspaceStore.workspacesHydrated()) return false;
    return workspaceStore.workspaces().some((workspace) => workspace.id === activeWorkspaceId);
  };
  const activeWorkspaceHasRoutingEntry = () => {
    const activeWorkspaceId = workspaceStore.activeWorkspaceId().trim();
    workspaceRouting.entryIds();
    return Boolean(activeWorkspaceId && workspaceRouting.entry(activeWorkspaceId));
  };
  const sessionsLoadedForActiveWorkspace = () => {
    const activeWorkspaceId = workspaceStore.activeWorkspaceId().trim();
    const activeWorkspaceRoot = normalizeSessionLoadRoot(workspaceStore.activeWorkspaceRoot());
    const ready = sessionsLoadReady();
    workspaceRouting.entryIds();
    if (!activeWorkspaceId || !activeWorkspaceIsHydrated() || !ready) return false;
    if (!workspaceRouting.entry(activeWorkspaceId) && !routedClient(activeWorkspaceId)) return false;
    if (ready.workspaceId !== activeWorkspaceId) return false;
    if (activeWorkspaceRoot && ready.workspaceRoot && ready.workspaceRoot !== activeWorkspaceRoot) return false;
    return true;
  };

  const [composerDraftBySessionId, setComposerDraftBySessionId] = createSignal<Record<string, ComposerDraft>>({});
  const currentComposerStorageKey = createMemo(() => {
    const sessionId = selectedSessionId();
    if (sessionId) {
      return resolveComposerStorageKey({ sessionId });
    }
    return resolveComposerStorageKey({ pendingDraftKey: activePendingDraftKey() });
  });
  const composerDraft = createMemo(() =>
    getSessionComposerDraft(composerDraftBySessionId(), { storageKey: currentComposerStorageKey() }),
  );
  const setComposerDraft = (draft: ComposerDraft) => {
    setComposerDraftBySessionId((current) => setSessionComposerDraft(current, { storageKey: currentComposerStorageKey() }, draft));
  };
  const clearComposerDraftForSession = (sessionId: string | null | undefined) => {
    const trimmed = sessionId?.trim() ?? "";
    if (!trimmed) return;
    setComposerDraftBySessionId((current) => deleteSessionComposerDraft(current, { sessionId: trimmed }));
  };
  const setPrompt = (value: string) => {
    setComposerDraftBySessionId((current) => setSessionComposerPrompt(current, { storageKey: currentComposerStorageKey() }, value));
  };
  const prompt = createMemo(() => composerDraft().text);
  const [lastPromptSent, setLastPromptSent] = createSignal("");

  const sessionAttachmentStaging = createSessionAttachmentStaging({
    vesloServerClient,
    vesloServerStatus,
    vesloServerWorkspaceId,
    setVesloServerWorkspaceId,
    vesloServerUrl,
    envVesloWorkspaceId,
    workspaceProjectDir: () => workspaceStore.projectDir(),
    sessionDirectoryForId: (sessionID) => sessionDirectoryOverrideById()[sessionID] ?? workspaceStore.projectDir(),
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId().trim(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot().trim(),
    activeWorkspaceDisplay: () => workspaceStore.activeWorkspaceDisplay(),
    selectedSessionBrowseScope: (sessionID) => resolveSelectedSessionBrowseScope(sessionID),
    isTauriRuntime,
    startupPreference: () => startupPreference() ?? "local",
    vesloServerRestart,
    setVesloServerHostInfoStable: (info) => setVesloServerHostInfoStable(info as VesloServerInfo | null),
    setVesloServerStatus,
    setVesloServerCapabilitiesStable: (capabilities) => setVesloServerCapabilitiesStable(capabilities as ReturnType<typeof vesloServerCapabilities>),
    setVesloServerCheckedAt,
    checkVesloServer,
    resolveConversationServerWorkspaceForSend,
    recordSendTrace,
    sendTraceStep,
    safeStringify,
  });
  const {
    stageAttachmentsIntoSessionDirectory,
    buildPromptParts,
    buildCommandFileParts,
  } = sessionAttachmentStaging;

  async function maybeResolveSkillCommand(
    draft: ComposerDraft,
    traceId?: string | null,
    targetWorkspace?: SendTargetWorkspaceScope | null,
  ): Promise<ComposerDraft> {
    const tracePayload = traceId ? { traceId } : undefined;
    if (draft.mode !== "prompt" || draft.command) {
      recordSendTrace("maybeResolveSkillCommand:skipped-mode-or-command", {
        ...(tracePayload ?? {}),
        mode: draft.mode,
        hasCommand: Boolean(draft.command),
      });
      return draft;
    }

    const text = (draft.resolvedText ?? draft.text).trim();
    if (!text || text.startsWith("/")) {
      recordSendTrace("maybeResolveSkillCommand:skipped-empty-or-slash", {
        ...(tracePayload ?? {}),
        hasText: Boolean(text),
        startsWithSlash: text.startsWith("/"),
      });
      return draft;
    }

    const vesloClient = vesloServerClient();
    const targetWorkspaceId = targetWorkspace?.workspaceId?.trim() || "";
    const workspaceId = targetWorkspaceId || resolvedDevtoolsWorkspaceId();
    if (
      vesloServerStatus() !== "connected" ||
      !vesloClient ||
      !workspaceId ||
      typeof (vesloClient as unknown as { resolveSkill?: unknown }).resolveSkill !== "function"
    ) {
      recordSendTrace("maybeResolveSkillCommand:skipped-veslo-server-unavailable", {
        ...(tracePayload ?? {}),
        vesloServerStatus: vesloServerStatus(),
        hasClient: Boolean(vesloClient),
        hasWorkspaceId: Boolean(workspaceId),
        targetWorkspaceId: targetWorkspaceId || null,
      });
      return draft;
    }

    try {
      const targetWorkspaceType = targetWorkspaceId
        ? (
            workspaceStore.workspaces().find((workspace) => workspace.id === targetWorkspaceId)?.workspaceType ??
            (workspaceStore.activeWorkspaceId().trim() === targetWorkspaceId
              ? workspaceStore.activeWorkspaceDisplay().workspaceType
              : undefined)
          )
        : workspaceStore.activeWorkspaceDisplay().workspaceType;
      const includeGlobal = targetWorkspaceType === "local";
      const resolution = await sendTraceStep(
        "maybeResolveSkillCommand:resolve-skill",
        () => (vesloClient as unknown as {
          resolveSkill: (
            workspaceId: string,
            payload: { text: string; includeGlobal?: boolean },
          ) => Promise<{ match?: { name?: string | null } | null }>;
        }).resolveSkill(workspaceId, {
          text,
          includeGlobal,
        }),
        {
          ...(tracePayload ?? {}),
          workspaceId,
          targetWorkspaceId: targetWorkspaceId || null,
          workspaceType: targetWorkspaceType ?? null,
          includeGlobal,
          textLength: text.length,
        },
      );

      const matchedName = resolution?.match?.name?.trim();
      if (!matchedName) {
        recordSendTrace("maybeResolveSkillCommand:no-match", tracePayload);
        return draft;
      }

      const commandDirectory =
        targetWorkspace?.directory?.trim() ||
        targetWorkspace?.workspaceRoot?.trim() ||
        "";
      const commands = await sendTraceStep(
        "maybeResolveSkillCommand:list-commands",
        () =>
          listCommands(
            targetWorkspaceId
              ? {
                  workspaceId: targetWorkspaceId,
                  directory: commandDirectory,
                }
              : undefined,
          ),
        {
          ...(tracePayload ?? {}),
          matchedName,
          targetWorkspaceId: targetWorkspaceId || null,
          commandDirectory: commandDirectory || null,
        },
      );
      const matchedCommand = commands.find(
        (entry) => entry.name === matchedName && entry.source === "skill",
      );
      if (!matchedCommand) {
        recordSendTrace("maybeResolveSkillCommand:matched-skill-command-missing", {
          ...(tracePayload ?? {}),
          matchedName,
          commandCount: commands.length,
        });
        return draft;
      }

      recordSendTrace("maybeResolveSkillCommand:matched", {
        ...(tracePayload ?? {}),
        matchedName,
      });
      return {
        ...draft,
        command: {
          name: matchedName,
          arguments: text,
        },
      };
    } catch (error) {
      recordSendTrace("maybeResolveSkillCommand:error", {
        ...(tracePayload ?? {}),
        message: messageFromUnknownError(error),
      });
      return draft;
    }
  }

  async function sendPrompt(
    draft: ComposerDraft,
    options: AppSendPromptOptions,
  ): Promise<boolean> {
    const sendCorrelation = normalizeSessionSendCorrelation(options);
    if (!sendCorrelation.clientMessageId) {
      recordSendTrace("sendPrompt:blocked-missing-client-message-id", {
        origin: sendCorrelation.origin,
      });
      return false;
    }
    const sendPreflight = createSendPreflightContext(options.sendTraceId);
    const sendTraceId = sendPreflight.traceId;
    const pendingSidebarSession = options.pendingSession ?? null;
    const sendStartUiScopeToken = activeUiScopeToken();
    const selectedSessionCandidate = selectedSessionId();
    const selectedSessionScopeForSend = selectedSessionCandidate
      ? resolveSelectedSessionBrowseScope(selectedSessionCandidate)
      : null;
    const selectedSessionScopeWorkspaceId = selectedSessionScopeForSend?.workspaceId?.trim() ?? "";
    const activeWorkspaceIdForSend = workspaceStore.activeWorkspaceId().trim();
    const selectedSessionBelongsToActiveWorkspace =
      !selectedSessionScopeWorkspaceId ||
      !activeWorkspaceIdForSend ||
      selectedSessionScopeWorkspaceId === activeWorkspaceIdForSend;
    const selectedRealSessionId =
      isPendingSessionInstanceId(selectedSessionCandidate) || !selectedSessionBelongsToActiveWorkspace
        ? null
        : selectedSessionCandidate;
    const explicitTargetSessionId = isPendingSessionInstanceId(options.targetSessionId)
      ? ""
      : options.targetSessionId?.trim() ?? "";
    let sessionID = explicitTargetSessionId || selectedRealSessionId;
    const pendingSidebarTargetWorkspace = pendingSidebarSession?.workspaceId?.trim()
      ? {
          workspaceId: pendingSidebarSession.workspaceId.trim(),
          workspaceRoot: pendingSidebarSession.workspaceRoot.trim(),
          directory: pendingSidebarSession.workspaceRoot.trim(),
        }
      : null;
    recordSendTrace("sendPrompt:start", {
      traceId: sendTraceId,
      uiSendTraceId: options.sendTraceId ?? null,
      clientMessageId: sendCorrelation.clientMessageId,
      origin: sendCorrelation.origin,
      engineReady: engineReady(),
      selectedSessionId: selectedSessionCandidate,
      selectedSessionScopeWorkspaceId: selectedSessionScopeWorkspaceId || null,
      activeWorkspaceId: activeWorkspaceIdForSend || null,
      selectedSessionIgnoredForForeignWorkspace: Boolean(
        selectedSessionCandidate && !selectedSessionBelongsToActiveWorkspace && !explicitTargetSessionId,
      ),
      uiScopeKey: sendStartUiScopeToken.key,
      uiScopeWorkspaceId: sendStartUiScopeToken.workspaceId || null,
      uiScopeGeneration: sendStartUiScopeToken.generation,
      targetSessionId: options.targetSessionId ?? null,
      hasClient: Boolean(routedClient()),
      busy: busy(),
      busyLabel: busyLabel(),
    });
    let sendTargetWorkspace = pendingSidebarTargetWorkspace ?? resolveSendTargetWorkspaceScope(sessionID);
    sendPreflight.targetWorkspace = sendTargetWorkspace;
    sendPreflight.effectiveSandbox = resolveRuntimeSandboxStateForTarget(sendTargetWorkspace);
    recordSendTrace("sendPrompt:target-workspace-snapshot", {
      traceId: sendTraceId,
      sessionID: sessionID ?? null,
      workspaceId: sendTargetWorkspace?.workspaceId ?? null,
      workspaceRoot: sendTargetWorkspace?.workspaceRoot ?? null,
      directory: sendTargetWorkspace?.directory ?? null,
      clientMessageId: sendCorrelation.clientMessageId,
      origin: sendCorrelation.origin,
    });
    const sendPromptBusyOwnership = resolveSendPromptBusyOwnership({ sessionId: sessionID });
    const blockAppDuringPromptSend = sendPromptBusyOwnership.ownsBusy;
    let ownsSendPromptBusy = false;
    let releaseSendPromptInFlight: (() => void) | null = null;
    const releasePromptSendInFlight = () => {
      releaseSendPromptInFlight?.();
      releaseSendPromptInFlight = null;
    };
    const startSendPromptBusy = (label: string) => {
      if (!blockAppDuringPromptSend) return;
      ownsSendPromptBusy = true;
      setBusy(true);
      setBusyLabel(label);
      setBusyStartedAt(Date.now());
    };
    const stopSendPromptBusy = () => {
      releasePromptSendInFlight();
      if (!ownsSendPromptBusy) return;
      ownsSendPromptBusy = false;
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    };
    let pendingSidebarRowRegistered = false;
    const cleanupPendingSidebarSession = () => {
      if (!pendingSidebarRowRegistered || !pendingSidebarSession) return;
      pendingSidebarRowRegistered = false;
      removeSessionFromWorkspaceSidebar(pendingSidebarSession.workspaceId, pendingSidebarSession.id);
      if (selectedSessionId() === pendingSidebarSession.id) {
        setSelectedSessionId(null);
      }
    };
    const hasExplicitDraft = Boolean(draft);
    const fallbackDraft = composerDraft();
    const fallbackText = fallbackDraft.text.trim();
    const fallbackResolvedText = (fallbackDraft.resolvedText ?? fallbackDraft.text).trim();
    let resolvedDraft: ComposerDraft = draft ?? {
      mode: fallbackDraft.mode,
      parts: fallbackDraft.parts.length ? fallbackDraft.parts : (fallbackText ? [{ type: "text", text: fallbackText } as ComposerPart] : []),
      attachments: fallbackDraft.attachments,
      text: fallbackText,
      resolvedText: fallbackResolvedText || undefined,
      command: fallbackDraft.command,
    };

    const preflightContent = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!preflightContent && !resolvedDraft.attachments.length) {
      recordSendTrace("sendPrompt:blocked-empty", {
        traceId: sendTraceId,
        phase: "initial-preflight",
      });
      return false;
    }

    const scopedSessionID = sessionID?.trim() || "";
    if (
      scopedSessionID &&
      !(await sendTraceStep(
        "sendPrompt:ensure-scoped-workspace-active",
        () => ensureSelectedSessionWorkspaceActiveForSend(scopedSessionID, sendTraceId),
        {
          traceId: sendTraceId,
          sessionID: scopedSessionID,
        },
      ))
    ) {
      recordSendTrace("sendPrompt:blocked-scoped-workspace", {
        traceId: sendTraceId,
        sessionID: scopedSessionID,
      });
      stopSendPromptBusy();
      return false;
    }
    if (scopedSessionID) {
      sendTargetWorkspace = resolveSendTargetWorkspaceScope(scopedSessionID) ?? sendTargetWorkspace;
      sendPreflight.targetWorkspace = sendTargetWorkspace;
      sendPreflight.effectiveSandbox = resolveRuntimeSandboxStateForTarget(sendTargetWorkspace);
    }

    resolvedDraft = await sendTraceStep(
      "sendPrompt:maybe-resolve-skill-command",
      () => maybeResolveSkillCommand(resolvedDraft, sendTraceId, sendTargetWorkspace),
      {
        traceId: sendTraceId,
        mode: resolvedDraft.mode,
        targetWorkspaceId: sendTargetWorkspace?.workspaceId ?? null,
      },
    );

    const initialSessionTitle = resolvedDraft.text.trim();
    const initialContent = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!initialContent && !resolvedDraft.attachments.length) {
      recordSendTrace("sendPrompt:blocked-empty", {
        traceId: sendTraceId,
        phase: "after-skill-resolution",
      });
      return false;
    }
    if (!sessionID && pendingSidebarSession) {
      registerPendingSidebarSession(pendingSidebarSession);
      pendingSidebarRowRegistered = true;
    }

    const sendRuntimeWorkspaceId = sendTargetWorkspace?.workspaceId ?? workspaceStore.activeWorkspaceId().trim();
    const sendRuntimeReady = isWorkspaceRuntimeReady(sendRuntimeWorkspaceId);
    if (sendRuntimeReady) {
      sendPreflight.enginePrepared = true;
      sendPreflight.effectiveSandbox = resolveRuntimeSandboxStateForTarget(sendTargetWorkspace);
    }

    // In browsing mode, target workspace runtime is not connected. Start it before sending.
    if (!sendRuntimeReady) {
      // VSLO-171 F3Ú8: cross-workspace takeover dialog removed.
      // Multi mode (F3Ú6) keeps per-WS clients alive in parallel; single-active
      // fallback may interrupt another worker silently but that's the legacy
      // behavior the multi flag is meant to replace.

      startSendPromptBusy("status.connecting");
      // Yield to the browser's macro task queue so it paints the spinner
      // before the engine start blocks the microtask chain.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (!(await prepareSendRuntimeForSend("sendPrompt", sendPreflight))) {
      cleanupPendingSidebarSession();
      stopSendPromptBusy();
      return false;
    }
    sendPreflight.enginePrepared = true;
    sendPreflight.effectiveSandbox = resolveRuntimeSandboxStateForTarget(sendTargetWorkspace);
    sendPreflight.managedAiReady = true;

    const c = routedClientForSendTarget(sendTargetWorkspace);
    if (!c) {
      recordSendTrace("sendPrompt:blocked-no-client", {
        traceId: sendTraceId,
      });
      cleanupPendingSidebarSession();
      stopSendPromptBusy();
      return false;
    }

    const compactShortcut = /^\/compact(?:\s+.*)?$/i.test(initialContent);
    const compactCommand = resolvedDraft.command?.name === "compact" || compactShortcut;
    const commandName = compactCommand ? "compact" : (resolvedDraft.command?.name ?? null);
    if (compactCommand && !sessionID) {
      recordSendTrace("sendPrompt:blocked-compact-no-session", {
        traceId: sendTraceId,
      });
      setError("Select a session with messages before running /compact.");
      cleanupPendingSidebarSession();
      return false;
    }

    const pendingDraftSendState = (() => {
      const pendingDraftKey = (activePendingDraftKey() ?? "").trim();
      if (sessionID) return null;
      if (!pendingDraftKey) return null;
      const pendingDraftMeta = activePendingDraftMeta();
      return {
        key: pendingDraftKey,
        meta: pendingDraftMeta,
        draftId: pendingDraftMeta?.id?.trim() || GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
      };
    })();
    if (!sessionID) {
      recordSendTrace("sendPrompt:create-session-needed", {
        traceId: sendTraceId,
      });
      const createdSessionId = await sendTraceStep(
        "sendPrompt:create-session-and-open",
        () => createSessionAndOpen(initialSessionTitle, {
          blockAppDuringCreate: blockAppDuringPromptSend,
          managedAiRuntimeAlreadyPrepared: true,
          pendingSession: pendingSidebarSession,
          sendTraceId,
          clientMessageId: sendCorrelation.clientMessageId,
          onMaterializedSessionId: options.onMaterializedSessionId,
          preflight: sendPreflight,
        }),
        {
          traceId: sendTraceId,
          blockAppDuringCreate: blockAppDuringPromptSend,
          targetWorkspaceId: sendTargetWorkspace?.workspaceId ?? null,
          targetWorkspaceRoot: sendTargetWorkspace?.workspaceRoot ?? null,
        },
      );
      const materializedSessionId = createdSessionId?.trim();
      if (materializedSessionId) {
        sessionID = materializedSessionId;
        pendingSidebarRowRegistered = false;
      } else {
        cleanupPendingSidebarSession();
        const selectedAfterCreate = selectedSessionId();
        sessionID = isPendingSessionInstanceId(selectedAfterCreate) ? null : selectedAfterCreate;
      }
    }
    if (!sessionID) {
      recordSendTrace("sendPrompt:blocked-no-session", {
        traceId: sendTraceId,
      });
      cleanupPendingSidebarSession();
      stopSendPromptBusy();
      return false;
    }

    const displayedConversationGuard = captureDisplayedConversationGuard(sessionID);
    const displayedUiScopeToken = activeUiScopeToken();
    const sendTargetStillDisplayed = () =>
      displayedConversationStillMatches(displayedConversationGuard) && isUiScopeTokenCurrent(displayedUiScopeToken);
    const reportSendErrorToDisplayedTarget = (message: string) => {
      if (!sendTargetStillDisplayed()) {
        recordSendTrace("sendPrompt:error-skipped-stale-display", {
          traceId: sendTraceId,
          sessionID,
          message,
        });
        return;
      }
      setError(addOpencodeCacheHint(message));
      sessionStore.appendSessionErrorTurn(sessionID, addOpencodeCacheHint(message));
    };
    const model = modelForSession(sessionID);
    let promptSystem: string | undefined;
    const restorePendingDraftAfterSendFailure = () => {
      if (!sendTargetStillDisplayed()) return;
      if (pendingDraftSendState) {
        setActivePendingDraftKey(pendingDraftSendState.key);
        setActivePendingDraftMeta(pendingDraftSendState.meta);
        setView("session");
      }
    };

    try {
      const stagedAttachments = await sendTraceStep(
        "sendPrompt:stage-attachments",
        () => stageAttachmentsIntoSessionDirectory(resolvedDraft, sessionID, sendPreflight),
        {
          traceId: sendTraceId,
          sessionID,
          attachmentCount: resolvedDraft.attachments.length,
        },
      );
      const routedDraft = routeStagedAttachmentsForModel({
        draft: resolvedDraft,
        stagedAttachments,
        model,
        providers: providers(),
      });
      if (routedDraft.error) {
        recordSendTrace("sendPrompt:staged-attachment-routing-error", {
          traceId: sendTraceId,
          sessionID,
          message: routedDraft.error,
        });
        restorePendingDraftAfterSendFailure();
        if (sendTargetStillDisplayed()) {
          setError(routedDraft.error);
        }
        stopSendPromptBusy();
        return false;
      }
      resolvedDraft = routedDraft.draft;
      promptSystem = routedDraft.system;
    } catch (error) {
      recordSendTrace("sendPrompt:stage-attachments-error", {
        traceId: sendTraceId,
        sessionID,
        message: messageFromUnknownError(error),
      });
      restorePendingDraftAfterSendFailure();
      if (sendTargetStillDisplayed()) {
        setError(error instanceof Error ? error.message : safeStringify(error));
      }
      stopSendPromptBusy();
      return false;
    }

    const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!content && !resolvedDraft.attachments.length && !promptSystem) {
      recordSendTrace("sendPrompt:blocked-empty-after-staging", {
        traceId: sendTraceId,
        sessionID,
      });
      stopSendPromptBusy();
      return false;
    }

    startSendPromptBusy("status.running");
    setError(null);

    const perfEnabled = developerMode();
    const startedAt = perfNow();
    const visible = messages();
    const visibleParts = visible.reduce((total, message) => total + message.parts.length, 0);
    let commandMessageIDToClear: string | null = null;
    recordPerfLog(perfEnabled, "session.prompt", "start", {
      sessionID,
      mode: resolvedDraft.mode,
      command: commandName,
      charCount: content.length,
      attachmentCount: resolvedDraft.attachments.length,
      messageCount: visible.length,
      partCount: visibleParts,
    });

    try {
      if (!compactCommand) {
        setLastPromptSent(content);
      }
      if (!hasExplicitDraft) {
        setPrompt("");
      }

      const agent = agentForSession(sessionID);
      const parts = buildPromptParts(resolvedDraft);
      const selectedVariant = modelVariant() ?? undefined;
      const reasoningEffort = resolveCodexReasoningEffort(model.modelID, selectedVariant ?? null);
      const requestVariant = reasoningEffort ? undefined : selectedVariant;
      const promptOverrides = {
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(promptSystem ? { system: promptSystem } : {}),
      };

      // Resolve the session directory override so moved sessions operate in the
      // correct folder, not the original private-workspace path.
      const sessionDirOverride = sessionDirectoryOverrideById()[sessionID] ?? undefined;
      const runConversationOrFail = async (input: VesloConversationRunInput) => {
        const scope = resolveSelectedSessionBrowseScope(sessionID);
        const inputWithCorrelation: VesloConversationRunInput = {
          ...input,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
        };
        try {
          const result = await runConversationFromVesloWriteApi(sessionID, inputWithCorrelation, {
            preflight: sendPreflight,
            targetWorkspace: sendTargetWorkspace,
          });
          if (result) return;
          recordSendTrace("sendPrompt:conversation-run-unavailable", {
            traceId: sendTraceId,
            sessionID,
            kind: input.kind,
            clientMessageId: sendCorrelation.clientMessageId,
            origin: sendCorrelation.origin,
            hasConversationScope: Boolean(scope?.conversationId),
          });
          throw new Error("Conversation service is unavailable for this session.");
        } catch (error) {
          recordSendTrace("sendPrompt:conversation-run-error", {
            traceId: sendTraceId,
            sessionID,
            kind: input.kind,
            clientMessageId: sendCorrelation.clientMessageId,
            origin: sendCorrelation.origin,
            hasConversationScope: Boolean(scope?.conversationId),
            message: messageFromUnknownError(error),
          });
          throw error;
        }
      };

      if (resolvedDraft.mode === "shell") {
        await runConversationOrFail({
          kind: "shell",
          directory: sessionDirOverride,
          command: content,
          model,
          agent: agent ?? undefined,
        });
      } else if (resolvedDraft.command || compactCommand) {
        if (compactCommand) {
          await compactCurrentSession(sessionID);
          finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
            sessionID,
            mode: resolvedDraft.mode,
            command: commandName,
          });
          recordSendTrace("sendPrompt:compact-success", {
            traceId: sendTraceId,
            sessionID,
          });
          return true;
        }

        const command = resolvedDraft.command;
        if (!command) {
          throw new Error("Command was not resolved.");
        }

        // Slash command: route through session.command() API
        commandMessageIDToClear = sendCorrelation.clientMessageId;
        const commandMessageID = commandMessageIDToClear;
        sessionStore.setCommandDisplay(commandMessageID, command.name, command.arguments);
        const modelString = `${model.providerID}/${model.modelID}`;
        const files = buildCommandFileParts(resolvedDraft);

        await runConversationOrFail({
          kind: "command",
          sessionID,
          messageID: commandMessageID,
          command: command.name,
          arguments: command.arguments,
          agent: agent ?? undefined,
          model: modelString,
          variant: requestVariant,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          parts: files.length ? files : undefined,
          directory: sessionDirOverride,
        });
        commandMessageIDToClear = null;

      } else {
        await runConversationOrFail({
          kind: "prompt_async",
          directory: sessionDirOverride,
          model,
          agent: agent ?? undefined,
          variant: requestVariant,
          ...promptOverrides,
          parts,
        });
      }
      if (pendingDraftSendState) {
        const pendingDraftStorageKey = pendingDraftSendState.key;
        const pendingDraftId = pendingDraftSendState.draftId;
        const clearDisplayedPendingDraftState = sendTargetStillDisplayed();
        if (pendingDraftId && isTauriRuntime()) {
          try {
            const deleted = await pendingSessionDraftsDelete(pendingDraftId);
            if (!deleted) {
              markPendingDraftConsumed(pendingDraftId);
              console.warn("[pendingDrafts.consume] failed to delete pending draft", { pendingDraftId });
            } else {
              clearConsumedPendingDraftId(pendingDraftId);
            }
          } catch (error) {
            markPendingDraftConsumed(pendingDraftId);
            reportError(error, "pendingDrafts.consume");
          }
        }
        if (clearDisplayedPendingDraftState) {
          clearActivePendingDraftState();
        }
        setComposerDraftBySessionId((current) => deleteSessionComposerDraft(current, { storageKey: pendingDraftStorageKey }));
        void composerTargetController.refreshPendingDraftSummaries();
      }

      finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
      });
      recordSendTrace("sendPrompt:success", {
        traceId: sendTraceId,
        sessionID,
        clientMessageId: sendCorrelation.clientMessageId,
        origin: sendCorrelation.origin,
        mode: resolvedDraft.mode,
        command: commandName,
      });
      holdVisibleRuntimeActivity(sessionID, "sendPrompt:success");
      return true;
    } catch (e) {
      restorePendingDraftAfterSendFailure();
      if (commandMessageIDToClear) {
        sessionStore.clearCommandDisplay(commandMessageIDToClear);
      }
      // VSLO-86 Task #20 — if the workspace switched while this send was
      // mid-flight, the routed client's guard proxies throw
      // WorkspaceClientStaleError before forwarding the SDK call. Treat it
      // as a silent abort: don't poison the (now-irrelevant) session with
      // an error turn, just unwind cleanly.
      if (isWorkspaceClientStaleError(e)) {
        recordSendTrace("sendPrompt:stale-client", {
          traceId: sendTraceId,
          sessionID,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
          entryWorkspaceId: e.entryWorkspaceId,
          currentWorkspaceId: e.currentWorkspaceId,
        });
        return false;
      }
      finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
      const message = e instanceof Error ? e.message : safeStringify(e);
      recordSendTrace("sendPrompt:error", {
        traceId: sendTraceId,
        sessionID,
        clientMessageId: sendCorrelation.clientMessageId,
        origin: sendCorrelation.origin,
        message,
      });
      reportSendErrorToDisplayedTarget(message);
      return false;
    } finally {
      releasePromptSendInFlight();
      stopSendPromptBusy();
    }
  }

  async function abortSession(sessionID?: string, target?: ConversationAbortTarget) {
    const id = (sessionID ?? selectedSessionId() ?? "").trim();
    if (!id) return;
    const scope = resolveConversationAbortScope(id, target);
    recordSendTrace("abortSession:start", {
      sessionID: id,
      workspaceId: scope.workspaceId || null,
      conversationId: scope.conversationId || null,
      opencodeSessionId: scope.opencodeSessionId || null,
      hasConversationScope: scope.hasConversationScope,
    });
    const abortSessionViaScopedLegacy = async (): Promise<boolean> => {
      if (!scope.workspaceId) return false;
      const opencodeSessionId = scope.opencodeSessionId?.trim() || id;
      const conversationId = scope.hasConversationScope ? scope.conversationId?.trim() : "";
      if (!opencodeSessionId || (conversationId && opencodeSessionId === conversationId)) return false;
      const scopedEntry = workspaceRouting.entry(scope.workspaceId);
      const scopedClient =
        scopedEntry?.client ??
        (scope.workspaceId === workspaceStore.activeWorkspaceId().trim() ? routedClient() : null);
      if (!scopedClient) return false;
      await abortSessionTyped(scopedClient, opencodeSessionId, {
        directory: scope.directory?.trim() || undefined,
      });
      return true;
    };
    try {
      const result = await abortConversationFromVesloWriteApi(id, target);
      if (result) {
        recordSendTrace("abortSession:conversation-abort-success", {
          sessionID: id,
          workspaceId: result.workspaceId,
          conversationId: result.conversationId,
          opencodeSessionId: result.opencodeSessionId,
          runId: result.runId,
        });
        return;
      }
      recordSendTrace("abortSession:conversation-abort-unavailable", {
        sessionID: id,
        hasConversationScope: scope.hasConversationScope,
      });
      if (target?.workspaceId?.trim() && await abortSessionViaScopedLegacy()) {
        recordSendTrace("abortSession:scoped-legacy-fallback", { sessionID: id });
        return;
      }
      if (scope.hasConversationScope) {
        throw new Error("Conversation service is unavailable for this scoped conversation.");
      }
    } catch (error) {
      recordSendTrace("abortSession:conversation-abort-error", {
        sessionID: id,
        hasConversationScope: scope.hasConversationScope,
        message: messageFromUnknownError(error),
      });
      if (scope.hasConversationScope) {
        // Abort is a safe/idempotent stop operation. If the local app lost the
        // submitted runId after reload, still stop the scoped OpenCode session
        // through the exact workspace client instead of failing closed.
        if (await abortSessionViaScopedLegacy()) {
          recordSendTrace("abortSession:scoped-legacy-fallback", { sessionID: id });
          return;
        }
        throw error;
      }
      if (target?.workspaceId?.trim() && await abortSessionViaScopedLegacy()) {
        recordSendTrace("abortSession:scoped-legacy-fallback", { sessionID: id });
        return;
      }
      console.warn("[conversation-abort] falling back to OpenCode SDK", error);
    }

    const c = routedClient();
    if (!c) return;
    // OpenCode exposes session.abort which interrupts the active prompt/run.
    // We intentionally don't mutate global busy state here; the SessionView
    // provides local UX (button disabled + toast) for cancellation.
    recordSendTrace("abortSession:legacy-fallback", { sessionID: id });
    await abortSessionTyped(c, id);
  }

  const sessionMutationWorkflow = createSessionMutationWorkflow({
    lastPromptSent,
    sendPrompt,
    createClientMessageId: createSessionClientMessageId,
    selectedSessionId,
    selectedSession,
    messages,
    setPrompt,
    ensureSelectedSessionWorkspaceActiveForSend: (sessionId, sendTraceId) =>
      ensureSelectedSessionWorkspaceActiveForSend(sessionId, sendTraceId),
    routedClient: (workspaceId) => routedClient(workspaceId ?? undefined),
    abortSessionSafe,
    revertSession,
    unrevertSession,
    upsertLocalSession: (session) => upsertLocalSession(session),
    normalizeSendCorrelation: normalizeSessionSendCorrelation,
    createSendPreflightContext,
    recordSendTrace,
    sendTraceStep,
    resolveSendTargetWorkspaceScope: (sessionId) => resolveSendTargetWorkspaceScope(sessionId),
    prepareSendRuntimeForSend: (event, preflight) => prepareSendRuntimeForSend(event, preflight as SendRuntimePreflightContext),
    resolveRuntimeSandboxStateForTarget: (target) => resolveRuntimeSandboxStateForTarget(target as SendRuntimePreflightTargetWorkspace | null),
    routedClientForSendTarget: (target) => routedClientForSendTarget(target as SendTargetWorkspaceScope | null),
    engineReady,
    client,
    reportError,
    selectedSessionModel: () => selectedSessionModel(),
    developerMode,
    modelVariant: () => modelVariant(),
    finishPerf,
    recordPerfLog,
    perfNow,
    sessionDirectoryOverrideById,
    workspaceProjectDir: () => workspaceProjectDir(),
    resolveSelectedSessionBrowseScope,
    runConversationFromVesloWriteApi,
    messageFromUnknownError: (error) => messageFromUnknownError(error),
    safeStringify,
    renameSession,
    refreshSidebarWorkspaceSessions: (workspaceId) => refreshSidebarWorkspaceSessions(workspaceId),
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    workspaces: () => workspaceStore.workspaces() as WorkspaceDisplay[],
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    sessionDirectoryOverride: sessionDirectoryOverrideById,
    persistSessionDirectoryOverride,
    sessions,
    setSessions,
    deleteSessionComposerDraft,
    setComposerDraftBySessionId,
    removeSessionFromWorkspaceSidebar: (workspaceId, sessionId) => removeSessionFromWorkspaceSidebar(workspaceId, sessionId),
    pathname: () => location.pathname,
    navigate: (to, options) => navigate(to, options),
    setSelectedSessionId,
    clearWorkspaceLastSessionIfSelected,
    sessionStatusById,
    setSessionStatusById,
    withoutSessionStatus,
    unwrap,
    listCommands: listCommandsTyped,
    compactCommandDescription: () => t("commands.compact_description", currentLocale()),
    workspaceRootForId: (workspaceId, fallbackDirectory) => workspaceRootForId(workspaceId, fallbackDirectory),
    normalizeTodoItems,
  });

  const retryLastPrompt = sessionMutationWorkflow.retryLastPrompt;
  const compactCurrentSession = sessionMutationWorkflow.compactCurrentSession;
  const replaceUserMessage = sessionMutationWorkflow.replaceUserMessage;
  const undoLastUserMessage = sessionMutationWorkflow.undoLastUserMessage;
  const redoLastUserMessage = sessionMutationWorkflow.redoLastUserMessage;
  const renameSessionTitle = sessionMutationWorkflow.renameSessionTitle;
  const deleteSessionById = sessionMutationWorkflow.deleteSessionById;
  const listAgents = sessionMutationWorkflow.listAgents;
  const listCommands = sessionMutationWorkflow.listCommands;
  const saveSessionExport = sessionMutationWorkflow.saveSessionExport;

  const triggerAutoCompaction = async (sessionID: string) => {
    if (!autoCompactContext()) return;
    if (autoCompactingSessionId() === sessionID) return;

    setAutoCompactingSessionId(sessionID);
    try {
      await compactCurrentSession(sessionID);
    } catch {
      // ignore auto-compaction failures; manual compact remains available
    } finally {
      setAutoCompactingSessionId((current) => (current === sessionID ? null : current));
    }
  };

  const [lastSessionStatus, setLastSessionStatus] = createSignal<string | null>(null);
  createEffect(() => {
    const sessionID = selectedSessionId();
    const status = sessionID ? statusForSession(sessionID) : null;
    const previous = lastSessionStatus();
    setLastSessionStatus(status);

    if (!sessionID) return;
    if (!autoCompactContext()) return;
    if (status !== "idle") return;
    if (!previous || previous === "idle") return;

    // Only compact when context usage reaches 90% of the model's limit
    const needed = untrack(() =>
      shouldAutoCompact(messages(), selectedSessionModel(), providers()),
    );
    if (!needed) return;

    void triggerAutoCompaction(sessionID);
  });

  const messageIdFromInfo = (message: MessageWithParts) => {
    const id = (message.info as { id?: string | number }).id;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
    return "";
  };

  const createSyntheticSessionErrorMessage = (
    sessionID: string,
    errorTurn: SessionErrorTurn,
  ): MessageWithParts => {
    const info: PlaceholderAssistantMessage = {
      id: errorTurn.id,
      sessionID,
      role: "assistant",
      time: { created: errorTurn.time, completed: errorTurn.time },
      parentID: errorTurn.afterMessageID ?? "",
      modelID: "",
      providerID: "",
      mode: "",
      agent: "",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };

    return {
      info,
      parts: [
        {
          id: `${errorTurn.id}:text`,
          sessionID,
          messageID: errorTurn.id,
          type: "text",
          text: errorTurn.text,
        } as Part,
      ],
    };
  };

  const insertSyntheticSessionErrors = (
    list: MessageWithParts[],
    sessionID: string | null,
    errorTurns: SessionErrorTurn[],
  ) => {
    if (!sessionID || errorTurns.length === 0) return list;

    const next = list.slice();
    errorTurns.forEach((errorTurn) => {
      if (next.some((message) => messageIdFromInfo(message) === errorTurn.id)) return;
      const syntheticMessage = createSyntheticSessionErrorMessage(sessionID, errorTurn);
      const anchorIndex = errorTurn.afterMessageID
        ? next.findIndex((message) => messageIdFromInfo(message) === errorTurn.afterMessageID)
        : -1;

      if (anchorIndex === -1) {
        next.push(syntheticMessage);
        return;
      }

      next.splice(anchorIndex + 1, 0, syntheticMessage);
    });

    return next;
  };

  const upsertLocalSession = (next: Session | null | undefined) => {
    const id = (next as { id?: string } | null)?.id ?? "";
    if (!id) return;

    const current = sessions();
    const index = current.findIndex((session) => session.id === id);
    if (index === -1) {
      setSessions([...current, next as Session]);
      return;
    }
    const copy = current.slice();
    copy[index] = next as Session;
    setSessions(copy);
  };

  // OpenCode keeps reverted messages in the log and uses `session.revert.messageID`
  // as the visibility boundary. Veslo mirrors that behavior by filtering the
  // displayed transcript.
  const visibleMessages = createMemo(() => {
    const sessionID = selectedSessionId();
    const errorTurns = sessionStore.selectedSessionErrorTurns();
    const list = messages().filter((message) => {
      const id = messageIdFromInfo(message);
      return !id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);
    });
    const revert = selectedSession()?.revert?.messageID ?? null;
    const visible = !revert ? list : list.filter((message) => {
      const id = messageIdFromInfo(message);
      return Boolean(id) && id < revert;
    });
    return insertSyntheticSessionErrors(visible, sessionID, errorTurns);
  });

  const [pendingSessionSwitchPerf, setPendingSessionSwitchPerf] = createSignal<{
    sessionID: string;
    startedAt: number;
    source: "warm-hit" | "cold-miss";
  } | null>(null);
  let lastSessionSwitchPerfKey = "";

  createEffect(() => {
    const view = currentView();
    const sessionID = selectedSessionId()?.trim() ?? "";

    if (view !== "session" || !sessionID) {
      if (!sessionID) {
        setPendingSessionSwitchPerf(null);
        lastSessionSwitchPerfKey = "";
      }
      return;
    }

    const nextKey = `${view}:${sessionID}`;
    if (nextKey === lastSessionSwitchPerfKey) return;
    lastSessionSwitchPerfKey = nextKey;

    setPendingSessionSwitchPerf({
      sessionID,
      startedAt: perfNow(),
      source: hasWarmTranscript(sessionID) ? "warm-hit" : "cold-miss",
    });
  });

  createEffect(() => {
    const pending = pendingSessionSwitchPerf();
    if (!pending) return;
    if (currentView() !== "session") return;
    if (selectedSessionId() !== pending.sessionID) return;

    const messageCount = visibleMessages().length;
    if (messageCount === 0) return;

    recordPerfLog(developerMode(), "session.switch", "transcript-first-paint", {
      sessionID: pending.sessionID,
      source: pending.source,
      elapsedMs: Math.round((perfNow() - pending.startedAt) * 100) / 100,
      messageCount,
    });

    setPendingSessionSwitchPerf((current) =>
      current?.sessionID === pending.sessionID ? null : current,
    );
  });

  const localizedSuggestedPlugins = createMemo<SuggestedPlugin[]>(() =>
    SUGGESTED_PLUGINS.map((plugin) => ({
      ...plugin,
      description: plugin.descriptionKey ? t(plugin.descriptionKey, currentLocale()) : plugin.description,
      tags: plugin.tagKeys?.map((key) => t(key, currentLocale())) ?? plugin.tags,
      steps: plugin.steps?.map((step) => ({
        ...step,
        title: step.titleKey ? t(step.titleKey, currentLocale()) : step.title,
        description: step.descriptionKey ? t(step.descriptionKey, currentLocale()) : step.description,
        note: step.noteKey ? t(step.noteKey, currentLocale()) : step.note,
      })),
    })),
  );

  const localizedMcpQuickConnect = createMemo<McpDirectoryInfo[]>(() =>
    MCP_QUICK_CONNECT.map((entry) => ({
      ...entry,
      description: entry.descriptionKey ? t(entry.descriptionKey, currentLocale()) : entry.description,
    })),
  );

  function setSessionAgent(sessionID: string, agent: string | null) {
    const trimmed = agent?.trim() ?? "";
    setSessionAgentById((current) => {
      const next = { ...current };
      if (!trimmed) {
        delete next[sessionID];
        return next;
      }
      next[sessionID] = trimmed;
      return next;
    });
  }

  async function respondPermissionAndRemember(
    requestID: string,
    reply: "once" | "always" | "reject"
  ) {
    // Intentional no-op: permission prompts grant session-scoped access only.
    // Persistent workspace roots must be managed explicitly via workspace settings.
    await respondPermission(requestID, reply);
  }

  const [notionStatus, setNotionStatus] = createSignal<"disconnected" | "connecting" | "connected" | "error">(
    "disconnected",
  );
  const [notionStatusDetail, setNotionStatusDetail] = createSignal<string | null>(null);
  const [notionError, setNotionError] = createSignal<string | null>(null);
  const [notionBusy, setNotionBusy] = createSignal(false);
  const [notionSkillInstalled, setNotionSkillInstalled] = createSignal(false);
  const [tryNotionPromptVisible, setTryNotionPromptVisible] = createSignal(false);
  const notionIsActive = createMemo(() => notionStatus() === "connected");
  const [mcpServers, setMcpServers] = createSignal<McpServerEntry[]>([]);
  const [mcpStatus, setMcpStatus] = createSignal<string | null>(null);
  const [mcpLastUpdatedAt, setMcpLastUpdatedAt] = createSignal<number | null>(null);
  const [mcpStatuses, setMcpStatuses] = createSignal<McpStatusMap>({});
  const [mcpConnectingName, setMcpConnectingName] = createSignal<string | null>(null);
  const [selectedMcp, setSelectedMcp] = createSignal<string | null>(null);
  // MCP OAuth modal state
  const [mcpAuthModalOpen, setMcpAuthModalOpen] = createSignal(false);
  const [mcpAuthEntry, setMcpAuthEntry] = createSignal<McpDirectoryInfo | null>(null);
  const [mcpAuthNeedsReload, setMcpAuthNeedsReload] = createSignal(false);
  let resolveSessionCapabilitySkillInventoryWorkspaces: () => { id: string; label: string; path: string }[] = () => [];

  const extensionsStore = createExtensionsStore({
    client,
    routing: runtimeOwnedRouting,
    projectDir: () => workspaceProjectDir(),
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    workspaceType: () => workspaceStore.activeWorkspaceDisplay().workspaceType,
    workspaces: () => workspaceStore.workspaces(),
    extraSkillInventoryWorkspaces: () => resolveSessionCapabilitySkillInventoryWorkspaces(),
    vesloServerClient,
    vesloServerStatus,
    vesloServerCapabilities,
    vesloServerWorkspaceId,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setError,
    markReloadRequired,
    onNotionSkillInstalled: () => {
      setNotionSkillInstalled(true);
      try {
        window.localStorage.setItem("veslo.notionSkillInstalled", "1");
      } catch {
        // ignore
      }
      if (notionIsActive()) {
        setTryNotionPromptVisible(true);
      }
    },
  });

  const {
    skills,
    skillsStatus,
    skillInventory,
    skillInventoryStatus,
    hubSkills,
    hubSkillsStatus,
    hubMcpCards,
    hubMcpStatus,
    pluginScope,
    setPluginScope,
    pluginConfig,
    pluginConfigPath,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    sidebarPluginList,
    sidebarPluginStatus,
    isPluginInstalledByName,
    refreshSkills,
    refreshSkillInventory,
    refreshHubSkills,
    refreshHubMcp,
    refreshPlugins,
    addPlugin,
    removePlugin,
    importLocalSkill,
    installSkillCreator,
    installHubSkill,
    installHubMcp,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    readSkillInstance,
    saveSkillInstance,
    setSkillInstanceEnabled,
    deleteSkillInstance,
    removeSkillInstance,
    batchRemoveSkillInstances,
    restoreSkillInstance,
    copySkillInstanceToGlobal,
    copySkillInstanceToWorkspace,
    abortRefreshes,
  } = extensionsStore;

  const globalSync = useGlobalSync();
  const providers = createMemo(() => globalSync.data.provider.all ?? []);
  const providerDefaults = createMemo(() => globalSync.data.provider.default ?? {});
  const setProviders = (value: ProviderListItem[]) => {
    globalSync.set("provider", "all", value);
  };
  const setProviderDefaults = (value: Record<string, string>) => {
    globalSync.set("provider", "default", value);
  };
  const setProviderConnectedIds = (value: string[]) => {
    globalSync.set("provider", "connected", value);
  };

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const managedAiAccessStore = createManagedAiAccessStore({
    authenticatedUser,
    denAuthRevision,
    readDenAuth,
    isTauriRuntime,
    gatewayVesloServerClient,
    managedAiGatewayBaseUrl,
    vesloServerAuth,
    activeVesloServerHostInfo,
    activeWorkspaceDisplay: () => workspaceStore.activeWorkspaceDisplay(),
    ensureLocalVesloServerRunning,
    providers,
    formatModelLabel,
    translate: (key) => t(key, currentLocale()),
    reportError,
    describeRequestError,
    requestManagedAiAccessBundle,
    proofCache: {
      read: accessProofAiRead,
      write: accessProofAiWrite,
      clear: accessProofAiClear,
    },
  });
  managedAiAccessStoreRef = managedAiAccessStore;
  if (pendingManagedAiAccessRefreshFromAuth) {
    pendingManagedAiAccessRefreshFromAuth = false;
    managedAiAccessStore.requestManagedAiAccessRefresh();
  }
  const {
    managedAiAccess,
    managedAiGatewayAccessToken,
    managedAiAccessBusy,
    managedAiAccessError,
    managedAiAccessModel,
    denGatewayAccessToken,
    managedAiAccessMessage,
    managedAiAccessProviderLabel,
    managedAiAccessDefaultModelLabel,
    managedAiAccessBlockedReason,
  } = managedAiAccessStore;
  let lastNewSessionDisabledDiagnosticKey = "";
  const [managedAiBootstrapPendingCount, setManagedAiBootstrapPendingCount] = createSignal(0);
  const [sendPromptInFlightCount, setSendPromptInFlightCount] = createSignal(0);
  const sendPromptInFlight = createMemo(() => sendPromptInFlightCount() > 0);
  const managedAiBootstrapBusy = createMemo(
    () => managedAiAccessBusy() || managedAiBootstrapPendingCount() > 0,
  );

  const beginManagedAiBootstrap = () => {
    let released = false;
    setManagedAiBootstrapPendingCount((count) => count + 1);
    return () => {
      if (released) return;
      released = true;
      setManagedAiBootstrapPendingCount((count) => Math.max(0, count - 1));
    };
  };

  const recordManagedAiWorkflowTrace = (event: string, payload: Record<string, unknown>) => {
    recordSendWorkflowTrace("app", event, payload, { developerMode: developerMode() });
  };

  const managedAiRuntimeConfig = createManagedAiRuntimeConfigSync({
    isTauriRuntime,
    workspaceDefaultModelReady,
    defaultModelExplicit,
    defaultModel,
    managedAiAccess,
    managedAiAccessBusy,
    managedAiAccessError,
    managedAiGatewayAccessToken,
    denGatewayAccessToken,
    denAuthRevision,
    gatewayVesloServerClient,
    vesloServerClient,
    vesloServerStatus,
    vesloServerWorkspaceId,
    resolvedVesloCapabilities: () => resolvedVesloCapabilities(),
    activeVesloServerRoutingInfo,
    baseUrl,
    activeWorkspaceDisplay: () => workspaceStore.activeWorkspaceDisplay(),
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    activeWorkspacePath: () => workspaceStore.activeWorkspacePath(),
    workspaces: () => workspaceStore.workspaces(),
    engine: () => workspaceStore.engine(),
    orchestratorStatusEngines: () => orchestratorStatusState()?.engines ?? [],
    orchestratorEngines: () => orchestratorEnginesState(),
    resolveConversationServerWorkspaceId,
    ensureConversationReadWorkspaceRegistered: (vesloClient, workspaceId, workspaceRoot) =>
      ensureConversationReadWorkspaceRegistered(
        vesloClient as unknown as VesloServerClient,
        workspaceId,
        workspaceRoot,
      ),
    readOpencodeConfig,
    writeOpencodeConfig,
    markReloadRequired,
    anyActiveRuns: () => anyActiveRuns(),
    sendPromptInFlight,
    canReloadWorkspace: () => canReloadWorkspace(),
    setError,
    reportError,
    addOpencodeCacheHint,
    safeStringify,
    recordManagedAiWorkflowTrace,
    createVesloServerClient,
    applyManagedAiAccessProfile: managedAiAccessStore.applyManagedAiAccessProfile,
    setManagedAiAccessError: managedAiAccessStore.setManagedAiAccessError,
    beginManagedAiBootstrap,
    shouldRetryManagedAiConfigReadForSend: (error, retryBaseUrl) =>
      isLoopbackVesloServerConnectionUrl(retryBaseUrl) &&
      !(error instanceof VesloServerError) &&
      isLocalVesloTransportError(error) &&
      vesloServerRecentlyReachable(),
    delay: (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
  });
  const {
    resolveRuntimeSandboxStateForTarget,
    hasUsableManagedAiRuntimeConfigForSend,
    ensureManagedAiRuntimeAuthorizationForSend,
  } = managedAiRuntimeConfig;

  const sendRuntimeReadiness = createSendRuntimeReadiness<Client>({
    isTauriRuntime,
    activeWorkspaceDisplay: () => workspaceStore.activeWorkspaceDisplay(),
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    clientDirectory: () => clientDirectory(),
    workspaces: () => workspaceStore.workspaces(),
    routedClient,
    releaseWorkspaceRoute: (workspaceId) => workspaceRouting.release(workspaceId),
    ensureEngineForWorkspace: (workspaceId) => workspaceStore.ensureEngineForWorkspace(workspaceId),
    connectToServer: (nextBaseUrl, directory, context, auth, connectOptions) =>
      workspaceStore.connectToServer(nextBaseUrl, directory, context, auth, connectOptions),
    engineInfo,
    managedAiAccess,
    managedAiAccessBusy,
    managedAiBootstrapBusy,
    managedAiBootstrapPendingCount,
    reloadBusy: () => reloadBusy(),
    hasUsableManagedAiRuntimeConfigForSend,
    ensureManagedAiRuntimeAuthorizationForSend,
    waitForManagedAiBootstrapReady,
    sendTraceStep,
    recordSendTrace,
    setError,
    setEngineReady,
    setSseConnected,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    safeStringify,
  });
  const {
    ensureManagedAiBootstrapReady,
    ensureLocalRuntimeReachableForSend,
    prepareSendRuntimeForSend,
    connectLocalRuntimeClientFromEngineInfo,
    messageFromUnknownError,
  } = sendRuntimeReadiness;

  const [showThinking, setShowThinking] = createSignal(false);
  const [hideTitlebar, setHideTitlebar] = createSignal(false);
  // VSLO-171 F3Ú9 — maxEngines, idleSuspendMs were moved up to ~ř.1097 so
  // workspaceRouting closures (and downstream session store memos) can
  // access them without TDZ at createSessionStore init.
  const [autoCompactContext, setAutoCompactContext] = createSignal(true);
  const [modelVariant, setModelVariant] = createSignal<string | null>(DEFAULT_MODEL_VARIANT);
  const [modelVariantPreferenceReady, setModelVariantPreferenceReady] = createSignal(false);
  const [updatePreferencesReady, setUpdatePreferencesReady] = createSignal(false);
  const [autoCompactingSessionId, setAutoCompactingSessionId] = createSignal<string | null>(null);

  const formatModelVariantLabel = (value: string | null) => {
    const normalized = normalizeModelVariant(value) ?? "none";
    const option = MODEL_VARIANT_OPTIONS.find((entry) => entry.value === normalized);
    return option ? t(option.labelKey, currentLocale()) : t("session.thinking_option_none", currentLocale());
  };


  const workspaceStore = createWorkspaceStore({
    startupPreference,
    setStartupPreference,
    onboardingStep,
    setOnboardingStep,
    rememberStartupChoice,
    setRememberStartupChoice,
    baseUrl,
    setBaseUrl,
    clientDirectory,
    setClientDirectory,
    client,
    setClient,
    routing: workspaceRouting,
    maxEngines: () => maxEngines(),
    idleSuspendMs: () => idleSuspendMs(),
    setConnectedVersion,
    setSseConnected,
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setError,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setOpencodeConnectStatus,
    loadSessions: loadSessionsWithReady,
    refreshPendingPermissions,
    selectedSessionId,
    selectSession,
    setSelectedSessionId,
    setMessages,
    setTodos,
    setPendingPermissions,
    setSessionStatusById,
    defaultModel,
    modelVariant,
    refreshSkills,
    refreshPlugins,
    engineSource,
    engineCustomBinPath,
    setEngineSource,
    setView,
    setTab,
    isWindowsPlatform,
    vesloServerSettings,
    updateVesloServerSettings,
    preferServerByDefault: () => Boolean(cloudEnvironment.vesloUrl),
    vesloServerClient,
    vesloServerHostInfo: () => vesloServerHostInfo(),
    ensureLocalVesloServerRunning: () => ensureLocalVesloServerRunning({ ignoreStartupPreference: true }),
    onEngineStable: () => {
      setEngineReady(true);
      void ensureLocalVesloServerRunning().catch((error) => {
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
        reportError(error, "veslo-server.ensure");
      });
    },
    engineRuntime,
    developerMode,
    activeSendTraceId,
    setEngineReady,
    isWorkspaceRuntimeReady,
    populateSidebarFromDb: async (workspaceId: string, directory: string) => {
      // Set status to "loading" SYNCHRONOUSLY before any await, so the idle-loader
      // effect (line ~2964) doesn't fire and try to contact the engine API.
      markWorkspaceSidebarLoading(workspaceId);
      const result = await listConversationsFromVesloReadApi(workspaceId, directory);
      const { visible: items } = partitionVesloUtilitySessions(
        result.items.map(applyPendingInitialSessionTitle),
      );
      // Don't wipe browsable rows when the read is unavailable (server/sandbox
      // unreachable, path mismatch) or transiently empty — that is the
      // "conversation disappears on workspace switch and I can't get back" bug.
      applyWorkspaceSidebarReadResult({
        workspaceId,
        items,
        available: result.source !== "unavailable",
      });
    },
    hydrateLatestSessionFromDb: async (workspaceId: string, directory: string) => {
      const result = await listConversationsFromVesloReadApi(workspaceId, directory);
      if (result.items.length === 0) return;
      const { visible } = partitionVesloUtilitySessions(result.items);
      const rememberedSessionId = activeWorkspaceLastSessionId()?.trim() ?? "";
      const latest =
        (rememberedSessionId ? visible.find((item) => item.id === rememberedSessionId) : undefined) ??
        visible[0] ??
        result.items[0];
      if (!latest) return;
      const snapshot = await getTranscriptFromVesloReadApi(workspaceId, latest.id, 50, directory);
      if (!snapshot) return;
      // Warm the cache before selecting so browse-mode selectSession can stay on
      // the passive DB path and avoid cold-starting the engine just to render.
      sessionStore.hydrateTranscriptSnapshot(snapshot);
      if (selectedSessionId()?.trim()) return;
      if (workspaceStore.activeWorkspaceId().trim() !== workspaceId.trim()) return;
      await selectSession(latest.id);
    },
  });
  workspaceStoreRef = workspaceStore;
  setWorkspaceStoreRefVersion((version) => version + 1);

  const composerTargetController = createComposerTargetController({
    isTauriRuntime,
    labels: {
      chat: () => t("session.target_chat_label", currentLocale()),
      chooseWorkspace: () => t("session.target_choose_workspace_label", currentLocale()),
      chooseWorkspaceDescription: () => t("session.target_choose_workspace_description", currentLocale()),
      targetUnavailable: () => t("session.target_not_available", currentLocale()),
    },
    activePendingDraftKey,
    setActivePendingDraftKey,
    activePendingDraftMeta,
    setActivePendingDraftMeta,
    pendingDraftsReady: activePendingDraftStorageReady,
    currentComposerStorageKey,
    composerDraft,
    pendingSessionDraftsList,
    pendingSessionDraftsPut,
    pendingSessionDraftsDelete,
    isConsumedPendingDraftId: pendingSessionDraftController.isConsumedPendingDraftId,
    markPendingDraftConsumed,
    clearConsumedPendingDraftId,
    workspace: {
      workspaces: () => workspaceStore.workspaces(),
      activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
      activeWorkspaceDisplay: () => workspaceStore.activeWorkspaceDisplay(),
      activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
      isPrivateWorkspacePath: (folder) => workspaceStore.isPrivateWorkspacePath(folder),
      createScratchWorkspace: () => workspaceStore.createScratchWorkspace(),
      forgetWorkspace: (workspaceId, options) => workspaceStore.forgetWorkspace(workspaceId, options),
      activateWorkspace: activateWorkspaceThroughBrowsePolicy,
      pickWorkspaceFolder: () => workspaceStore.pickWorkspaceFolder(),
      ensureWorkspaceForFolder: (folder) => workspaceStore.ensureWorkspaceForFolder(folder),
    },
    publishRegisteredWorkspaceToSidebar: (workspaceId) => publishRegisteredWorkspaceToSidebar(workspaceId),
    setComposerDraftBySessionId: (updater) => setComposerDraftBySessionId(updater),
    setView,
    setError,
    reportError,
    safeStringify,
    addOpencodeCacheHint,
  });

  const workspaceRootForId = (workspaceId: string, fallbackDirectory?: string | null) => {
    const id = workspaceId.trim();
    const workspace = workspaceStore.workspaces().find((item) => item.id === id) ?? null;
    return workspace?.directory?.trim() || workspace?.path?.trim() || fallbackDirectory?.trim() || "";
  };

  const workspaceSendTarget = createWorkspaceSendTarget<Client>({
    activePendingDraftMeta,
    resolveWorkspaceRoot: workspaceRootForId,
    resolveSessionSendTargetScope: workspaceSessionSelection.resolveSendTargetWorkspaceScope,
    resolveSelectedSessionBrowseScope,
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    activateWorkspace: activateWorkspaceThroughBrowsePolicy,
    recordSendTrace,
    sendTraceStep,
    messageFromUnknownError,
    routedClient,
  });
  const {
    resolveSendTargetWorkspaceScope,
    routedClientForSendTarget,
    ensureSelectedSessionWorkspaceActiveForSend,
  } = workspaceSendTarget;

  const activeWorkspaceRuntimeReady = runtimeOwner.activeWorkspaceRuntimeReady;
  const anyWorkspaceRuntimeReady = runtimeOwner.anyWorkspaceRuntimeReady;

  // VSLO-171 — per-workspace pending permissions polling is scheduled outside
  // the component body so the single-client SSE skip is shared and testable.
  createPermissionPollingScheduler({
    routedWorkspaceCount: () => workspaceRouting.entryIds().length,
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId().trim() || null,
    activeSendTraceId: activeVisibleRuntimeActivityId,
    anyWorkspaceRuntimeReady,
    refreshPendingPermissions: () => sessionStore.refreshPendingPermissions(),
  });

  // VSLO-171 F3Ú6a — per-workspace session cache save/load. In single-active
  // mode this effect is a no-op (cache stays empty). In multi mode each
  // workspace switch saves the outgoing snapshot and restores the incoming
  // one so sessions/messages/permissions don't get wiped between switches.
  // connectToServer (F3Ú6c) will skip its own state RESET when running in
  // multi so the cache is the single source of truth across switches.
  // VSLO-171 — per-workspace session cache save/load. Each workspace switch
  // saves the outgoing snapshot and restores the incoming one so sessions/
  // messages/permissions don't get wiped between switches. connectToServer
  // skips its own state RESET — this cache is the source of truth.
  createWorkspaceSessionSnapshots({
    enabled: () => activeWorkspaceIsHydrated() && !workspaceStore.connectingWorkspaceId(),
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    selectedSessionId,
    resolveSelectedSessionBrowseScope,
    saveWorkspaceSnapshot: (workspaceId) => sessionStore.saveWorkspaceSnapshot(workspaceId),
    loadWorkspaceSnapshot: (workspaceId) => sessionStore.loadWorkspaceSnapshot(workspaceId),
    canClearSelectedSession: ({ selectedSessionId }) =>
      activeWorkspaceIsHydrated() && !isRouteSelectedSession(selectedSessionId),
    clearSelectedSession: () => {
      wsDebug("snapshot:clearSelectedSession:app", {
        selectedSessionId: selectedSessionId(),
        activeWorkspaceId: workspaceStore.activeWorkspaceId(),
        route: location.pathname,
      });
      setSelectedSessionId(null);
    },
    debug: wsDebug,
  });

  const readWorkspaceRuntimeDebugSnapshot = async () => {
    const activeWorkspaceId = workspaceStore.activeWorkspaceId().trim();
    const activeWorkspace = workspaceStore.workspaces().find((workspace) => workspace.id === activeWorkspaceId) ?? null;
    const activeWorkspaceRoot = workspaceStore.activeWorkspaceRoot().trim();
    const selected = selectedSessionId()?.trim() ?? "";
    const selectedScope = selected ? resolveSelectedSessionBrowseScope(selected) : null;
    const sendTarget = resolveSendTargetWorkspaceScope(selected || undefined);
    const routedEntryIds = workspaceRouting.entryIds();
    const runtimeRoot = typeof window === "undefined" ? null : (window as unknown as WorkspaceRuntimeDebugRoot);
    const clientSnapshot = client();
    const vesloClient = vesloServerClient();

    const [
      tauriWorkspaceBootstrap,
      tauriEngineInfo,
      tauriVesloServerInfo,
      liveOrchestratorStatus,
      liveOrchestratorEngines,
      liveServerStatus,
      liveServerWorkspaces,
    ] = await Promise.all([
      isTauriRuntime()
        ? debugProbeCall(() => workspaceBootstrap())
        : debugProbeSkipped("not running in Tauri"),
      isTauriRuntime()
        ? debugProbeCall(() => engineInfo(activeWorkspaceId || undefined, activeWorkspaceRoot || undefined))
        : debugProbeSkipped("not running in Tauri"),
      isTauriRuntime()
        ? debugProbeCall(() => vesloServerInfo())
        : debugProbeSkipped("not running in Tauri"),
      isTauriRuntime()
        ? debugProbeCall(() => orchestratorStatus())
        : debugProbeSkipped("not running in Tauri"),
      isTauriRuntime()
        ? debugProbeCall(() => orchestratorEnginesList())
        : debugProbeSkipped("not running in Tauri"),
      vesloClient
        ? debugProbeCall(() => vesloClient.status())
        : debugProbeSkipped("no Veslo server client"),
      vesloClient
        ? debugProbeCall(() => vesloClient.listWorkspaces())
        : debugProbeSkipped("no Veslo server client"),
    ]);

    const snapshot: Record<string, any> = {
      capturedAt: new Date().toISOString(),
      capturedAtMs: Date.now(),
      app: {
        route: location.pathname,
        view: currentView(),
        tab: tab(),
        activeWorkspaceId,
        connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
        workspacesHydrated: workspaceStore.workspacesHydrated(),
        activeWorkspaceIsHydrated: activeWorkspaceIsHydrated(),
        activeWorkspace: debugSummarizeWorkspace(activeWorkspace),
        activeWorkspaceRoot,
        activeWorkspacePath: workspaceStore.activeWorkspacePath().trim(),
        projectDir: workspaceStore.projectDir().trim(),
        authorizedDirs: workspaceStore.authorizedDirs(),
        workspaceConfigLoaded: workspaceStore.workspaceConfigLoaded(),
        workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
        workspaceBusy: workspaceStore.workspaceBusy(),
        engineReady: engineReady(),
        baseUrl: baseUrl().trim(),
        clientDirectory: clientDirectory().trim(),
        hasGlobalClient: Boolean(clientSnapshot),
        engine: workspaceStore.engine(),
        workspaces: workspaceStore.workspaces().map(debugSummarizeWorkspace),
      },
      session: {
        selectedSessionId: selected || null,
        selectedScope,
        sendTarget,
        activePendingDraftKey: activePendingDraftKey(),
        activePendingDraftMeta: activePendingDraftMeta(),
      },
      routing: {
        activeWorkspaceId: workspaceRouting.activeWorkspaceId(),
        entryIds: routedEntryIds,
        hasActiveClient: Boolean(workspaceRouting.active()),
        entries: routedEntryIds.map((workspaceId) => {
          const entry = workspaceRouting.entry(workspaceId);
          return {
            workspaceId,
            baseUrl: entry?.baseUrl ?? null,
            directory: entry?.directory ?? null,
            lastUsed: entry?.lastUsed ?? null,
            isActive: workspaceId === activeWorkspaceId,
            baseUrlMountWorkspaceId: debugWorkspaceIdFromMountedBaseUrl(entry?.baseUrl ?? null) || null,
          };
        }),
      },
      tauri: {
        runtime: isTauriRuntime(),
        workspaceBootstrap: tauriWorkspaceBootstrap,
        engineInfo: tauriEngineInfo,
        vesloServerInfo: tauriVesloServerInfo,
      },
      server: {
        statusSignal: vesloServerStatus(),
        clientBaseUrl: vesloClient?.baseUrl ?? null,
        hostInfo: vesloServerHostInfo(),
        diagnosticsSignal: vesloServerDiagnostics(),
        status: liveServerStatus,
        workspaces: liveServerWorkspaces,
        requestBroker: getVesloRequestBrokerSnapshot(),
      },
      orchestrator: {
        warmEngineWorkspaceIds: Array.from(readyEngineWorkspaceIds()),
        engineSnapshotsSignal: orchestratorEnginesState(),
        status: liveOrchestratorStatus,
        engines: liveOrchestratorEngines,
      },
      debugTail: {
        workspaceEvents: workspaceStore.workspaceDebugEvents().slice(-40),
        sendTrace: runtimeRoot?.__vesloSendTrace?.slice(-40) ?? [],
        busyTrace: runtimeRoot?.__vesloWorkspaceBusyTrace?.slice(-40) ?? [],
        activationLog: runtimeRoot?.__wsActivateLog?.split("\n").filter(Boolean).slice(-80) ?? [],
      },
    };

    return snapshot;
  };

  const workspaceRuntimeDebugProbe = createWorkspaceRuntimeDebugProbe({
    windowTarget: () => typeof window === "undefined" ? null : (window as unknown as WorkspaceRuntimeDebugRoot),
    readSnapshot: readWorkspaceRuntimeDebugSnapshot,
    getRequestBrokerSnapshot: getVesloRequestBrokerSnapshot,
    log: wsDebug,
    consoleLog: (label, payload) => console.log(label, payload),
  });

  let cleanupWorkspaceRuntimeDebugProbe: (() => void) | null = null;
  onMount(() => {
    cleanupWorkspaceRuntimeDebugProbe = workspaceRuntimeDebugProbe.install();
  });
  onCleanup(() => {
    cleanupWorkspaceRuntimeDebugProbe?.();
    cleanupWorkspaceRuntimeDebugProbe = null;
  });

  const skillRegistryOrchestrator = createSkillRegistryOrchestrator({
    vesloServerClient,
    vesloServerStatus,
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    workspaceBusy: () => workspaceStore.workspaceBusy(),
    denAuthRevision,
    readDenAuth,
    refreshSkills,
    invalidateSkillRegistryInventory: () => extensionsStore.invalidateSkillRegistryInventory(),
    markReloadRequired,
    reportError,
  });
  const skillRegistryMaterializationAuthContext = skillRegistryOrchestrator.materializationAuthContext;

  const activeArtifactFamilies = createMemo(() =>
    resolveArtifactFamilies({
      serverArtifacts: currentLatestRunArtifactResponse()?.items,
      preferServerArtifacts: Boolean(currentLatestRunArtifactResponse()),
      legacyArtifacts: currentLatestRunArtifactResponse() ? [] : artifacts(),
      workingFiles: currentLatestRunArtifactResponse() ? [] : workingFiles(),
      workspaceRoot:
        (activeSessionId() ? resolveSelectedSessionBrowseScope(activeSessionId()!)?.workspaceRoot : null) ||
        workspaceStore.activeWorkspaceRoot().trim(),
    }),
  );

  const shouldSyncConversationReadForWorkspace =
    runtimeOwner.shouldSyncConversationReadForWorkspace;

  const sidebarWorkspaceSessions = createSidebarWorkspaceSessions({
    workspaceStore,
    workspaceRouting,
    activeWorkspaceRuntimeReady,
    directoryQueryPathMode,
    activeSendTraceId: activeVisibleRuntimeActivityId,
    developerMode: () => developerMode(),
    sessions: () => sessions(),
    sessionDirectoryOverrideById,
    resolveSessionDirectory,
    applySessionDirectoryOverride,
    applyPendingInitialSessionTitle,
    listConversationsFromVesloReadApi,
    shouldSyncConversationRead: shouldSyncConversationReadForWorkspace,
    backfillConversationsToVesloReadApi,
    reportError,
    wsDebug,
  });
  const {
    sidebarWorkspaceGroups,
    workspaceSessionPagingById,
    clearStaleWorkspaceSessionError,
    refreshSidebarWorkspaceSessions,
    loadMoreWorkspaceSidebarSessions,
    publishRegisteredWorkspaceToSidebar,
    markWorkspaceSidebarLoading,
    applyWorkspaceSidebarReadResult,
    removeSessionFromWorkspaceSidebar,
    prependSessionToWorkspaceSidebar,
    materializePendingSessionInWorkspaceSidebar,
    moveSessionBetweenWorkspaceSidebars,
    ensureSessionInWorkspaceSidebar,
  } = sidebarWorkspaceSessions;

  const pendingSidebarSessionToItem = (pending: PendingSidebarSessionMetadata): SidebarSessionItem => ({
    id: pending.id,
    title: pending.title.trim() || "New session",
    time: {
      created: pending.createdAt,
      updated: pending.createdAt,
    },
    directory: pending.workspaceRoot,
    conversationId: null,
    opencodeSessionId: null,
    pendingSessionInstanceId: pending.id,
  });

  const registerPendingSidebarSession = (pending: PendingSidebarSessionMetadata) => {
    const workspaceId = pending.workspaceId.trim();
    const pendingId = pending.id.trim();
    if (!workspaceId || !pendingId) return;
    const pendingItem = pendingSidebarSessionToItem(pending);
    prependSessionToWorkspaceSidebar(workspaceId, pendingItem);
  };

  const shouldClearSessionRouteForProjectOpen = (workspaceId: string, origin?: string | null) => {
    const nextWorkspaceId = workspaceId.trim();
    if (!nextWorkspaceId) return false;
    if (origin !== "workspace-session-list:project-open") return false;
    if (!location.pathname.toLowerCase().startsWith("/session/")) return false;
    return nextWorkspaceId !== workspaceStore.activeWorkspaceId().trim();
  };

  const handleActivateWorkspace: typeof workspaceStore.activateWorkspace = (workspaceId, options) => {
    if (typeof workspaceId === "string") {
      clearStaleWorkspaceSessionError(workspaceId);
      if (shouldClearSessionRouteForProjectOpen(workspaceId, options?.origin)) {
        wsDebug("route:workspace-project-open:clear-session-route", {
          from: location.pathname,
          activeWorkspaceId: workspaceStore.activeWorkspaceId(),
          nextWorkspaceId: workspaceId,
        });
        navigate("/session", { replace: true });
      }
    }
    if (isPassiveLocalBrowseActivationOrigin(options?.origin)) {
      return activateWorkspaceThroughBrowsePolicy(workspaceId, options);
    }
    return workspaceStore.activateWorkspace(workspaceId, options);
  };

  createEffect(() => {
    const liveIds = new Set(
      sidebarWorkspaceGroups().flatMap((group) => group.sessions.map((session) => session.id)),
    );
    setUnreadSessionIds((current) => pruneUnreadSessions(current, liveIds));
  });
  const sessionArchiveStore = createSessionArchiveStore({
    vesloArchiveClient,
    sessionArchiveOwnerKey,
    vesloServerStatus,
    vesloServerCheckedAt,
    workspaces: workspaceStore.workspaces,
    sidebarWorkspaceGroups,
    reportError,
    setError,
  });
  const archivedSessionIds = sessionArchiveStore.archivedSessionIds;
  const sessionArchives = sessionArchiveStore.sessionArchives;
  const archiveSidebarSession = sessionArchiveStore.archiveSession;
  const unarchiveSession = sessionArchiveStore.unarchiveSession;

  const sessionSidebarDecorations = createSessionSidebarDecorations({
    locale: () => (currentLocale() === "cs" ? "cs" : "en"),
    sidebarWorkspaceGroups,
  });
  const { subagentDecorationsBySessionId } = sessionSidebarDecorations;

  pendingSessionDraftController.createActivePendingDraftPersistenceEffect({
    selectedSessionId,
    composerDraft,
  });

  createEffect(() => {
    // Only auto-select on bare /session. If the URL already includes /session/:id,
    // let the route-driven selector own the fetch to avoid duplicate selection runs.
    if (currentView() !== "session") return;
    const normalizedPath = location.pathname.toLowerCase().replace(/\/+$/, "");
    if (normalizedPath !== "/session") return;
    if (!routedClient()) return;
    if (!sessionsLoadedForActiveWorkspace()) return;
    if (creatingSession()) return;
    if (selectedSessionId()) return;

    // Keep /session as a draft-ready empty state until the user picks a session
    // or sends a prompt. Avoid auto-selecting prior sessions on app launch.
    return;
  });

  function isRouteSelectedSession(sessionId: string) {
    const [, , sessionSegment] = location.pathname.trim().split("/");
    return Boolean(sessionSegment?.trim() && sessionSegment.trim() === sessionId.trim());
  }

  const sessionRouteSync = createSessionRouteSync({
    pathname: () => location.pathname,
    sidebarWorkspaceGroups,
    sessions,
    scopedSessionIds,
    resolveSelectedSessionBrowseScope,
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    clientDirectory,
    routedClient: (workspaceId) => routedClient(workspaceId),
    connectedVersion,
    sessionsLoadedForActiveWorkspace,
    selectedSessionId,
    visibleMessages,
    selectedSessionLoadingEarlierMessages,
    activePendingDraftKey,
    activePendingDraftMeta,
    isPendingSessionInstanceId,
    visibleSelectedSessionStatus,
    setSelectedSessionId,
    setMessages,
    setTodos,
    selectSession,
    navigate: (to, options) => navigate(to, options),
  });
  sessionRouteSync.startRouteResumeEffect();

  createEffect(() => {
    const active = workspaceStore.activeWorkspaceDisplay();
    const client = vesloServerClient();
    const vesloUrl = vesloServerUrl().trim();

    if (!client || vesloServerStatus() !== "connected") {
      setVesloServerWorkspaceId(null);
      return;
    }

    if (active.workspaceType === "remote" && active.remoteType === "veslo") {
      const inferredWorkspaceId =
        parseVesloWorkspaceIdFromUrl(active.vesloHostUrl ?? "") ??
        parseVesloWorkspaceIdFromUrl(active.baseUrl ?? "") ??
        parseVesloWorkspaceIdFromUrl(vesloUrl);
      const storedId = active.vesloWorkspaceId?.trim() || inferredWorkspaceId || envVesloWorkspaceId || null;
      if (storedId) {
        setVesloServerWorkspaceId(storedId);
        return;
      }

      let cancelled = false;
      const resolveWorkspace = async () => {
        try {
          const response = await client.listWorkspaces();
          if (cancelled) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const directoryHint = normalizeDirectoryPath(active.directory?.trim() ?? active.path?.trim() ?? "");
          const matchByDirectory = directoryHint
            ? items.find((entry) => {
                const entryPath = normalizeDirectoryPath((entry.opencode?.directory ?? entry.directory ?? entry.path ?? "").trim());
                return Boolean(entryPath && entryPath === directoryHint);
              })
            : undefined;
          const matchByActiveId = response.activeId
            ? items.find((entry) => entry.id === response.activeId)
            : undefined;
          const match = matchByDirectory || matchByActiveId || items[0];
          setVesloServerWorkspaceId(match?.id ?? response.activeId ?? null);
        } catch {
          if (!cancelled) setVesloServerWorkspaceId(null);
        }
      };

      void resolveWorkspace();
      onCleanup(() => {
        cancelled = true;
      });
      return;
    }

    if (active.workspaceType === "local") {
      setVesloServerWorkspaceId(active.id?.trim() || workspaceStore.activeWorkspaceId().trim() || null);
      return;
    }

    setVesloServerWorkspaceId(null);
  });

  createEffect(() => {
    if (!developerMode()) {
      setDevtoolsWorkspaceId(null);
      return;
    }
    if (!documentVisible()) return;

    const client = devtoolsVesloClient();
    if (!client) {
      setDevtoolsWorkspaceId(null);
      return;
    }

    const root = normalizeDirectoryPath(workspaceStore.activeWorkspaceRoot().trim());
    let active = true;

    const run = async () => {
      try {
        const response = await client.listWorkspaces();
        if (!active) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const activeMatch = response.activeId ? items.find((item) => item.id === response.activeId) : null;
        const match = root ? items.find((item) => normalizeDirectoryPath(item.path) === root) : activeMatch ?? items[0];
        setDevtoolsWorkspaceId(activeMatch?.id ?? match?.id ?? null);
      } catch {
        if (active) setDevtoolsWorkspaceId(null);
      }
    };

    run();
    const interval = window.setInterval(run, 20_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!developerMode()) {
      setVesloAuditEntries([]);
      setVesloAuditStatus("idle");
      setVesloAuditError(null);
      return;
    }
    if (!documentVisible()) return;

    const client = devtoolsVesloClient();
    const workspaceId = devtoolsWorkspaceId();
    if (!client || !workspaceId) {
      setVesloAuditEntries([]);
      setVesloAuditStatus("idle");
      setVesloAuditError(null);
      return;
    }

    let active = true;
    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      setVesloAuditStatus("loading");
      setVesloAuditError(null);
      try {
        const result = await client.listAudit(workspaceId, 50);
        if (!active) return;
        setVesloAuditEntries(Array.isArray(result.items) ? result.items : []);
        setVesloAuditStatus("idle");
      } catch (error) {
        if (!active) return;
        setVesloAuditEntries([]);
        setVesloAuditStatus("error");
        setVesloAuditError(error instanceof Error ? error.message : "Failed to load audit log.");
      } finally {
        busy = false;
      }
    };

    run();
    const interval = window.setInterval(run, 15_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    const active = workspaceStore.activeWorkspaceDisplay();
    if (active.workspaceType !== "remote" || active.remoteType !== "veslo") {
      return;
    }
    const hostUrl = active.vesloHostUrl?.trim() ?? "";
    if (!hostUrl) return;
    const token = active.vesloToken?.trim() ?? "";
    const settings = vesloServerSettings();
    if (settings.urlOverride?.trim() === hostUrl && (!token || settings.token?.trim() === token)) {
      return;
    }
    updateVesloServerSettings({
      ...settings,
      urlOverride: hostUrl,
      token: token || settings.token,
    });
  });

  const vesloServerReady = createMemo(() => vesloServerStatus() === "connected");
  const vesloServerWorkspaceReady = createMemo(() => Boolean(vesloServerWorkspaceId()));
  const resolvedVesloCapabilities = createMemo(() => vesloServerCapabilities());
  const vesloServerCanWriteSkills = createMemo(
    () =>
      vesloServerReady() &&
      vesloServerWorkspaceReady() &&
      (resolvedVesloCapabilities()?.skills?.write ?? false),
  );
  const vesloServerCanWritePlugins = createMemo(
    () =>
      vesloServerReady() &&
      vesloServerWorkspaceReady() &&
      (resolvedVesloCapabilities()?.plugins?.write ?? false),
  );
  const devtoolsCapabilities = createMemo(() => vesloServerCapabilities());
  const resolvedDevtoolsWorkspaceId = createMemo(() => devtoolsWorkspaceId() ?? vesloServerWorkspaceId());

  const sessionCapabilitiesStore = createSessionCapabilitiesStore({
    selectedSessionId,
    selectedSession,
    sidebarWorkspaceGroups,
    resolveSessionDirectory: (session) => resolveSessionDirectory({ id: session.id, directory: session.directory ?? "" }),
    workspaces: workspaceStore.workspaces,
    activeWorkspaceId: workspaceStore.activeWorkspaceId,
    activeWorkspaceDisplay: workspaceStore.activeWorkspaceDisplay,
    activeWorkspaceRoot: workspaceStore.activeWorkspaceRoot,
    workspaceProjectDir: () => workspaceProjectDir(),
    baseUrl,
    connectedVersion,
    client,
    activeWorkspaceRuntimeReady,
    activeVisibleRuntimeActivityId,
    developerMode,
    vesloServerClient,
    vesloServerStatus,
    vesloServerBaseUrl,
    vesloServerWorkspaceId,
    vesloCapabilities: resolvedVesloCapabilities,
    skillInventory,
    refreshSkillInventory,
    recordPerfLog,
  });
  resolveSessionCapabilitySkillInventoryWorkspaces = sessionCapabilitiesStore.skillInventoryWorkspaces;
  const sessionCapabilitiesSnapshot = sessionCapabilitiesStore.sessionCapabilities;
  const sessionCapabilitiesStatus = sessionCapabilitiesStore.sessionCapabilitiesStatus;
  const sessionCapabilitiesError = sessionCapabilitiesStore.sessionCapabilitiesError;

  const [editRemoteWorkspaceOpen, setEditRemoteWorkspaceOpen] = createSignal(false);
  const [editRemoteWorkspaceId, setEditRemoteWorkspaceId] = createSignal<string | null>(null);
  const [editRemoteWorkspaceError, setEditRemoteWorkspaceError] = createSignal<string | null>(null);
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = createSignal(false);
  const [renameWorkspaceId, setRenameWorkspaceId] = createSignal<string | null>(null);
  const [renameWorkspaceName, setRenameWorkspaceName] = createSignal("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = createSignal(false);

  const showRemoteActions = createMemo(() => isRemoteUiEnabled());
  const quickAddWorkerEnabled = createMemo(
    () => (CLOUD_ONLY_MODE || showRemoteActions()) && !isTauriRuntime(),
  );

  const appDeepLinkWorkflow = createAppDeepLinkWorkflow({
    booting,
    startupPreference: () => startupPreference() ?? "",
    setStartupPreference,
    onboardingStep,
    setOnboardingStep,
    vesloServerSettings,
    setVesloServerSettings,
    readVesloServerSettings,
    writeVesloServerSettings,
    activeVesloServerHostInfo,
    vesloServerClient,
    vesloServerWorkspaceId,
    vesloServerStatus,
    workspace: {
      createRemoteWorkspaceOpen: workspaceStore.createRemoteWorkspaceOpen,
      setCreateRemoteWorkspaceOpen: workspaceStore.setCreateRemoteWorkspaceOpen,
      createRemoteWorkspaceFlow: workspaceStore.createRemoteWorkspaceFlow,
    },
    setView,
    setTab,
    setError,
    queueAuthCompleteDeepLink,
    quickAddWorkerEnabled,
    cloudOnlyMode: () => CLOUD_ONLY_MODE,
    refreshSkills,
    refreshHubSkills,
    addOpencodeCacheHint,
    safeStringify,
  });
  const {
    deepLinkRemoteWorkspaceDefaults,
    clearRemoteDefaultsWhenModalCloses,
    openCreateRemoteWorkspace,
  } = appDeepLinkWorkflow;

  onMount(() => {
    if (typeof window !== "undefined") {
      try {
        clearLegacySessionModelPersistence(window.localStorage);
      } catch {
        // ignore
      }
    }
  });

  const editRemoteWorkspaceDefaults = createMemo(() => {
    const workspaceId = editRemoteWorkspaceId();
    if (!workspaceId) return null;
    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "remote") return null;
    return {
      vesloHostUrl: workspace.vesloHostUrl ?? workspace.baseUrl ?? "",
      vesloToken: workspace.vesloToken ?? vesloServerSettings().token ?? "",
      directory: workspace.directory ?? "",
      displayName: workspace.displayName ?? "",
    };
  });

  const openRenameWorkspace = (workspaceId: string) => {
    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceName(
      workspace.displayName?.trim() ||
        workspace.vesloWorkspaceName?.trim() ||
        workspace.name?.trim() ||
        ""
    );
    setRenameWorkspaceOpen(true);
  };

  const closeRenameWorkspace = () => {
    if (renameWorkspaceBusy()) return;
    setRenameWorkspaceOpen(false);
    setRenameWorkspaceId(null);
    setRenameWorkspaceName("");
  };

  const saveRenameWorkspace = async () => {
    const workspaceId = renameWorkspaceId();
    if (!workspaceId) return;
    const nextName = renameWorkspaceName().trim();
    if (!nextName) return;
    if (renameWorkspaceBusy()) return;

    setRenameWorkspaceBusy(true);
    setError(null);
    try {
      const ok = await workspaceStore.updateWorkspaceDisplayName(workspaceId, nextName);
      if (!ok) return;
      setRenameWorkspaceOpen(false);
      setRenameWorkspaceId(null);
      setRenameWorkspaceName("");
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setError(addOpencodeCacheHint(message));
    } finally {
      setRenameWorkspaceBusy(false);
    }
  };

  const restartLocalServer = async () => {
    const activeWorkspace = workspaceStore.activeWorkspaceDisplay();
    const activeLocalPath =
      activeWorkspace.workspaceType === "local" ? workspaceStore.activeWorkspacePath().trim() : "";
    const runningProjectDir = workspaceStore.engine()?.projectDir?.trim() ?? "";
    const workspacePath = activeLocalPath || runningProjectDir;

    if (!workspacePath) {
      setError("Pick a local worker folder before restarting the local server.");
      return false;
    }

    return workspaceStore.startHost({ workspacePath, navigate: false });
  };

  const openWorkspaceConnectionSettings = (workspaceId: string) => {
    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (workspace?.workspaceType === "remote" && workspace.remoteType === "veslo") {
      setEditRemoteWorkspaceId(workspace.id);
      setEditRemoteWorkspaceError(null);
      setEditRemoteWorkspaceOpen(true);
      return;
    }
    if (workspace?.workspaceType === "remote") {
      setEditRemoteWorkspaceId(workspace.id);
      setEditRemoteWorkspaceError(null);
      setEditRemoteWorkspaceOpen(true);
      return;
    }
    setTab("config");
    setView("dashboard");
  };

  const canReloadLocalEngine = () =>
    isTauriRuntime() && workspaceStore.activeWorkspaceDisplay().workspaceType === "local";

  const canReloadWorkspace = createMemo(() => {
    if (canReloadLocalEngine()) return true;
    if (workspaceStore.activeWorkspaceDisplay().workspaceType !== "remote") return false;
    return vesloServerStatus() === "connected" && Boolean(vesloServerClient() && vesloServerWorkspaceId());
  });

  let refreshMcpServers: ReturnType<typeof createMcpServersRefresher>;

  const mcpConnectionWorkflow = createMcpConnectionWorkflow({
    workspaceType: () => workspaceStore.activeWorkspaceDisplay().workspaceType,
    workspaceProjectDir: () => workspaceProjectDir(),
    setWorkspaceProjectDir: (projectDir: string) => workspaceStore.setProjectDir(projectDir),
    isTauriRuntime,
    routedClient,
    createClient,
    setClient,
    vesloServerStatus,
    vesloServerClient,
    vesloServerWorkspaceId,
    setVesloServerWorkspaceId,
    vesloCapabilities: () => resolvedVesloCapabilities(),
    vesloServerBaseUrl,
    vesloServerAuth,
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    activeRuntimeActivityId: activeVisibleRuntimeActivityId,
    activeWorkspaceRuntimeReady,
    mcpServers: () => mcpServers(),
    selectedMcp: () => selectedMcp(),
    setSelectedMcp,
    setMcpStatus,
    setMcpConnectingName,
    setMcpStatuses,
    setMcpAuthEntry,
    setMcpAuthNeedsReload,
    setMcpAuthModalOpen,
    setNotionStatus,
    setNotionStatusDetail,
    setNotionError,
    notionBusy,
    setNotionBusy,
    setNotionSkillInstalled,
    setTryNotionPromptVisible,
    localizedMcpQuickConnect: () => localizedMcpQuickConnect(),
    hubMcpCards: () => hubMcpCards(),
    refreshMcpServers: (options) => refreshMcpServers(options),
    installHubMcp,
    readOpencodeConfig,
    writeOpencodeConfig,
    removeMcpFromConfig,
    canRemoveMcpFromProjectConfig,
    quickConnectEntryKey,
    validateMcpServerName,
    readDenAuth,
    fetch: (input, init) => fetch(input, init),
    openDesktopAuthUrl,
    unwrap,
    currentLocale: () => currentLocale(),
    translate: (key, locale) => t(key, locale as Language),
    normalizeDirectoryQueryPath,
    recordPerfLog,
    finishPerf,
    developerMode: () => developerMode(),
    perfNow,
    safeStringify,
  });

  const {
    connectNotion,
    connectMcp,
    authorizeMcp,
    installHubMcpAndActivate,
    logoutMcpAuth,
    removeMcp,
  } = mcpConnectionWorkflow;

  refreshMcpServers = createMcpServersRefresher({
    projectDir: () => workspaceProjectDir(),
    workspaceType: () => workspaceStore.activeWorkspaceDisplay().workspaceType,
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    activeRuntimeActivityId: activeVisibleRuntimeActivityId,
    isTauriRuntime,
    developerMode: () => developerMode(),
    vesloServerStatus,
    vesloServerClient,
    vesloServerWorkspaceId,
    vesloCapabilities: () => resolvedVesloCapabilities(),
    setMcpStatus,
    setMcpServers,
    setMcpStatuses,
    setMcpLastUpdatedAt,
    scheduleRuntimeStatusRefresh: mcpConnectionWorkflow.scheduleMcpRuntimeStatusRefresh,
  });

  const reloadWorkspaceEngineFromUi = async () => {
    if (canReloadLocalEngine()) {
      return workspaceStore.reloadWorkspaceEngine();
    }

    if (workspaceStore.activeWorkspaceDisplay().workspaceType !== "remote") {
      return false;
    }

    const client = vesloServerClient();
    const workspaceId = vesloServerWorkspaceId();
    if (!client || !workspaceId || vesloServerStatus() !== "connected") {
      setError("Connect to this worker before applying runtime changes.");
      return false;
    }

    try {
      await client.reloadEngine(workspaceId);
      await workspaceStore.activateWorkspace(workspaceStore.activeWorkspaceId(), {
        origin: "app:reload-workspace-engine",
        blockingOverlay: true,
      });
      await refreshMcpServers({ mode: "explicit", reason: "remote-engine-reload" });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to apply runtime changes.";
      setError(message);
      return false;
    }
  };

  const systemState = createSystemState({
    client,
    routing: runtimeOwnedRouting,
    sessions,
    sessionStatusById,
    workspaceBusy: workspaceStore.workspaceBusy,
    refreshPlugins,
    refreshSkills,
    refreshMcpServers,
    reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
    canReloadWorkspaceEngine: () => canReloadWorkspace(),
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setError,
    notion: {
      status: notionStatus,
      setStatus: setNotionStatus,
      statusDetail: notionStatusDetail,
      setStatusDetail: setNotionStatusDetail,
      skillInstalled: notionSkillInstalled,
      setTryPromptVisible: setTryNotionPromptVisible,
    },
  });

  const {
    reloadRequired,
    reloadReasons,
    reloadCopy,
    reloadTrigger,
    reloadBusy,
    reloadError,
    reloadWorkspaceEngine,
    clearReloadRequired,
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
    resetModalText,
    setResetModalText,
    resetModalBusy,
    openResetModal,
    confirmReset,
    anyActiveRuns,
  } = systemState;

  markReloadRequiredHandler = systemState.markReloadRequired;
  onHotReloadAppliedHandler = () => {
    const hadPendingSkillFallback = skillReloadGuard.hotReloadApplied();
    if (hadPendingSkillFallback) {
      setPendingSkillFallbackAutoReload(false);
    }

    const reasons = reloadReasons();
    if (reasons.length === 1 && reasons[0] === "skills") {
      clearReloadRequired();
    }

    void refreshSkills({ force: true });
    void refreshPlugins(pluginScope());
    void refreshMcpServers();
  };

  const UPDATE_AUTO_CHECK_POLL_MS = 60_000;

  const resetAppConfigDefaults = async () => {
    try {
      if (typeof window !== "undefined") {
        try {
          clearLegacySessionModelPersistence(window.localStorage);
        } catch {
          // ignore
        }
      }

      setSessionModelOverrideById({});
      setThemeMode("system");
      updateEngineSource(isTauriRuntime() ? "sidecar" : "path", { explicit: false });
      setEngineCustomBinPath("");
      setEngineRuntime("veslo-orchestrator");
      setDefaultModel(DEFAULT_MODEL);
      setLegacyDefaultModel(DEFAULT_MODEL);
      setDefaultModelExplicit(false);
      setShowThinking(false);
      setHideTitlebar(false);
      setAutoCompactContext(true);
      setModelVariant(DEFAULT_MODEL_VARIANT);
      setUpdateAutoCheck(true);
      setUpdateAutoDownload(DEFAULT_UPDATE_AUTO_DOWNLOAD);
      setUpdateStatus({ state: "idle", lastCheckedAt: null });
      clearStartupPreference();
      setStartupPreference(null);
      setRememberStartupChoice(false);

      clearVesloServerSettings();
      setVesloServerSettings(readVesloServerSettings());

      setNotionStatus("disconnected");
      setNotionStatusDetail(null);
      setNotionError(null);
      setNotionSkillInstalled(false);
      setTryNotionPromptVisible(false);

      return { ok: true, message: t("settings.reset_config_defaults_success", currentLocale()) };
    } catch (error) {
      const message = error instanceof Error ? error.message : t("settings.reset_config_defaults_failed", currentLocale());
      return { ok: false, message };
    }
  };

  const workspaceAutoReloadAvailable = createMemo(() =>
    false,
  );

  const workspaceAutoReloadEnabled = createMemo(() => {
    if (!workspaceAutoReloadAvailable()) return false;
    const cfg = workspaceStore.workspaceConfig();
    return Boolean(cfg?.reload?.auto);
  });

  const workspaceAutoReloadResumeEnabled = createMemo(() => {
    if (!workspaceAutoReloadAvailable()) return false;
    const cfg = workspaceStore.workspaceConfig();
    return Boolean(cfg?.reload?.resume);
  });

  const setWorkspaceAutoReloadEnabled = async (next: boolean) => {
    if (!workspaceAutoReloadAvailable()) return;
    const cfg = workspaceStore.workspaceConfig();
    const resume = Boolean(cfg?.reload?.resume);
    await workspaceStore.persistReloadSettings({ auto: next, resume: next ? resume : false });
  };

  const setWorkspaceAutoReloadResumeEnabled = async (next: boolean) => {
    if (!workspaceAutoReloadAvailable()) return;
    const cfg = workspaceStore.workspaceConfig();
    const auto = Boolean(cfg?.reload?.auto);
    await workspaceStore.persistReloadSettings({ auto, resume: auto ? next : false });
  };

  const reloadWorkspaceEngineAndResume = async () => {
    await reloadWorkspaceEngine();
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

  const isRuntimeSessionStatusActive = (status: string | null | undefined) => {
    const normalized = status?.trim() ?? "";
    return Boolean(normalized && normalized !== "idle");
  };

  const workspaceTitleForActiveRun = (workspaceId: string) => {
    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    return workspace?.displayName?.trim() || workspace?.name?.trim() || workspace?.path?.trim() || workspaceId;
  };

  const findSidebarSessionForWorkspace = (workspaceId: string, sessionId: string) => {
    const group = sidebarWorkspaceGroups().find((item) => item.workspace.id === workspaceId);
    if (!group) return null;
    return group.sessions.find((session) => {
      const ids = [session.id, session.conversationId ?? "", session.opencodeSessionId ?? ""]
        .map((value) => value.trim())
        .filter(Boolean);
      return ids.includes(sessionId);
    }) ?? null;
  };

  const activeReloadBlockingSessions = createMemo<ActiveReloadBlockingSession[]>(() => {
    const statuses = sessionStatusById();
    const byKey = new Map<string, ActiveReloadBlockingSession>();
    const addSession = (entry: ActiveReloadBlockingSession) => {
      const id = entry.id.trim();
      const workspaceId = entry.workspaceId?.trim() || "";
      if (!id) return;
      byKey.set(`${workspaceId}\0${id}`, { ...entry, id, workspaceId });
    };

    for (const session of sessions()) {
      const scope = resolveSelectedSessionBrowseScope(session.id);
      const workspaceId = scope?.workspaceId?.trim() || workspaceStore.activeWorkspaceId().trim();
      if (!isRuntimeSessionStatusActive(readSessionStatus(statuses, workspaceId, session.id))) continue;
      const directory = scope?.directory?.trim() || sessionDirectoryOverrideById()[session.id]?.trim() || session.directory?.trim() || "";
      addSession({
        id: session.id,
        title: session.title?.trim() || session.slug?.trim() || session.id,
        workspaceId,
        workspaceRoot: scope?.workspaceRoot?.trim() || resolveWorkspaceRootForConversationScope(workspaceId, directory),
        directory,
        conversationId: scope?.conversationId ?? null,
        opencodeSessionId: scope?.opencodeSessionId ?? session.id,
      });
    }

    for (const [workspaceId, busySessions] of Object.entries(workspaceStore.workspaceBusy())) {
      for (const idRaw of Object.keys(busySessions)) {
        const id = idRaw.trim();
        if (!workspaceId || !id) continue;
        const sidebarSession = findSidebarSessionForWorkspace(workspaceId, id);
        const directory = sidebarSession?.directory?.trim() || "";
        const workspaceTitle = workspaceTitleForActiveRun(workspaceId);
        const title = sidebarSession?.title?.trim() || sidebarSession?.slug?.trim() || id;
        addSession({
          id,
          title: `${title} (${workspaceTitle})`,
          workspaceId,
          workspaceRoot: resolveWorkspaceRootForConversationScope(workspaceId, directory),
          directory,
          conversationId: sidebarSession?.conversationId ?? null,
          opencodeSessionId: sidebarSession?.opencodeSessionId ?? id,
        });
      }
    }

    return Array.from(byKey.values());
  });

  createEffect(() => {
    if (!reloadBusy()) return;
    if (!skillReloadGuard.hasPending()) return;
    skillReloadGuard.hotReloadApplied();
    setPendingSkillFallbackAutoReload(false);
  });

  // Legacy skill-fallback auto-reload removed. OpenCode now hot-reloads
  // skills, and the auto-reload was kicking off engine restarts during
  // workspace browsing — wiping the user's session view. The reload-required
  // banner is still shown via markReloadRequired so the user can reload
  // explicitly if they need to.
  createEffect(() => {
    if (!pendingSkillFallbackAutoReload()) return;
    setPendingSkillFallbackAutoReload(false);
  });

  const forceStopActiveSessionsAndReload = async () => {
    const activeSessions = activeReloadBlockingSessions();
    for (const session of activeSessions) {
      try {
        await abortSession(session.id, session);
      } catch {
        // ignore and continue stopping the rest before reload
      }
    }
    await reloadWorkspaceEngineAndResume();
  };

  onMount(() => {
    // OpenCode hot reload drives freshness now; Veslo no longer listens for
    // legacy reload-required events.
  });

  const {
    engine,
    engineDoctorResult,
    engineDoctorCheckedAt,
    engineInstallLogs,
    projectDir: workspaceProjectDir,
    newAuthorizedDir,
    refreshEngineDoctor,
    stopHost,
    setEngineInstallLogs,
  } = workspaceStore;

  const scheduledAutomationStore = createScheduledAutomationStore({
    workspaces: () => workspaceStore.workspaces(),
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId().trim(),
    activeWorkspaceType: () => workspaceStore.activeWorkspaceDisplay().workspaceType,
    vesloServerClient,
    vesloServerStatus,
    startupPreference,
    isTauriRuntime,
    ensureLocalVesloServerRunning,
    vesloServerInfo,
    setVesloServerHostInfoStable: (info) => setVesloServerHostInfoStable(info as VesloServerInfo | null),
    checkVesloServer,
    setVesloServerStatus,
    setVesloServerCapabilitiesStable: (capabilities) =>
      setVesloServerCapabilitiesStable(capabilities as ReturnType<typeof vesloServerCapabilities>),
    setVesloServerCheckedAt,
    createVesloServerClient,
    reportError,
  });

  const soulDataStore = createSoulDataStore({
    vesloServerClient,
    vesloServerStatus,
    workspaces: () => workspaceStore.workspaces(),
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    soulAuthContext: skillRegistryMaterializationAuthContext,
    authRevision: denAuthRevision,
    createSessionAndOpen,
    sendPrompt,
    setPrompt,
    createClientMessageId: createSessionClientMessageId,
    reportError,
  });

  const activeAuthorizedDirs = createMemo(() => workspaceStore.authorizedDirs());
  const activeWorkspaceDisplay = createMemo(() => workspaceStore.activeWorkspaceDisplay());
  const activePermissionMemo = createMemo(() => activePermission());
  const migrationRepairUnavailableReason = createMemo<string | null>(() => {
    if (workspaceStore.canRepairOpencodeMigration()) return null;
    if (!isTauriRuntime()) {
      return t("app.migration.desktop_required", currentLocale());
    }

    if (activeWorkspaceDisplay().workspaceType !== "local") {
      return t("app.migration.local_only", currentLocale());
    }

    if (!workspaceStore.activeWorkspacePath().trim()) {
      return t("app.migration.workspace_required", currentLocale());
    }

    return t("app.migration.local_only", currentLocale());
  });

  const [expandedStepIds, setExpandedStepIds] = createSignal<Set<string>>(
    new Set()
  );
  const [expandedTimelineSectionIds, setExpandedTimelineSectionIds] = createSignal<Set<string>>(
    new Set()
  );
  const [expandedTimelineDetailIds, setExpandedTimelineDetailIds] = createSignal<Set<string>>(
    new Set()
  );
  const [expandedSidebarSections, setExpandedSidebarSections] = createSignal({
    progress: true,
    artifacts: true,
    context: false,
    plugins: false,
    mcp: false,
    skills: true,
    authorizedFolders: false,
  });
  const [autoConnectAttempted, setAutoConnectAttempted] = createSignal(false);

  const [appVersion, setAppVersion] = createSignal<string | null>(null);
  const [launchUpdateCheckTriggered, setLaunchUpdateCheckTriggered] = createSignal(false);

  const feedbackWorkflow = createFeedbackWorkflow({
    runtimeContext: {
      view: currentView,
      pathname: () => location.pathname,
      tab,
      settingsTab,
      selectedSessionId: activeSessionId,
      activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
      vesloServerWorkspaceId: resolvedDevtoolsWorkspaceId,
      activeWorkspaceType: () => activeWorkspaceDisplay().workspaceType,
      activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
      selectedSessionDirectory: () => resolveSessionDirectory(selectedSession() ?? { id: "", directory: "" }),
      locale: currentLocale,
      appVersion,
      resolveSessionWorkspaceRoot: preferredSessionWorkspaceRoot,
    },
    reportError,
    stringifyError: safeStringify,
  });

  const busySeconds = createMemo(() => {
    const start = busyStartedAt();
    if (!start) return 0;
    return Math.max(0, Math.round((Date.now() - start) / 1000));
  });

  const newTaskDisabled = createMemo(() => {
    if (!routedClient()) {
      return true;
    }

    const label = busyLabel();
    // Allow creating a new session even while a run is in progress.
    if (busy() && label === "status.running") return false;

    // Otherwise, block during engine / connection transitions.
    if (
      busy() &&
      (label === "status.connecting" ||
        label === "status.starting_engine" ||
        label === "status.disconnecting")
    ) {
      return true;
    }

    return busy();
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;

    const disabled = newTaskDisabled();
    if (!disabled) {
      lastNewSessionDisabledDiagnosticKey = "";
      return;
    }

    const label = busyLabel();
    const runtimeConnecting =
      busy() &&
      (label === "status.connecting" ||
        label === "status.starting_engine" ||
        label === "status.disconnecting");
    const hasRuntimeClient = Boolean(routedClient());
    const activeWorkspaceRoot = workspaceStore.activeWorkspaceRoot().trim();
    const classifiedReason = classifyNewSessionDisabledReason({
      runtimeConnecting,
      runtimeUnreachable: !hasRuntimeClient && !runtimeConnecting,
      hasRuntimeClient,
      hasWorkspaceRoot: Boolean(activeWorkspaceRoot),
      hasQuickChatHandler: Boolean(pendingSessionDraftController.openNewSessionWithDirectory),
    });
    const reason = classifiedReason === "available" ? "unknown" : classifiedReason;
    const payload = {
      reason,
      busy: busy(),
      busyLabel: label,
      vesloServerStatus: vesloServerStatus(),
      hasRuntimeClient,
      hasWorkspaceRoot: Boolean(activeWorkspaceRoot),
      activeWorkspaceId: workspaceStore.activeWorkspaceId().trim() || null,
      connectingWorkspaceId: workspaceStore.connectingWorkspaceId()?.trim() || null,
    };
    const nextKey = JSON.stringify(payload);
    if (nextKey === lastNewSessionDisabledDiagnosticKey) return;
    lastNewSessionDisabledDiagnosticKey = nextKey;
    void recordBootstrapDiagnostic("new-session:disabled", payload);
  });

  createEffect(() => {
    if (isTauriRuntime()) return;
    if (autoConnectAttempted()) return;
    if (routedClient()) return;
    if (vesloServerStatus() !== "connected") return;

    const settings = vesloServerSettings();
    if (!settings.urlOverride || !settings.token) return;

    setAutoConnectAttempted(true);
    void workspaceStore.onConnectClient();
  });

  const selectedSessionModel = createMemo<ModelRef>(() => {
    const id = selectedSessionId();
    return modelForSession(id);
  });

  const selectedSessionAgent = createMemo(() => {
    const id = selectedSessionId();
    return agentForSession(id);
  });

  function modelForSession(sessionId: string | null | undefined): ModelRef {
    const globalDefault = resolveGlobalRuntimeModel(defaultModel());
    const managedModel = managedAiAccessModel();
    if (managedModel) return managedModel;

    const id = sessionId?.trim() ?? "";
    if (!id) return globalDefault;

    const override = sessionModelOverrideById()[id];
    if (override) return override;

    const known = sessionModelById()[id];
    if (known) return known;

    if (id === selectedSessionId()) {
      const fromMessages = lastUserModelFromMessages(messages());
      if (fromMessages) return fromMessages;
    }

    return globalDefault;
  }

  function agentForSession(sessionId: string | null | undefined) {
    const id = sessionId?.trim() ?? "";
    if (!id) return null;
    return sessionAgentById()[id] ?? null;
  }

  const sessionCreationWorkflow = createSessionCreationWorkflow({
    activeSendTraceId,
    addOpencodeCacheHint,
    applyPendingInitialSessionTitle,
    baseUrl,
    currentView,
    developerMode,
    ensureLocalRuntimeReachableForSend,
    ensureManagedAiBootstrapReady,
    goToSession,
    isWorkspaceClientStaleError,
    managedAiBootstrapBusy,
    materializePendingSessionInWorkspaceSidebar,
    perfNow,
    recordPerfLog,
    finishPerf,
    recordSendTrace,
    registerPendingInitialSessionTitle,
    reloadBusy: () => reloadBusy(),
    rememberConversationScope,
    resolveRuntimeSandboxStateForTarget,
    resolveSendTargetWorkspaceScope,
    resolveWorkspaceRootForConversationScope,
    routedClient: (workspaceId) => routedClient(workspaceId ?? undefined),
    routedClientForSendTarget: (target) => routedClientForSendTarget(target as SendTargetWorkspaceScope | null),
    safeStringify,
    selectSession,
    sendTraceStep,
    sessionRouteSync,
    sessions,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setCreatingSession,
    setError,
    setSessions,
    unknownErrorMessage: () => t("app.unknown_error", currentLocale()),
    workspace: {
      activeWorkspaceDisplay: () => workspaceStore.activeWorkspaceDisplay(),
      activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
      activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
      connectingWorkspaceId: () => workspaceStore.connectingWorkspaceId(),
    },
    wsDebug,
    abortRefreshes,
    createConversationFromVesloWriteApi: (workspaceId, directory, title, preflight) =>
      createConversationFromVesloWriteApi(
        workspaceId,
        directory,
        title,
        preflight as Parameters<typeof createConversationFromVesloWriteApi>[3],
      ),
  });

  async function createSessionAndOpen(
    initialTitle = "",
    options: SessionCreationWorkflowCreateOptions = {},
  ) {
    return sessionCreationWorkflow.createSessionAndOpen(initialTitle, options);
  }
  const chooseFolderForCurrentSession = async () => {
    if (!isTauriRuntime()) return false;

    const sessionID = (selectedSessionId() ?? "").trim();
    if (!sessionID) {
      throw new Error("No session selected");
    }

    const activeRoot = workspaceStore.activeWorkspaceRoot().trim();
    const sessionRecord = sessions().find((session) => session.id === sessionID) ?? null;
    const sourceRoot = preferredSessionWorkspaceRoot(
      sessionRecord ? resolveSessionDirectory(sessionRecord) : "",
      activeRoot,
    );
    const normalizedSourceRoot = normalizeDirectoryPath(sourceRoot);
    const sourceWorkspaceMatch = normalizedSourceRoot
      ? workspaceStore.workspaces().find(
          (workspace) =>
            workspace.workspaceType === "local" &&
            normalizeDirectoryPath(workspace.path?.trim() ?? "") === normalizedSourceRoot,
        ) ?? null
      : null;
    const sourceWorkspace = sourceWorkspaceMatch ?? workspaceStore.activeWorkspaceDisplay();
    const sourceWorkspaceId = sourceWorkspace.id?.trim() || workspaceStore.activeWorkspaceId().trim();

    if (sourceWorkspace.workspaceType !== "local" || !workspaceStore.isPrivateWorkspacePath(sourceRoot)) {
      throw new Error("Choose folder is only available for private workspaces.");
    }
    if (!sourceRoot) {
      throw new Error("Private workspace folder is unavailable.");
    }

    while (true) {
      const selectedDirectory = await workspaceStore.pickWorkspaceFolder();
      if (!selectedDirectory) return false;

      let transfer = await workspaceCopyIntoFolder({
        sourcePath: sourceRoot,
        targetPath: selectedDirectory,
        overwrite: false,
      });

      if (transfer.kind === "conflict") {
        const preview = transfer.conflicts.slice(0, 6);
        const suffix =
          transfer.conflicts.length > preview.length
            ? `\n…and ${transfer.conflicts.length - preview.length} more.`
            : "";
        const overwrite = window.confirm(
          `This folder already has conflicting files:\n\n${preview.join("\n")}${suffix}\n\nReplace conflicting files?`,
        );
        if (!overwrite) {
          const chooseAnother = window.confirm(
            "Choose another folder? Click Cancel to keep using the private workspace.",
          );
          if (chooseAnother) continue;
          return false;
        }

        transfer = await workspaceCopyIntoFolder({
          sourcePath: sourceRoot,
          targetPath: selectedDirectory,
          overwrite: true,
        });
      }

      if (transfer.kind !== "ok") {
        return false;
      }

      // Fix stale authorizedRoots copied from the private workspace.
      // The copied veslo.json still points to the old private-workspaces path;
      // replace it with the actual target directory before the engine starts.
      try {
        const copiedConfig = await workspaceVesloRead({ workspacePath: selectedDirectory });
        if (copiedConfig) {
          const oldRoots = Array.isArray(copiedConfig.authorizedRoots) ? copiedConfig.authorizedRoots : [];
          const fixedRoots = oldRoots
            .map((r) => (r === sourceRoot ? selectedDirectory : r))
            .filter((r, i, arr) => arr.indexOf(r) === i);
          if (!fixedRoots.includes(selectedDirectory)) fixedRoots.push(selectedDirectory);
          await workspaceVesloWrite({
            workspacePath: selectedDirectory,
            config: { ...copiedConfig, authorizedRoots: fixedRoots },
          });
        }
      } catch {
        // veslo.json may not exist yet — ensureWorkspaceForFolder will create it
      }

      // Snapshot the session BEFORE activating the target workspace.
      // ensureLocalWorkspaceActive → connectToServer → loadSessions scopes
      // to the target directory and won't include this session (it was
      // created in the temp workspace). Without the snapshot, the session
      // data would be lost after activation.
      const sessionSnapshot = sessions().find((s) => s.id === sessionID) ?? null;

      // Update session directory in the OpenCode SQLite database BEFORE
      // activating the new workspace.  ensureLocalWorkspaceActive restarts the
      // engine, so the restarted engine will read the corrected directory from
      // the DB and won't generate stale external_directory permission prompts.
      if (isTauriRuntime()) {
        try {
          const dbUpdate = await opencodeDbUpdateSessionDirectory({
            sessionId: sessionID,
            oldDirectory: sourceRoot,
            directory: selectedDirectory,
          });
          if (!dbUpdate.ok) {
            throw new Error(dbUpdate.stderr || "Failed to update OpenCode session directory.");
          }
        } catch (error) {
          reportError(error, "workspace.move.updateSessionDirectory");
          // Non-fatal: the session will still work, just with a permission prompt.
        }
      }

      const targetWorkspace = await workspaceStore.ensureWorkspaceForFolder(selectedDirectory);
      if (!targetWorkspace?.id) return false;
      const ready = await workspaceStore.ensureLocalWorkspaceActive(targetWorkspace.id);
      if (!ready) return false;

      persistSessionDirectoryOverride(sessionID, targetWorkspace.path);

      // Ensure the session is in sessions() with the correct directory so
      // the route effect (which validates session existence) doesn't
      // redirect away when goToSession changes the URL.
      const currentSessions = sessions();
      const existingIdx = currentSessions.findIndex((s) => s.id === sessionID);
      if (existingIdx >= 0) {
        const copy = [...currentSessions];
        copy[existingIdx] = { ...copy[existingIdx], directory: targetWorkspace.path };
        setSessions(copy);
      } else if (sessionSnapshot) {
        setSessions([{ ...sessionSnapshot, directory: targetWorkspace.path }, ...currentSessions]);
      }

      moveWorkspaceLastSession({
        sourceWorkspaceId,
        targetWorkspaceId: targetWorkspace.id,
        sessionId: sessionID,
      });

      // Optimistically move the session in the sidebar so the user sees
      // immediate feedback. Uses the snapshot captured before activation.
      moveSessionBetweenWorkspaceSidebars({
        sourceWorkspaceId,
        targetWorkspaceId: targetWorkspace.id,
        item: {
          id: sessionID,
          title: sessionSnapshot?.title ?? "",
          slug: sessionSnapshot?.slug,
          parentID: sessionSnapshot?.parentID ?? null,
          time: sessionSnapshot?.time,
          directory: targetWorkspace.path,
        },
      });

      // Navigate and load messages before forgetWorkspace (which may
      // trigger disruptive reactive effects).
      // Yield a microtask so the reactive session/client state from
      // ensureLocalWorkspaceActive has settled before selecting.
      await Promise.resolve();
      goToSession(sessionID, { replace: true });
      // Yield again so the route effect (triggered by goToSession) runs
      // first — then our explicit selectSession call won't be deduped
      // against a stale in-flight load.
      await new Promise((r) => setTimeout(r, 100));
      await selectSession(sessionID);

      // Refresh sidebar from API, then clean up the old private workspace.
      await refreshSidebarWorkspaceSessions(targetWorkspace.id).catch((e) =>
        reportError(e, "sidebar.refreshSessions"),
      );

      if (sourceWorkspaceId && sourceWorkspaceId !== targetWorkspace.id) {
        await workspaceStore.forgetWorkspace(sourceWorkspaceId, { deleteLocalData: true });
      }

      // forgetWorkspace → setWorkspaces() triggers a reactive sidebar
      // refresh (fire-and-forget). That refresh uses the directory override
      // to find the session, so it should include it. As a safety net,
      // re-ensure the session appears in case the async refresh hasn't
      // completed or failed to find it.
      ensureSessionInWorkspaceSidebar(targetWorkspace.id, {
          id: sessionID,
          title: sessionSnapshot?.title ?? "",
          slug: sessionSnapshot?.slug,
          parentID: sessionSnapshot?.parentID ?? null,
          time: sessionSnapshot?.time,
          directory: targetWorkspace.path,
      });

      return true;
    }
  };

  createAppStartupHydration({
    cloudOnlyMode: () => CLOUD_ONLY_MODE,
    isTauriRuntime,
    isWindowsPlatform,
    isMacPlatform,
    booting,
    setBooting,
    setStartupPreference,
    setRememberStartupChoice,
    setVesloServerSettings,
    pendingSessionDraftController,
    themeMode,
    hydrateSubagentDecorations: sessionSidebarDecorations.hydrate,
    markSubagentDecorationsReady: sessionSidebarDecorations.markReady,
    baseUrl,
    setBaseUrl,
    clientDirectory,
    setClientDirectory,
    workspaceProjectDir,
    engineSource,
    engineSourceExplicit,
    updateEngineSource,
    engineCustomBinPath,
    setEngineCustomBinPath,
    engineRuntime,
    setEngineRuntime,
    defaultModel,
    setDefaultModel,
    setLegacyDefaultModel,
    showThinking,
    setShowThinking,
    maxEngines,
    setMaxEngines,
    idleSuspendMs,
    setIdleSuspendMs,
    hideTitlebar,
    setHideTitlebar,
    autoCompactContext,
    modelVariant,
    setModelVariant,
    modelVariantPreferenceReady,
    setModelVariantPreferenceReady,
    updatePreferencesReady,
    setUpdatePreferencesReady,
    updateAutoCheck,
    setUpdateAutoCheck,
    updateAutoDownload,
    setUpdateAutoDownload,
    updateStatus,
    setUpdateStatus,
    setUpdateEnv,
    launchUpdateCheckTriggered,
    setLaunchUpdateCheckTriggered,
    setAppVersion,
    checkForUpdates,
    refreshMcpServers,
    setNotionStatus,
    setNotionStatusDetail,
    setNotionSkillInstalled,
    formatMcpConnectingLabel: () => t("mcp.connecting", currentLocale()),
    consumeDesktopDeepLinkUrls: appDeepLinkWorkflow.consumeDesktopDeepLinkUrls,
    consumeWebDeepLinkUrl: appDeepLinkWorkflow.consumeWebDeepLinkUrl,
    onboardingStep,
    setOnboardingStep,
    routedClient,
    workspaceStore,
    reportError,
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    if (!workspaceId) return;
    setSessionModelOverrideById({});
  });

  createMcpAutoRefreshScheduler({
    isTauriRuntime,
    activeWorkspaceRuntimeReady,
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    activeSendTraceId: activeVisibleRuntimeActivityId,
    workspaceProjectDir: () => workspaceProjectDir(),
    refreshMcpServers,
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    if (!workspaceId) return;

    setWorkspaceDefaultModelReady(false);
    const activeWorkspace = workspaceStore.activeWorkspaceDisplay();
    const workspaceType = activeWorkspace.workspaceType;
    const workspaceRoot = workspaceStore.activeWorkspacePath().trim();
    const activeClient = routedClient();
    const vesloClient = vesloServerClient();
    const vesloWorkspaceId = resolveConversationServerWorkspaceId(workspaceId);
    const vesloCapabilities = resolvedVesloCapabilities();
    const canUseVesloServer =
      vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.config?.read;

    let cancelled = false;

    const applyDefault = async () => {
      const adminManagedModel = managedAiAccessModel();
      if (adminManagedModel) {
        setDefaultModelExplicit(true);
        const currentDefault = untrack(defaultModel);
        if (!modelEquals(currentDefault, adminManagedModel)) {
          setDefaultModel(adminManagedModel);
        }
        if (!cancelled) {
          setWorkspaceDefaultModelReady(true);
        }
        return;
      }

      let configDefault: ModelRef | null = null;
      let configFileContent: string | null = null;

      if (workspaceType === "local" && workspaceRoot) {
        if (canUseVesloServer) {
          try {
            const config = await vesloClient.getConfig(vesloWorkspaceId);
            const model = typeof config.opencode?.model === "string" ? config.opencode.model : null;
            configDefault = parseModelRef(model);
          } catch {
            // ignore
          }
        } else if (isTauriRuntime()) {
          try {
            const configFile = await readOpencodeConfig("project", workspaceRoot);
            configFileContent = configFile.content;
            configDefault = parseDefaultModelFromConfig(configFile.content);
          } catch {
            // ignore
          }
        }
      } else if (activeClient) {
        try {
          const config = unwrap(
            await activeClient.config.get({ directory: workspaceRoot || undefined })
          );
          if (typeof config.model === "string") {
            configDefault = parseModelRef(config.model);
          }
        } catch {
          // ignore
        }
      }

      setDefaultModelExplicit(Boolean(configDefault));
      const currentDefault = untrack(defaultModel);
      const nextDefault = resolveWorkspaceDefaultModel({
        configDefault,
        currentDefault,
        legacyDefault: legacyDefaultModel(),
      });
      if (!modelEquals(currentDefault, nextDefault)) {
        setDefaultModel(nextDefault);
      }

      if (workspaceType === "local" && workspaceRoot) {
        managedAiRuntimeConfig.rememberKnownConfigSnapshot(workspaceRoot, configFileContent);
      }

      if (!cancelled) {
        setWorkspaceDefaultModelReady(true);
      }
    };

    void applyDefault();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (onboardingStep() !== "local") return;
    void workspaceStore.refreshEngineDoctor();
  });

  createEffect(() => {
    if (booting()) return;
    if (!isTauriRuntime()) return;
    if (launchUpdateCheckTriggered()) return;
    if (!updateAutoCheck()) return;

    const env = updateEnv();
    if (!env) return;
    if (!env.supported) return;

    const state = updateStatus();
    if (state.state === "checking" || state.state === "downloading" || state.state === "installing") return;

    setLaunchUpdateCheckTriggered(true);
    checkForUpdates({ quiet: true }).catch(e => reportError(e, "updates.check"));
  });

  createEffect(() => {
    if (booting()) return;
    if (typeof window === "undefined") return;
    if (!isTauriRuntime()) return;
    if (!launchUpdateCheckTriggered()) return;
    if (!updateAutoCheck()) return;

    const maybeRunAutoUpdateCheck = () => {
      if (!updateAutoCheck()) return;
      const state = updateStatus();
      if (state.state === "checking" || state.state === "downloading" || state.state === "installing") return;
      if (!shouldAutoCheckForUpdatesAt(state)) return;
      checkForUpdates({ quiet: true }).catch(e => reportError(e, "updates.check"));
    };

    const interval = window.setInterval(maybeRunAutoUpdateCheck, UPDATE_AUTO_CHECK_POLL_MS);
    onCleanup(() => window.clearInterval(interval));
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!updateAutoDownload()) return;

    const state = updateStatus();
    if (state.state !== "available") return;
    if (!pendingUpdate()) return;

    downloadUpdate({ automatic: true }).catch(e => reportError(e, "updates.download"));
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!updateAutoDownload()) return;

    const state = updateStatus();
    if (state.state !== "downloading") return;
    if (state.retry?.kind !== "scheduled") return;

    const delayMs = Math.max(0, state.retry.nextRetryAt - Date.now());
    const timeout = window.setTimeout(() => {
      if (state.retry?.kind !== "scheduled") return;
      downloadUpdate({
        automatic: true,
        retryAttempt: state.retry.retryAttempt,
        refreshBeforeDownload: true,
      }).catch(e => reportError(e, "updates.download.retry"));
    }, delayMs);

    onCleanup(() => window.clearTimeout(timeout));
  });

  const headerConnectedVersion = createMemo(() => {
    const fallbackVersion = connectedVersion()?.trim() ?? "";
    if (!developerMode()) {
      return fallbackVersion || null;
    }

    const vesloVersion =
      appVersion()?.trim() ||
      vesloServerDiagnostics()?.version?.trim() ||
      "";
    if (!vesloVersion) {
      return fallbackVersion || null;
    }

    const normalizedVersion = vesloVersion.startsWith("v")
      ? vesloVersion
      : `v${vesloVersion}`;
    return `Veslo ${normalizedVersion}`;
  });

  const headerStatus = createMemo(() => {
    if (!routedClient() || !headerConnectedVersion()) return t("status.disconnected", currentLocale());
    const bits = [`${t("status.connected", currentLocale())} · ${headerConnectedVersion()}`];
    if (sseConnected()) bits.push(t("status.live", currentLocale()));
    return bits.join(" · ");
  });

  const busyHint = createMemo(() => {
    if (!busy() || !busyLabel()) return null;
    const seconds = busySeconds();
    const label = t(busyLabel()!, currentLocale());
    return seconds > 0 ? `${label} · ${seconds}s` : label;
  });

  const {
    workspaceSwitchWorkspace,
    workspaceSwitchOpen,
    workspaceSwitchStatusKey,
  } = createWorkspaceSwitchOverlayState({
    booting,
    blockingWorkspaceId: () => workspaceStore.workspaceSwitchOverlayWorkspaceId(),
    activeWorkspaceDisplay,
    workspaces: () => workspaceStore.workspaces(),
    busy,
    busyLabel,
  });

  const localHostLabel = createMemo(() => {
    const info = engine();
    if (info?.hostname && info?.port) {
      return `${info.hostname}:${info.port}`;
    }

    try {
      return new URL(baseUrl()).host;
    } catch {
      return "localhost:4096";
    }
  });

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
  });

  const dashboardProps = () => {
    const workspaceType = activeWorkspaceDisplay().workspaceType;
    const isRemoteWorkspace = workspaceType === "remote";
    const vesloStatus = vesloServerStatus();
    const canUseDesktopTools = isTauriRuntime() && !isRemoteWorkspace;
    const canInstallSkillCreator = isRemoteWorkspace
      ? vesloServerCanWriteSkills()
      : isTauriRuntime();
    const canEditPlugins = isRemoteWorkspace
      ? vesloServerCanWritePlugins()
      : isTauriRuntime();
    const canUseGlobalPluginScope = !isRemoteWorkspace && isTauriRuntime();
    const skillsAccessHint = isRemoteWorkspace
      ? vesloStatus === "disconnected"
        ? "Veslo server unavailable. Add the server URL/token in Advanced to manage skills."
        : vesloStatus === "limited"
          ? "Veslo server needs a host token to install/update skills. Add it in Advanced and reconnect."
          : vesloServerCanWriteSkills()
            ? null
            : "Veslo server is read-only for skills. Add a host token in Advanced to enable installs."
      : null;
    const pluginsAccessHint = isRemoteWorkspace
      ? vesloStatus === "disconnected"
        ? "Veslo server unavailable. Plugins are read-only."
        : vesloStatus === "limited"
          ? "Veslo server needs a token to edit plugins."
          : vesloServerCanWritePlugins()
            ? null
            : "Veslo server is read-only for plugins."
      : null;

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
      vesloServerUrl: vesloServerUrl(),
      vesloServerClient: hydratedVesloServerClient(),
      vesloReconnectBusy: vesloReconnectBusy(),
      reconnectVesloServer,
      vesloServerSettings: vesloServerSettings(),
      vesloServerHostInfo: vesloServerHostInfo(),
      vesloServerCapabilities: devtoolsCapabilities(),
      vesloServerDiagnostics: vesloServerDiagnostics(),
      vesloServerWorkspaceId: resolvedDevtoolsWorkspaceId(),
      vesloAuditEntries: vesloAuditEntries(),
      vesloAuditStatus: vesloAuditStatus(),
      vesloAuditError: vesloAuditError(),
      opencodeConnectStatus: opencodeConnectStatus(),
      engineInfo: workspaceStore.engine(),
      orchestratorStatus: orchestratorStatusState(),
      opencodeRouterInfo: opencodeRouterInfoState(),
      engineDoctorVersion: workspaceStore.engineDoctorResult()?.version ?? null,
      updateVesloServerSettings,
      resetVesloServerSettings,
      testVesloServerConnection,
      canReloadWorkspace: canReloadWorkspace(),
      reloadWorkspaceEngine: reloadWorkspaceEngineAndResume,
      reloadScheduledAutomationsSource: scheduledAutomationStore.reloadScheduledJobsSource,
      reloadBusy: reloadBusy(),
      reloadError: reloadError(),
      workspaceAutoReloadAvailable: workspaceAutoReloadAvailable(),
      workspaceAutoReloadEnabled: workspaceAutoReloadEnabled(),
      setWorkspaceAutoReloadEnabled,
      workspaceAutoReloadResumeEnabled: workspaceAutoReloadResumeEnabled(),
      setWorkspaceAutoReloadResumeEnabled,
      activeWorkspaceDisplay: activeWorkspaceDisplay(),
      workspaces: workspaceStore.workspaces(),
      activeWorkspaceId: workspaceStore.activeWorkspaceId(),
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
      createWorkspaceOpen: workspaceStore.createWorkspaceOpen(),
      setCreateWorkspaceOpen: workspaceStore.setCreateWorkspaceOpen,
      createWorkspaceFlow: workspaceStore.createWorkspaceFlow,
      pickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
      workspaceSessionGroups: sidebarWorkspaceGroups(),
      unreadSessionIds: unreadSessionIds(),
      workspaceSessionPagingById: workspaceSessionPagingById(),
      subagentDecorationsBySessionId: subagentDecorationsBySessionId(),
      archivedSessionIds: archivedSessionIds(),
      sessionStatusById: activeSessionStatusById(),
      busySessionByWorkspaceId: busySessionByWorkspaceId(),
      archiveSession: (workspaceId: string, sessionId: string) =>
        archiveSidebarSession(workspaceId, sessionId).catch((error) => {
          reportError(error, "sessionArchives.archiveSidebar");
          setError(error instanceof Error ? error.message : safeStringify(error));
        }),
      unarchiveSession: (workspaceId: string, sessionId: string) =>
        unarchiveSession(workspaceId, sessionId).catch((error) => {
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
        scheduledAutomationStore.refreshScheduledJobs(options).catch(e => reportError(e, "scheduled.refresh")),
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
      soulStatusByWorkspaceId: soulDataStore.soulStatusByWorkspaceId(),
      activeSoulStatus: soulDataStore.activeSoulStatus(),
      activeSoulHeartbeats: soulDataStore.activeSoulHeartbeats(),
      soulStatusBusy: soulDataStore.soulStatusBusy(),
      soulHeartbeatsBusy: soulDataStore.soulHeartbeatsBusy(),
      soulError: soulDataStore.soulError(),
      refreshSoulData: (options?: { force?: boolean }) => soulDataStore.refreshSoulData(options).catch(e => reportError(e, "soul.refresh")),
      runSoulPrompt: soulDataStore.runSoulPrompt,
      activeWorkspaceRoot: workspaceStore.activeWorkspaceRoot().trim(),
      isRemoteWorkspace: workspaceStore.activeWorkspaceDisplay().workspaceType === "remote",
      refreshSkills: (options?: { force?: boolean }) => refreshSkills(options).catch(e => reportError(e, "skills.refresh")),
      refreshSkillInventory: (options?: { force?: boolean }) =>
        refreshSkillInventory(options).catch(e => reportError(e, "skills.refreshInventory")),
      refreshHubSkills: (options?: { force?: boolean }) => refreshHubSkills(options).catch(e => reportError(e, "skills.refreshHub")),
      refreshPlugins: (scopeOverride?: PluginScope) =>
        refreshPlugins(scopeOverride).catch(e => reportError(e, "plugins.refresh")),
      skills: skills(),
      skillsStatus: skillsStatus(),
      skillInventory: skillInventory(),
      skillInventoryStatus: skillInventoryStatus(),
      hubSkills: hubSkills(),
      hubSkillsStatus: hubSkillsStatus(),
      skillsAccessHint,
      canInstallSkillCreator,
      canUseDesktopTools,
      importLocalSkill,
      installSkillCreator,
      installHubSkill,
      revealSkillsFolder,
      uninstallSkill,
      readSkill,
      saveSkill,
      readSkillInstance,
      saveSkillInstance,
      setSkillInstanceEnabled,
      deleteSkillInstance,
      removeSkillInstance,
      batchRemoveSkillInstances,
      restoreSkillInstance,
      copySkillInstanceToGlobal,
      copySkillInstanceToWorkspace,
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
      aiAccessDefaultModelLabel: managedAiAccessDefaultModelLabel(),
      aiAccessAllowedModels: managedAiAccess()?.allowedModels ?? [],
      showThinking: showThinking(),
      toggleShowThinking: () => setShowThinking((v) => !v),
      hideTitlebar: hideTitlebar(),
      toggleHideTitlebar: () => setHideTitlebar((v) => !v),
      maxEngines: maxEngines(),
      setMaxEngines: (n: number) => setMaxEngines(Math.max(1, Math.min(64, Math.floor(n)))),
      idleSuspendMs: idleSuspendMs(),
      setIdleSuspendMs: (ms: number) => setIdleSuspendMs(Math.max(0, Math.floor(ms))),
      modelVariantLabel: formatModelVariantLabel(modelVariant()),
      modelVariant: normalizeModelVariant(modelVariant()) ?? "none",
      setModelVariant: (value: string) => setModelVariant(value),
      updateAutoDownload: updateAutoDownload(),
      toggleUpdateAutoDownload: () =>
        setUpdateAutoDownload((v) => {
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
      onUnarchiveArchivedSession: (workspaceId: string, sessionId: string, workspaceIdentity?: string | null) =>
        unarchiveSession(workspaceId, sessionId, workspaceIdentity).catch((error) => {
          reportError(error, "sessionArchives.unarchiveSettings");
          setError(error instanceof Error ? error.message : safeStringify(error));
        }),
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
      refreshHubMcp: () => refreshHubMcp().catch(e => reportError(e, "skills.refreshHubMcp")),
      installHubMcp: (name: string) => installHubMcpAndActivate(name).catch(e => {
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
      reloadMcpEngine: () => reloadWorkspaceEngineAndResume(),
      language: currentLocale(),
      setLanguage: setLocale,
    };
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
      return result;
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
    showSkillReloadBanner: reloadRequired() && reloadTrigger()?.type === "skill",
    reloadBannerTitle: reloadCopy().title,
    reloadBannerBody: reloadCopy().body,
    reloadBannerBlocked: activeReloadBlockingSessions().length > 0,
    reloadBannerActiveCount: activeReloadBlockingSessions().length,
    canReloadWorkspace: canReloadWorkspace(),
    reloadWorkspaceEngine: reloadWorkspaceEngineAndResume,
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
    compactSession: compactCurrentSession,
    lastPromptSent: lastPromptSent(),
    retryLastPrompt: retryLastPrompt,
    newTaskDisabled: newTaskDisabled(),
    pendingPermissionCountByWs: sessionStore.pendingPermissionCountByWs(),
    workspaceSessionGroups: sidebarWorkspaceGroups(),
    unreadSessionIds: unreadSessionIds(),
    workspaceSessionPagingById: workspaceSessionPagingById(),
    subagentDecorationsBySessionId: subagentDecorationsBySessionId(),
    archivedSessionIds: archivedSessionIds(),
    archiveSession: (workspaceId: string, sessionId: string) =>
      archiveSidebarSession(workspaceId, sessionId).catch((error) => {
        reportError(error, "sessionArchives.archiveSidebar");
        setError(error instanceof Error ? error.message : safeStringify(error));
      }),
    unarchiveSession: (workspaceId: string, sessionId: string) =>
      unarchiveSession(workspaceId, sessionId).catch((error) => {
        reportError(error, "sessionArchives.unarchiveSidebar");
        setError(error instanceof Error ? error.message : safeStringify(error));
      }),
    loadMoreWorkspaceSidebarSessions,
    isPrivateWorkspacePath: workspaceStore.isPrivateWorkspacePath,
    soulStatusByWorkspaceId: soulDataStore.soulStatusByWorkspaceId(),
    openRenameWorkspace,
    selectSession: selectSession,
    selectedSessionTitle: selectedSessionDisplayTitle(),
    messages: visibleMessages(),
    todos: activeTodos(),
    busyLabel: busyLabel(),
    developerMode: developerMode(),
    showThinking: showThinking(),
    autoCompactContext: autoCompactContext(),
    toggleAutoCompactContext: () => setAutoCompactContext(true),
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
    clearReconnectNotice: () => setSessionReconnectNotice(null),
    composerDraft: composerDraft(),
    setComposerDraft: setComposerDraft,
    activePermission: activePermissionMemo(),
    permissionReplyBusy: permissionReplyBusy(),
    respondPermission: respondPermission,
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
    busySessionByWorkspaceId: busySessionByWorkspaceId(),
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
  });

  appRouteSync.startHashRouteSync();

  appRouteSync.startStartupRouteSync({
    onboardingStep,
    activeSessionId,
    onSessionRoute: sessionRouteSync.handleSessionRoute,
  });

  return (
    <WorkspaceRoutingProvider value={runtimeOwnedRouting}>
      <WorkspaceServerSync
        workspaceStore={workspaceStore}
        orchestratorPort={() => orchestratorStatusState()?.daemon?.port ?? null}
      />
      <Switch>
        <Match when={currentView() === "proto"}>
          <Switch>
            <Match when={isProtoV1Ux()}>
              <ProtoV1UxView />
            </Match>
            <Match when={true}>
              <ProtoWorkspacesView />
            </Match>
          </Switch>
        </Match>
        <Match when={currentView() === "onboarding"}>
          <OnboardingView {...onboardingProps()} />
        </Match>
        <Match when={currentView() === "session"}>
          <SessionView {...sessionProps()} onOpenFeedback={feedbackWorkflow.openFeedbackModal} />
        </Match>
        <Match when={true}>
          <DashboardView {...dashboardProps()} onOpenFeedback={feedbackWorkflow.openFeedbackModal} />
        </Match>
      </Switch>

      <DesktopContextMenu />

      <WorkspaceSwitchOverlay
        open={workspaceSwitchOpen()}
        workspace={workspaceSwitchWorkspace()}
        statusKey={workspaceSwitchStatusKey()}
      />

      <FeedbackModal
        open={feedbackWorkflow.feedbackModalOpen()}
        error={feedbackWorkflow.feedbackSubmitError()}
        successIssueId={feedbackWorkflow.feedbackSubmitSuccessIssueId()}
        submitting={feedbackWorkflow.feedbackSubmitting()}
        onClose={feedbackWorkflow.closeFeedbackModal}
        onSubmit={feedbackWorkflow.submitFeedback}
      />

      <ResetModal
        open={resetModalOpen()}
        mode={resetModalMode()}
        text={resetModalText()}
        busy={resetModalBusy()}
        canReset={
          !resetModalBusy() &&
          !anyActiveRuns() &&
          resetModalText().trim().toUpperCase() === "RESET"
        }
        hasActiveRuns={anyActiveRuns()}
        language={currentLocale()}
        onClose={() => setResetModalOpen(false)}
        onConfirm={confirmReset}
        onTextChange={setResetModalText}
      />

      <McpAuthModal
        open={mcpAuthModalOpen()}
        client={routedClient()}
        entry={mcpAuthEntry()}
        projectDir={workspaceProjectDir()}
        language={currentLocale()}
        reloadRequired={mcpAuthNeedsReload()}
        reloadBlocked={activeReloadBlockingSessions().length > 0}
        activeSessions={activeReloadBlockingSessions()}
        isRemoteWorkspace={activeWorkspaceDisplay().workspaceType === "remote"}
        onForceStopSession={(sessionID, session) => abortSession(sessionID, session)}
        onClose={() => {
          setMcpAuthModalOpen(false);
          setMcpAuthEntry(null);
          setMcpAuthNeedsReload(false);
        }}
        onComplete={async () => {
          setMcpAuthModalOpen(false);
          setMcpAuthEntry(null);
          setMcpAuthNeedsReload(false);
          await refreshMcpServers({ mode: "explicit", reason: "mcp-auth-complete" });
        }}
        onReloadEngine={() => reloadWorkspaceEngineAndResume()}
      />

      <CreateWorkspaceModal
        open={workspaceStore.createWorkspaceOpen()}
        onClose={() => {
          workspaceStore.setCreateWorkspaceOpen(false);
        }}
        onPickFolder={workspaceStore.pickWorkspaceFolder}
        onConfirm={(preset, folder) =>
          workspaceStore.createWorkspaceFlow(preset, folder)
        }
        submitting={busy() && busyLabel() === "status.creating_workspace"}
      />

      <CreateRemoteWorkspaceModal
        open={workspaceStore.createRemoteWorkspaceOpen()}
        onClose={() => {
          workspaceStore.setCreateRemoteWorkspaceOpen(false);
          clearRemoteDefaultsWhenModalCloses();
        }}
        onConfirm={(input) => workspaceStore.createRemoteWorkspaceFlow(input)}
        initialValues={deepLinkRemoteWorkspaceDefaults() ?? undefined}
        submitting={
          busy() &&
          (busyLabel() === "status.creating_workspace" || busyLabel() === "status.connecting")
        }
      />

      <RenameWorkspaceModal
        open={renameWorkspaceOpen()}
        title={renameWorkspaceName()}
        busy={renameWorkspaceBusy()}
        canSave={renameWorkspaceName().trim().length > 0 && !renameWorkspaceBusy()}
        onClose={closeRenameWorkspace}
        onSave={saveRenameWorkspace}
        onTitleChange={setRenameWorkspaceName}
      />

      <CreateRemoteWorkspaceModal
        open={editRemoteWorkspaceOpen()}
        onClose={() => {
          setEditRemoteWorkspaceOpen(false);
          setEditRemoteWorkspaceId(null);
          setEditRemoteWorkspaceError(null);
        }}
        onConfirm={(input) => {
          const workspaceId = editRemoteWorkspaceId();
          if (!workspaceId) return;
          setEditRemoteWorkspaceError(null);
          void (async () => {
            try {
              const ok = await workspaceStore.updateRemoteWorkspaceFlow(workspaceId, input);
              if (ok) {
                setEditRemoteWorkspaceOpen(false);
                setEditRemoteWorkspaceId(null);
                setEditRemoteWorkspaceError(null);
              } else {
                setEditRemoteWorkspaceError(error() || t("config.connection_failed_check_url_token", currentLocale()));
                setError(null);
              }
            } catch (e) {
              const message = e instanceof Error ? e.message : t("config.connection_failed", currentLocale());
              setEditRemoteWorkspaceError(message);
              setError(null);
            }
          })();
        }}
        initialValues={editRemoteWorkspaceDefaults() ?? undefined}
        submitting={busy() && busyLabel() === "status.connecting"}
        error={editRemoteWorkspaceError()}
        title={t("dashboard.edit_remote_workspace_title", currentLocale())}
        subtitle={t("dashboard.edit_remote_workspace_subtitle", currentLocale())}
        confirmLabel={t("dashboard.edit_remote_workspace_confirm", currentLocale())}
      />

    </WorkspaceRoutingProvider>
  );
}
