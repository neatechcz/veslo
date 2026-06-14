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
  McpLocalConfig,
  McpRemoteConfig,
  Part,
  Session,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
} from "@opencode-ai/sdk/v2/client";

import { getVersion } from "@tauri-apps/api/app";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { parse } from "jsonc-parser";

import { reportError } from "./lib/error-reporter";
import { resolveRunningVesloServerHostInfo } from "./lib/veslo-server-host";
import {
  COMPACTION_THRESHOLD_RATIO,
  resolveCompactionThreshold,
  shouldAutoCompact,
} from "./lib/auto-compaction";
import {
  DEFAULT_UPDATE_AUTO_DOWNLOAD,
  resolveUpdateStartupPreferences,
  shouldAutoCheckForUpdatesAt,
} from "./context/updater";
import {
  parseStoredEngineSourceExplicitPreference,
  resolveStoredEngineSourcePreference,
  type EngineSourcePreference,
} from "./lib/engine-source";
import {
  clearLegacySessionModelPersistence,
  parseDefaultModelFromConfig,
  formatConfigWithDefaultModel,
  resolveWorkspaceDefaultModel,
} from "./lib/model-persistence";
import {
  DEFAULT_MODEL_VARIANT,
  MODEL_VARIANT_DEFAULT_MIGRATION_KEY,
  MODEL_VARIANT_OPTIONS,
  normalizeModelVariant,
  resolveCodexReasoningEffort,
  resolveStartupModelVariant,
} from "./lib/model-variant";
import { resolveGlobalRuntimeModel } from "./lib/global-model-runtime";
import {
  emptySubagentDecorationsPersistence,
  parseSubagentDecorationsPersistence,
  serializeSubagentDecorationsPersistence,
  type SubagentDecorationPersistentRole,
  type SubagentDecorationPersistentSession,
  type SubagentDecorationsPersistenceV1,
} from "./lib/subagent-decorations-persistence";
import {
  buildSubagentDecorationModel,
  classifySubagentRoleDeterministic,
  normalizeSubagentRoleKey,
  normalizeSubagentLocale,
  roleProfileFromRoleKey,
  SUBAGENT_DECORATION_PALETTE,
  type SubagentLocale,
} from "./lib/subagent-decoration-model";
import {
  parseSharedBundleDeepLink,
  normalizeSharedBundleImportIntent,
  stripSharedBundleQuery,
  parseRemoteConnectDeepLink,
  stripRemoteConnectQuery,
  type SharedBundleDeepLink,
  type SharedBundleImportIntent,
} from "./lib/deep-links";
import {
  type SharedBundleV1,
  fetchSharedBundle,
  buildImportPayloadFromBundle,
} from "./lib/shared-bundles";
import {
  resolveRouteResumeDecision,
  resolveSessionPathDecision,
} from "./controllers/session-route-controller";
import {
  buildCreatedSidebarSessionItem,
  resolveCreatedSessionWorkspaceId,
  shouldRouteCreatedSessionAfterSelect,
} from "./controllers/session-creation-flow";
import {
  resolveAppStartupRouteDecision,
  resolveDashboardRouteTab,
} from "./controllers/app-startup-controller";
import {
  resolveManagedAiAccessRefreshFailure,
  resolveManagedAiAccessRefreshPreflight,
  resolveManagedAiAccessRefreshSuccess,
} from "./controllers/managed-ai-runtime-controller";
import {
  resolveManagedAiConfigSyncPreflight,
  resolveManagedAiConfigWriteDecision,
} from "./controllers/managed-ai-config-sync";
import {
  resolveCreateSessionManagedAiPreflightDecision,
  resolveCreateSessionRuntimeHealthPreflightDecision,
  resolveSendPromptBusyOwnership,
} from "./controllers/send-orchestration-controller";
import { shouldFallbackFromSessionRoute } from "./lib/session-route-selection-guard";
import { partitionVesloUtilitySessions } from "./lib/veslo-utility-session";
import {
  createSessionClientMessageId,
  normalizeSessionSendCorrelation,
  type SessionSendOptionsBase,
} from "./lib/session-send-contract";
import {
  createWorkspaceSessionSelection,
} from "./context/workspace-session-selection";
import {
  createWorkspaceSendTarget,
  type SendTargetWorkspaceScope,
} from "./context/workspace-send-target";
import { createPendingSessionDraftController } from "./context/pending-session-draft-controller";
import { createComposerTargetController } from "./context/composer-target-controller";
import {
  createSendRuntimeReadiness,
  type SendRuntimePreflightContext,
} from "./context/send-runtime-readiness";
import ResetModal from "./components/reset-modal";
import ConfirmModal from "./components/confirm-modal";
import WorkspaceSwitchOverlay from "./components/workspace-switch-overlay";
import DesktopContextMenu from "./components/desktop-context-menu";
import VesloLogo from "./components/veslo-logo";
import CreateRemoteWorkspaceModal from "./components/create-remote-workspace-modal";
import CreateWorkspaceModal from "./components/create-workspace-modal";
import FeedbackModal, { type FeedbackFormValues } from "./components/feedback-modal";
import RenameWorkspaceModal from "./components/rename-workspace-modal";
import McpAuthModal from "./components/mcp-auth-modal";
import { resolveNativeWindowDecorationsVisible } from "./components/titlebar-menu-layout";
import OnboardingView from "./pages/onboarding";
import DashboardView from "./pages/dashboard";
import SessionView from "./pages/session";
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
  resolveComposerStorageKey,
} from "./lib/pending-session-drafts";
import {
  createClient,
  managedConfigContentsMatchForServerPatch,
  unwrap,
  waitForHealthy,
} from "./lib/opencode";
import {
  abortSession as abortSessionTyped,
  abortSessionSafe,
  compactSession as compactSessionTyped,
  revertSession,
  unrevertSession,
  shellInSession,
  listCommands as listCommandsTyped,
} from "./lib/opencode-session";
import { clearPerfLogs, finishPerf, perfNow, recordPerfLog } from "./lib/perf-log";
import {
  createMcpAutoRefreshScheduler,
  createPermissionPollingScheduler,
} from "./lib/workspace-runtime-schedulers";
import { createMcpServersRefresher } from "./lib/mcp-server-refresh";
import { createSkillReloadGuard } from "./lib/skill-reload-guard";
import { createSkillRegistryEventsListener } from "./lib/skill-registry-events";
import {
  submitFeedbackReport,
  type FeedbackRuntimeContext,
} from "./lib/feedback";
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
  readEffectiveMcpServerEntries,
  removeMcpFromConfig,
  validateMcpServerName,
} from "./mcp";
import { buildSkillInventory, type BuildSkillInventoryInput } from "./lib/skill-inventory";
import {
  buildSessionMcpRows,
  buildSessionSkillRows,
  createSessionCapabilitiesCache,
  filterSessionSkillInventoryByScope,
  normalizeSessionCapabilityDirectory,
  resolveSessionCapabilitySessionSource,
  type SessionCapabilitiesScope,
  type SessionCapabilitiesSnapshot,
} from "./lib/session-capabilities";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "./types";
import type {
  Client,
  DashboardTab,
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
  SidebarSubagentDecoration,
  SidebarSessionItem,
  TodoItem,
  View,
  WorkspaceDisplay,
  McpServerEntry,
  McpStatusMap,
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  ProviderListItem,
  SessionErrorTurn,
  UpdateHandle,
  OpencodeConnectStatus,
  AutomationWorkspaceSummary,
  ScheduledJob,
  SuggestedPlugin,
  VesloAutomation,
  VesloAutomationCreatePayload,
  VesloAutomationUpdatePayload,
  WorkspaceAutomationItem,
} from "./types";
import { buildAutomationWorkspaceSummaries } from "./lib/automation-workspace-map";
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
import { isFileDragTransfer } from "./utils/data-transfer-files";
import { createStartupGuard } from "./utils/startup-guard";
import {
  parseAuthCompleteDeepLink,
  clearDenAuth,
  exchangeHandoffCode,
  flushPendingDesktopSnapshotWrite,
  getDesktopBrowserAuthStatus,
  hydrateDenAuthFromDesktopSnapshot,
  readDenAuth,
  resolveAuthenticatedDenUserLabel,
  resolvePreferredDenUserLabel,
  subscribeDenAuthChanges,
  writeDenAuth,
  readDenKeepSignedIn,
  writeDenKeepSignedIn,
  getDenApiBase,
  startDesktopBrowserAuth,
  readDesktopAuthExchangeProof,
  readPendingDesktopAuthSession,
  clearDesktopAuthExchangeProof,
} from "./lib/den-auth";
import { currentLocale, isLanguage, setLocale, t, type Language } from "../i18n";
import {
  isWindowsPlatform,
  isMacPlatform,
  // normalizeDirectoryPath,
  parseModelRef,
  readStartupPreference,
  safeStringify,
  summarizeStep,
  addOpencodeCacheHint,
  normalizeTodoItems,
} from "./utils";
import {
  applyThemeMode,
  getInitialThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
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
  accessProofAiClear,
  accessProofAiRead,
  accessProofAiWrite,
  updaterEnvironment,
  pendingSessionDraftsDelete,
  pendingSessionDraftsGet,
  pendingSessionDraftsList,
  pendingSessionDraftsPut,
  readOpencodeConfig,
  writeOpencodeConfig,
  engineInfo,
  vesloServerInfo,
  vesloServerRestart,
  orchestratorStatus,
  orchestratorEnginesList,
  opencodeRouterInfo,
  setWindowDecorations,
  setWindowTitleBarStyle,
  workspaceCopyIntoFolder,
  workspaceVesloRead,
  workspaceVesloWrite,
  logUiEvent,
  opencodeDbUpdateSessionDirectory,
  type OrchestratorEngineSnapshot,
  type OrchestratorStatus,
  type VesloServerInfo,
  type OpenCodeRouterInfo,
  type WorkspaceInfo,
} from "./lib/tauri";
import {
  FONT_ZOOM_STEP,
  applyWebviewZoom,
  applyFontZoom,
  normalizeFontZoom,
  parseFontZoomShortcut,
  persistFontZoom,
  readStoredFontZoom,
} from "./lib/font-zoom";
import {
  parseVesloWorkspaceIdFromUrl,
  readVesloBundleInviteFromSearch,
  readVesloConnectInviteFromSearch,
  stripVesloBundleInviteFromUrl,
  stripVesloConnectInviteFromUrl,
  createVesloServerClient,
  deriveLocalVesloServerUrlFromOpencodeBaseUrl,
  hydrateVesloServerSettingsFromEnv,
  normalizeVesloServerUrl,
  requestManagedAiAccessBundle,
  resolveSessionArchiveClientOptions,
  readVesloServerSettings,
  writeVesloServerSettings,
  clearVesloServerSettings,
  type VesloAuditEntry,
  type VesloSoulHeartbeatEntry,
  type VesloSoulOverviewResponse,
  type VesloSoulStatus,
  type VesloSessionArchiveRecord,
  type VesloSessionLatestRunArtifacts,
  type VesloConversationRunInput,
  type VesloManagedAiAccessBundle,
  type VesloServerClient,
  type VesloServerCapabilities,
  type VesloServerDiagnostics,
  type VesloServerStatus,
  type VesloServerSettings,
  VesloServerError,
} from "./lib/veslo-server";
import {
  pickCollisionSafeName,
  toWorkspaceRelativeFromSessionDir,
} from "./lib/session-attachment-staging";
import {
  routeStagedAttachmentsForModel,
  type StagedSessionAttachment,
} from "./lib/attachment-prompt-routing";
import { resolveArtifactFamilies } from "./components/session/artifact-family-model";
import {
  clearUnreadSession,
  markUnreadAfterAssistantResponse,
  pruneUnreadSessions,
  type UnreadSessionMap,
} from "./components/session/session-unread-model";
import {
  AI_ACCESS_ADMIN_MANAGED_MESSAGE,
  AI_ACCESS_LOADING_MESSAGE,
  AI_ACCESS_NOT_CONFIGURED_MESSAGE,
  extractManagedApiKey,
  formatManagedAiAccessConfig,
  hasUsableManagedAiRuntimeConfig,
  resolveManagedAiAccessBundleState,
  resolveManagedAiGatewayBaseUrl,
  resolveManagedAiProviderRoutingTarget,
  shouldPreserveManagedAiConfig,
  shouldEnsureManagedAiLocalGateway,
  shouldDeferManagedAiAccessRefresh,
  type ManagedAiAccessProfile,
} from "./lib/ai-access";
import { isGatewayOwnedProvider } from "./utils/providers";
import {
  resolveManagedAiAccessRetryDelayMs,
  shouldRetryManagedAiAccessRefresh,
} from "./lib/managed-ai-access-retry";
import { waitForManagedAiBootstrapReady } from "./lib/managed-ai-bootstrap-ready";
import { shouldAutoReloadManagedAiConfig } from "./lib/managed-ai-config-reload";
import { assertNoClientError, describeRequestError } from "./lib/client-errors";
import { CLOUD_ONLY_MODE, resolveVesloCloudEnvironment } from "./lib/cloud-policy";
import {
  LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY,
  buildLegacyArchiveMigration,
  buildSessionArchiveSnapshot,
  sortArchivedSessionsByRecency,
  toSessionArchiveItem,
} from "./lib/session-archive-model";
import { isRemoteUiEnabled } from "./lib/runtime-policy";

type RemoteWorkspaceDefaults = {
  vesloHostUrl?: string | null;
  vesloToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

type SendTraceRoot = typeof window & {
  __vesloSendTrace?: Array<Record<string, unknown>>;
  __vesloActiveSendTraceId?: string | null;
  __vesloSendTraceSeq?: number;
  __vesloSendTraceStartPerfMsById?: Record<string, number>;
};

type SendConversationWorkspaceResolution = {
  serverClient: VesloServerClient;
  serverWorkspaceId: string;
  workspaceId: string;
  directory: string;
};

type SendPreflightContext = SendRuntimePreflightContext & {
  traceId: string;
  managedAiReady: boolean;
  runtimeHealthOk: boolean;
  targetWorkspace: SendTargetWorkspaceScope | null;
  conversationWorkspaceByDirectory: Map<string, Promise<SendConversationWorkspaceResolution | null>>;
};

type AppSendPromptOptions = SessionSendOptionsBase & {
  targetSessionId?: string | null;
  onMaterializedSessionId?: (sessionId: string) => void;
  pendingSession?: PendingSidebarSessionMetadata | null;
};

type AppReplaceUserMessageOptions = SessionSendOptionsBase & {
  targetSessionId?: string | null;
};

const SEND_TRACE_LIMIT = 500;
const MANAGED_AI_ACCESS_CACHE_STORAGE_KEY = "veslo.managedAiAccess.v1";
const MANAGED_AI_ACCESS_CACHE_TTL_MS = 30 * 60 * 1000;
const MANAGED_AI_ACCESS_PROOF_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

type ManagedAiAccessCacheRecord = {
  schemaVersion: 1;
  cacheKey: string;
  fetchedAt: number;
  profile: ManagedAiAccessProfile;
  gatewayAccessToken: string;
};

type ManagedAiAccessProofCacheState = {
  cacheKey: string;
  loaded: boolean;
  record: ManagedAiAccessCacheRecord | null;
};

let managedAiAccessRefreshInFlight: {
  cacheKey: string;
  promise: Promise<VesloManagedAiAccessBundle>;
} | null = null;

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
  targetWorkspace: null,
  conversationWorkspaceByDirectory: new Map(),
});

const isManagedAiAccessProfileValue = (value: unknown): value is ManagedAiAccessProfile => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ManagedAiAccessProfile>;
  return Boolean(
    typeof record.userId === "string" &&
      record.userId.trim() &&
      typeof record.providerId === "string" &&
      record.providerId.trim() &&
      record.defaultModel &&
      typeof record.defaultModel === "object" &&
      typeof record.defaultModel.providerID === "string" &&
      typeof record.defaultModel.modelID === "string" &&
      Array.isArray(record.allowedModels),
  );
};

const buildManagedAiAccessCacheKey = (input: {
  userId: string | null | undefined;
  orgId: string | null | undefined;
  gatewayBaseUrl: string | null | undefined;
}) => {
  const userId = input.userId?.trim() ?? "";
  const orgId = input.orgId?.trim() ?? "";
  const gatewayBaseUrl = input.gatewayBaseUrl?.trim().replace(/\/+$/, "") ?? "";
  return userId && gatewayBaseUrl ? `${userId}|${orgId}|${gatewayBaseUrl}` : "";
};

const readManagedAiAccessCache = (cacheKey: string): ManagedAiAccessCacheRecord | null => {
  if (isTauriRuntime()) return null;
  if (!cacheKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MANAGED_AI_ACCESS_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ManagedAiAccessCacheRecord>;
    if (parsed.schemaVersion !== 1) return null;
    if (parsed.cacheKey !== cacheKey) return null;
    if (!Number.isFinite(parsed.fetchedAt) || Date.now() - Number(parsed.fetchedAt) > MANAGED_AI_ACCESS_CACHE_TTL_MS) {
      return null;
    }
    if (!isManagedAiAccessProfileValue(parsed.profile)) return null;
    const gatewayAccessToken = typeof parsed.gatewayAccessToken === "string" ? parsed.gatewayAccessToken.trim() : "";
    if (!gatewayAccessToken || gatewayAccessToken === "[REDACTED]") return null;
    return {
      schemaVersion: 1,
      cacheKey,
      fetchedAt: Number(parsed.fetchedAt),
      profile: parsed.profile,
      gatewayAccessToken,
    };
  } catch {
    return null;
  }
};

const writeManagedAiAccessCache = (cacheKey: string, profile: ManagedAiAccessProfile, gatewayAccessToken: string) => {
  if (!cacheKey || typeof window === "undefined") return;
  if (isTauriRuntime()) {
    void accessProofAiWrite({
      cacheKey,
      proof: {
        providerId: profile.providerId,
        defaultModel: profile.defaultModel,
        allowedModels: profile.allowedModels,
        updatedAt: profile.updatedAt,
      },
    }).catch(() => undefined);
    return;
  }
  const token = gatewayAccessToken.trim();
  if (!token || token === "[REDACTED]") return;
  try {
    const record: ManagedAiAccessCacheRecord = {
      schemaVersion: 1,
      cacheKey,
      fetchedAt: Date.now(),
      profile,
      gatewayAccessToken: token,
    };
    window.localStorage.setItem(MANAGED_AI_ACCESS_CACHE_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // ignore storage failures; the live refresh path still owns correctness
  }
};

const clearManagedAiAccessCache = (cacheKey?: string | null) => {
  if (isTauriRuntime()) {
    void accessProofAiClear(cacheKey).catch(() => undefined);
  }
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(MANAGED_AI_ACCESS_CACHE_STORAGE_KEY);
  } catch {
    // ignore
  }
};

const readManagedAiAccessProofCache = async (
  cacheKey: string,
  userId: string,
): Promise<ManagedAiAccessCacheRecord | null> => {
  if (!cacheKey || !userId || !isTauriRuntime()) return null;
  try {
    const proof = await accessProofAiRead({
      cacheKey,
      maxAgeMs: MANAGED_AI_ACCESS_PROOF_CACHE_TTL_MS,
    });
    if (!proof) return null;
    if (!isGatewayOwnedProvider(proof.providerId)) return null;
    if (proof.defaultModel.providerID !== proof.providerId || !proof.defaultModel.modelID.trim()) return null;
    const allowedModels = Array.isArray(proof.allowedModels)
      ? proof.allowedModels.map((value) => value.trim()).filter(Boolean)
      : [];
    if (allowedModels.length > 0 && !allowedModels.includes(proof.defaultModel.modelID)) return null;
    const profile: ManagedAiAccessProfile = {
      userId,
      providerId: proof.providerId,
      defaultModel: proof.defaultModel,
      allowedModels,
      updatedAt: proof.updatedAt ?? null,
    };
    if (!isManagedAiAccessProfileValue(profile)) return null;
    return {
      schemaVersion: 1,
      cacheKey,
      fetchedAt: proof.fetchedAt,
      profile,
      gatewayAccessToken: "",
    };
  } catch {
    return null;
  }
};

const loadManagedAiAccessSingleFlight = (
  cacheKey: string,
  load: () => Promise<VesloManagedAiAccessBundle>,
): Promise<VesloManagedAiAccessBundle> => {
  if (cacheKey && managedAiAccessRefreshInFlight?.cacheKey === cacheKey) {
    return managedAiAccessRefreshInFlight.promise;
  }

  const promise = load().finally(() => {
    if (managedAiAccessRefreshInFlight?.cacheKey === cacheKey) {
      managedAiAccessRefreshInFlight = null;
    }
  });

  if (cacheKey) {
    managedAiAccessRefreshInFlight = { cacheKey, promise };
  }

  return promise;
};

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

export default function App() {
  const cloudEnvironment = resolveVesloCloudEnvironment(import.meta.env as Record<string, string | undefined>);
  const envVesloWorkspaceId = cloudEnvironment.workspaceId ?? null;
  const developerMode = () => false;
  const [documentVisible, setDocumentVisible] = createSignal(true);
  const [appFocused, setAppFocused] = createSignal(true);

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
  const location = useLocation();
  const navigate = useNavigate();

  const [creatingSession, setCreatingSession] = createSignal(false);
  const [sessionViewLockUntil, setSessionViewLockUntil] = createSignal(0);
  const currentView = createMemo<View>(() => {
    const path = location.pathname.toLowerCase();
    if (path.startsWith("/onboarding")) return "onboarding";
    if (path.startsWith("/session")) return "session";
    if (path.startsWith("/proto")) return "proto";
    return "dashboard";
  });
  const isProtoV1Ux = createMemo(() =>
    location.pathname.toLowerCase().startsWith("/proto-v1-ux")
  );

  const [tab, setTabState] = createSignal<DashboardTab>("scheduled");
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("general");

  const goToDashboard = (nextTab: DashboardTab, options?: { replace?: boolean }) => {
    setTabState(nextTab);
    navigate(`/dashboard/${nextTab}`, options);
  };

  const setTab = (nextTab: DashboardTab) => {
    if (currentView() === "dashboard") {
      goToDashboard(nextTab);
      return;
    }
    setTabState(nextTab);
  };

  const setView = (next: View, sessionId?: string) => {
    if (next === "dashboard" && creatingSession()) {
      return;
    }
    if (next === "dashboard" && Date.now() < sessionViewLockUntil()) {
      return;
    }
    if (next === "proto") {
      navigate("/proto/workspaces");
      return;
    }
    if (next === "onboarding") {
      navigate("/onboarding");
      return;
    }
    if (next === "session") {
      if (sessionId) {
        goToSession(sessionId);
        return;
      }
      navigate("/session");
      return;
    }
    goToDashboard(tab());
  };

  const goToSession = (sessionId: string, options?: { replace?: boolean }) => {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      navigate("/session", options);
      return;
    }
    navigate(`/session/${trimmed}`, options);
  };

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
  const [feedbackModalOpen, setFeedbackModalOpen] = createSignal(false);
  const [feedbackSubmitError, setFeedbackSubmitError] = createSignal<string | null>(null);
  const [feedbackSubmitSuccessIssueId, setFeedbackSubmitSuccessIssueId] = createSignal<string | null>(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = createSignal(false);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(getInitialThemeMode());

  function openFeedbackModal() {
    setFeedbackSubmitError(null);
    setFeedbackSubmitSuccessIssueId(null);
    setFeedbackModalOpen(true);
  }

  function closeFeedbackModal() {
    setFeedbackSubmitError(null);
    setFeedbackSubmitSuccessIssueId(null);
    setFeedbackModalOpen(false);
  }

  const normalizeFeedbackOptional = (value?: string | null) => {
    const trimmed = value?.trim() ?? "";
    return trimmed ? trimmed : null;
  };

  const resolveFeedbackPlatform = () => {
    if (typeof navigator === "undefined") return null;
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
      navigator.platform;
    return normalizeFeedbackOptional(platform);
  };

  const buildFeedbackRuntimeContext = (): FeedbackRuntimeContext => ({
    view: currentView(),
    pathname: location.pathname.trim() || "/",
    tab: tab(),
    settingsTab: settingsTab(),
    selectedSessionId: normalizeFeedbackOptional(activeSessionId()),
    activeWorkspaceId: normalizeFeedbackOptional(workspaceStore.activeWorkspaceId()),
    vesloServerWorkspaceId: normalizeFeedbackOptional(resolvedDevtoolsWorkspaceId()),
    activeWorkspaceType: activeWorkspaceDisplay().workspaceType,
    activeWorkspaceRoot: normalizeFeedbackOptional(
      currentView() === "session"
        ? preferredSessionWorkspaceRoot(
            resolveSessionDirectory(selectedSession() ?? { id: "", directory: "" }),
            workspaceStore.activeWorkspaceRoot().trim(),
          )
        : workspaceStore.activeWorkspaceRoot().trim(),
    ),
    locale: currentLocale(),
    appVersion: normalizeFeedbackOptional(appVersion()),
    platform: resolveFeedbackPlatform(),
  });

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

  const [vesloServerSettings, setVesloServerSettings] = createSignal<VesloServerSettings>({});
  const [vesloServerUrl, setVesloServerUrl] = createSignal("");
  const [vesloServerStatus, setVesloServerStatus] = createSignal<VesloServerStatus>("disconnected");
  const [vesloServerCapabilities, setVesloServerCapabilities] = createSignal<VesloServerCapabilities | null>(null);
  const [vesloServerCheckedAt, setVesloServerCheckedAt] = createSignal<number | null>(null);
  const [vesloServerWorkspaceId, setVesloServerWorkspaceId] = createSignal<string | null>(null);
  const [vesloServerHostInfo, setVesloServerHostInfo] = createSignal<VesloServerInfo | null>(null);
  const [vesloServerDiagnostics, setVesloServerDiagnostics] = createSignal<VesloServerDiagnostics | null>(null);
  const [vesloReconnectBusy, setVesloReconnectBusy] = createSignal(false);
  const [opencodeRouterInfoState, setOpenCodeRouterInfoState] = createSignal<OpenCodeRouterInfo | null>(null);
  const [orchestratorStatusState, setOrchestratorStatusState] = createSignal<OrchestratorStatus | null>(null);
  const [orchestratorEnginesState, setOrchestratorEnginesState] = createSignal<OrchestratorEngineSnapshot[]>([]);
  const readyEngineWorkspaceIds = createMemo(() => {
    const set = new Set<string>();
    for (const engine of orchestratorEnginesState()) {
      if (engine.state === "ready") set.add(engine.workspaceId);
    }
    return set;
  });
  const [vesloAuditEntries, setVesloAuditEntries] = createSignal<VesloAuditEntry[]>([]);
  const [vesloAuditStatus, setVesloAuditStatus] = createSignal<"idle" | "loading" | "error">("idle");
  const [vesloAuditError, setVesloAuditError] = createSignal<string | null>(null);
  const [devtoolsWorkspaceId, setDevtoolsWorkspaceId] = createSignal<string | null>(null);
  const [authenticatedAccountId, setAuthenticatedAccountId] = createSignal<string | null>(null);
  const activeVesloServerHostInfo = createMemo(() =>
    resolveRunningVesloServerHostInfo(vesloServerHostInfo())
  );

  const updateEngineSource = (
    value: EngineSourcePreference,
    options?: {
      explicit?: boolean;
    },
  ) => {
    setEngineSource(value);
    setEngineSourceExplicit(options?.explicit === true);
  };

  const vesloServerLocalFallbackBaseUrl = createMemo(() => {
    if (!isTauriRuntime()) return "";
    if (startupPreference() === "server") return "";
    return deriveLocalVesloServerUrlFromOpencodeBaseUrl(baseUrl()) ?? "";
  });

  const vesloServerBaseUrl = createMemo(() => {
    const pref = startupPreference();
    const hostInfo = activeVesloServerHostInfo();
    const localFallbackUrl = vesloServerLocalFallbackBaseUrl();
    const settingsUrl = normalizeVesloServerUrl(vesloServerSettings().urlOverride ?? "") ?? "";
    const preferredLocalUrl = hostInfo?.baseUrl ?? localFallbackUrl;

    if (pref === "local") return preferredLocalUrl;
    if (pref === "server") return settingsUrl;
    return preferredLocalUrl || settingsUrl;
  });

  const vesloServerAuth = createMemo(
    () => {
      const pref = startupPreference();
      const hostInfo = activeVesloServerHostInfo();
      const localFallbackUrl = vesloServerLocalFallbackBaseUrl();
      const settingsToken = vesloServerSettings().token?.trim() ?? "";
      const clientToken = hostInfo?.clientToken?.trim() ?? "";
      const hostToken = hostInfo?.hostToken?.trim() ?? "";

      if (pref === "local") {
        return { token: clientToken || undefined, hostToken: hostToken || undefined };
      }
      if (pref === "server") {
        return { token: settingsToken || undefined, hostToken: undefined };
      }
      if (hostInfo?.baseUrl) {
        return { token: clientToken || undefined, hostToken: hostToken || undefined };
      }
      if (localFallbackUrl) {
        return { token: undefined, hostToken: undefined };
      }
      return { token: settingsToken || undefined, hostToken: undefined };
    },
    undefined,
    {
      equals: (prev, next) => prev?.token === next.token && prev?.hostToken === next.hostToken,
    },
  );

  const vesloServerClient = createMemo(() => {
    const baseUrl = vesloServerBaseUrl().trim();
    if (!baseUrl) return null;
    const auth = vesloServerAuth();
    return createVesloServerClient({ baseUrl, token: auth.token, hostToken: auth.hostToken });
  });

  const vesloArchiveClientOptions = createMemo(() => {
    const auth = vesloServerAuth();
    return resolveSessionArchiveClientOptions({
      accountId: authenticatedAccountId(),
      activeBaseUrl: vesloServerBaseUrl(),
      activeToken: auth.token,
      settingsUrl: vesloServerSettings().urlOverride,
      settingsToken: vesloServerSettings().token,
      cloudUrl: cloudEnvironment.vesloUrl,
      cloudToken: cloudEnvironment.token,
    });
  });

  const sessionArchiveOwnerKey = createMemo(() => vesloArchiveClientOptions()?.accountId ?? "");

  const vesloArchiveClient = createMemo(() => {
    const resolved = vesloArchiveClientOptions();
    if (!resolved) return null;
    return createVesloServerClient(resolved);
  });

  const isLoopbackUrl = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    try {
      const parsed = new URL(trimmed);
      const hostname = parsed.hostname.trim().toLowerCase();
      return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    } catch {
      return false;
    }
  };

  const gatewayVesloServerClient = createMemo(() => {
    const active = vesloServerClient();
    const activeBaseUrl = active?.baseUrl?.trim() ?? "";
    const settings = vesloServerSettings();
    const remoteUrl = normalizeVesloServerUrl(settings.urlOverride ?? "") ?? "";
    const remoteToken = settings.token?.trim() ?? "";

    if (!remoteUrl || !remoteToken) {
      return active;
    }

    if (isLoopbackUrl(activeBaseUrl) && !isLoopbackUrl(remoteUrl)) {
      return createVesloServerClient({ baseUrl: remoteUrl, token: remoteToken });
    }

    return active;
  });

  const managedAiGatewayBaseUrl = createMemo(() => {
    const settings = vesloServerSettings();
    return resolveManagedAiGatewayBaseUrl({
      settingsUrl: normalizeVesloServerUrl(settings.urlOverride ?? "") ?? "",
      gatewayClientBaseUrl: gatewayVesloServerClient()?.baseUrl?.trim() ?? "",
      localFallbackBaseUrl: vesloServerLocalFallbackBaseUrl(),
      isDesktopRuntime: isTauriRuntime(),
    });
  });

  const devtoolsVesloClient = createMemo(() => vesloServerClient());

  createEffect(() => {
    if (typeof window === "undefined") return;
    hydrateVesloServerSettingsFromEnv();

    const stored = readVesloServerSettings();
    const invite = readVesloConnectInviteFromSearch(window.location.search);
    const bundleInvite = readVesloBundleInviteFromSearch(window.location.search);

    if (!invite) {
      setVesloServerSettings(stored);
    } else {
      const merged: VesloServerSettings = {
        ...stored,
        urlOverride: invite.url,
        token: invite.token ?? stored.token,
      };

      const next = writeVesloServerSettings(merged);
      setVesloServerSettings(next);

      if (invite.startup === "server") {
        setStartupPreference("server");
        if (untrack(onboardingStep) !== "language") {
          setOnboardingStep("server");
        }
      }
    }

    if (bundleInvite?.bundleUrl) {
      setPendingSharedBundleInvite({
        bundleUrl: bundleInvite.bundleUrl,
        intent: bundleInvite.intent,
        source: bundleInvite.source,
        orgId: bundleInvite.orgId,
        label: bundleInvite.label,
      });
      setSharedBundleNoticeShown(false);
    }

    const cleanedConnect = stripVesloConnectInviteFromUrl(window.location.href);
    const cleaned = stripVesloBundleInviteFromUrl(cleanedConnect);
    if (cleaned !== window.location.href) {
      window.history.replaceState(window.history.state ?? null, "", cleaned);
    }
  });

  createEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    onCleanup(() => document.removeEventListener("visibilitychange", update));
  });

  createEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const updateAppFocused = () => {
      setAppFocused(document.visibilityState !== "hidden" && document.hasFocus());
    };

    updateAppFocused();
    window.addEventListener("focus", updateAppFocused);
    window.addEventListener("blur", updateAppFocused);
    document.addEventListener("visibilitychange", updateAppFocused);
    onCleanup(() => {
      window.removeEventListener("focus", updateAppFocused);
      window.removeEventListener("blur", updateAppFocused);
      document.removeEventListener("visibilitychange", updateAppFocused);
    });
  });


  createEffect(() => {
    if (typeof window === "undefined") return;

    const handleGlobalFileDropGuard = (event: DragEvent) => {
      if (isFileDragTransfer(event.dataTransfer) === false) return;
      event.preventDefault();
    };

    window.addEventListener("dragover", handleGlobalFileDropGuard, true);
    window.addEventListener("drop", handleGlobalFileDropGuard, true);
    onCleanup(() => {
      window.removeEventListener("dragover", handleGlobalFileDropGuard, true);
      window.removeEventListener("drop", handleGlobalFileDropGuard, true);
    });
  });
  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!isTauriRuntime()) return;

    const applyAndPersistFontZoom = (value: number) => {
      const next = normalizeFontZoom(value);
      persistFontZoom(window.localStorage, next);

      try {
        const webview = getCurrentWebview();
        void applyWebviewZoom(webview, next)
          .then(() => {
            document.documentElement.style.removeProperty("--veslo-font-size");
          })
          .catch(() => {
            applyFontZoom(document.documentElement.style, next);
          });
      } catch {
        applyFontZoom(document.documentElement.style, next);
      }

      return next;
    };

    let fontZoom = applyAndPersistFontZoom(readStoredFontZoom(window.localStorage) ?? 1);

    const handleZoomShortcut = (event: KeyboardEvent) => {
      const action = parseFontZoomShortcut(event);
      if (!action) return;

      if (action === "in") {
        fontZoom = applyAndPersistFontZoom(fontZoom + FONT_ZOOM_STEP);
      } else if (action === "out") {
        fontZoom = applyAndPersistFontZoom(fontZoom - FONT_ZOOM_STEP);
      } else {
        fontZoom = applyAndPersistFontZoom(1);
      }

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleZoomShortcut, true);
    onCleanup(() => window.removeEventListener("keydown", handleZoomShortcut, true));
  });

  createEffect(() => {
    const pref = startupPreference();
    const info = activeVesloServerHostInfo();
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const localFallbackUrl = vesloServerLocalFallbackBaseUrl();
    const resolvedLocalUrl = hostUrl || localFallbackUrl;
    const settingsUrl = normalizeVesloServerUrl(vesloServerSettings().urlOverride ?? "") ?? "";

    if (pref === "local") {
      setVesloServerUrl(resolvedLocalUrl);
      return;
    }
    if (pref === "server") {
      setVesloServerUrl(settingsUrl);
      return;
    }
    setVesloServerUrl(resolvedLocalUrl || settingsUrl);
  });

  const checkVesloServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createVesloServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      if (error instanceof VesloServerError && (error.status === 401 || error.status === 403)) {
        return { status: "limited" as VesloServerStatus, capabilities: null };
      }
      return { status: "disconnected" as VesloServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as VesloServerStatus, capabilities: null };
    }

    try {
      const caps = await client.capabilities();
      return { status: "connected" as VesloServerStatus, capabilities: caps };
    } catch (error) {
      if (error instanceof VesloServerError && (error.status === 401 || error.status === 403)) {
        return { status: "limited" as VesloServerStatus, capabilities: null };
      }
      return { status: "disconnected" as VesloServerStatus, capabilities: null };
    }
  };

  let ensureLocalVesloServerRunning: (options?: { ignoreStartupPreference?: boolean }) => Promise<boolean> = async () => false;

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!documentVisible()) return;
    const url = vesloServerBaseUrl().trim();
    const auth = vesloServerAuth();
    const token = auth.token;
    const hostToken = auth.hostToken;

    if (!url) {
      setVesloServerStatus("disconnected");
      setVesloServerCapabilities(null);
      setVesloServerCheckedAt(Date.now());
      return;
    }

    let active = true;
    let busy = false;
    let timeoutId: number | undefined;
    let delayMs = 1_000;

    const scheduleNext = () => {
      if (!active) return;
      timeoutId = window.setTimeout(run, delayMs);
    };

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await checkVesloServer(url, token, hostToken);
        if (!active) return;
        setVesloServerStatus(result.status);
        setVesloServerCapabilities(result.capabilities);
        delayMs =
          result.status === "connected" || result.status === "limited"
            ? 10_000
            : Math.min(delayMs * 2, 5_000);
      } catch {
        delayMs = Math.min(delayMs * 2, 5_000);
      } finally {
        if (!active) return;
        setVesloServerCheckedAt(Date.now());
        busy = false;
        scheduleNext();
      }
    };

    run();
    onCleanup(() => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!documentVisible()) return;
    let active = true;
    let timeoutId: number | undefined;

    const schedule = (delayMs: number) => {
      if (!active) return;
      timeoutId = window.setTimeout(run, delayMs);
    };

    const run = async () => {
      try {
        const info = await vesloServerInfo();
        if (!active) return;
        setVesloServerHostInfo(info);
        // Cold-start cadence: 1s while the sidecar is still booting, 10s
        // once it reports running. Without the tight initial cadence the
        // first running:false answer would pin the UI to "Unavailable" for
        // a full 10s tick before the next probe.
        schedule(info?.running ? 10_000 : 1_000);
      } catch {
        if (!active) return;
        setVesloServerHostInfo(null);
        schedule(1_000);
      }
    };

    run();
    onCleanup(() => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
    });
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!documentVisible()) return;
    if (!developerMode()) {
      setVesloServerDiagnostics(null);
      return;
    }

    const client = vesloServerClient();
    if (!client || vesloServerStatus() === "disconnected") {
      setVesloServerDiagnostics(null);
      return;
    }

    let active = true;
    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        const status = await client.status();
        if (active) setVesloServerDiagnostics(status);
      } catch {
        if (active) setVesloServerDiagnostics(null);
      } finally {
        busy = false;
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!developerMode()) return;
    if (!documentVisible()) return;

    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        await workspaceStore.refreshEngine();
      } finally {
        busy = false;
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!developerMode()) {
      setOpenCodeRouterInfoState(null);
      return;
    }
    if (!documentVisible()) return;

    let active = true;

    const run = async () => {
      try {
        const info = await opencodeRouterInfo();
        if (active) setOpenCodeRouterInfoState(info);
      } catch {
        if (active) setOpenCodeRouterInfoState(null);
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!developerMode()) {
      setOrchestratorStatusState(null);
      return;
    }
    if (!documentVisible()) return;

    let active = true;

    const run = async () => {
      try {
        const status = await orchestratorStatus();
        if (active) setOrchestratorStatusState(status);
      } catch {
        if (active) setOrchestratorStatusState(null);
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  // Poll orchestrator engine pool every 30s so the sidebar can show which
  // workspaces have a warm engine. 30s (not 5s) — engines change state on
  // user actions (workspace switch, idle suspend), not continuously. Tight
  // polling was leaking timers under HMR and pushing veslo-server CPU to
  // 500%.
  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!documentVisible()) return;
    let active = true;
    const run = async () => {
      try {
        const list = await orchestratorEnginesList();
        if (active) setOrchestratorEnginesState(list);
      } catch {
        if (active) setOrchestratorEnginesState([]);
      }
    };
    run();
    const interval = window.setInterval(run, 30_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  const [client, setClient] = createSignal<Client | null>(null);

  // VSLO-171 F3Ú9 — Performance pool settings forwarded to orchestrator.
  const [maxEngines, setMaxEngines] = createSignal(16);
  const [idleSuspendMs, setIdleSuspendMs] = createSignal(0);

  // VSLO-171 — workspace routing service. Multi mode is the only mode (no
  // single-active fallback, no feature flag). Instantiated before
  // createSessionStore so memos that read routing.mode() at init can resolve.
  let workspaceStoreRef: ReturnType<typeof createWorkspaceStore> | null = null;
  const workspaceRouting = createWorkspaceRouting({
    clientSource: client,
    activeWorkspaceId: () => workspaceStoreRef?.activeWorkspaceId().trim() ?? "",
    createClient: (baseUrl, directory, auth) => createClient(baseUrl, directory, auth),
    waitForHealthy: (c, opts) => waitForHealthy(c, opts),
  });
  const routedClient = (workspaceId?: string) =>
    workspaceRouting.client(workspaceId);

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
  // Send-timeout fix 2026-06-10 — boots false: on cold/lazy boot no engine is
  // running, and the old initial `true` opened a window where engineReady
  // guards (permission polls, MCP status, capabilities) passed and their GETs
  // cold-spawned the engine through the orchestrator proxy (up to 60s each).
  // connectToServer/onEngineStable flips this true after a successful connect.
  const [engineReady, setEngineReady] = createSignal(false);

  // VSLO-171 F3Ú8: cross-workspace takeover confirmation dialog removed.
  // See comment in sendPrompt about replacement strategy.

  const mountTime = Date.now();
  // Per-workspace deduplication of opencode.jsonc patches. Key is the Veslo
  // workspace id (server-backed branch) or absolute root path (local branch).
  // A global signal would skip the patch for non-active workspaces after the
  // first one was patched in this session — see VSLO retry-loop bug after
  // server token rotation.
  const lastKnownConfigSnapshotByWs = new Map<string, string>();
  // Inactive-workspace baseURL healing dedup. Key = Veslo workspace id, value
  // = the server client token that the last successful patch was made for. If
  // the server restarts with a fresh token, every entry effectively expires
  // because the next iteration sees a different token and re-patches.
  const inactiveWorkspaceBaseUrlHealedFor = new Map<string, string>();
  // Tracks which Veslo server token we already wrote into managed-AI config.
  // The Veslo server mints a fresh client token on every restart, so
  // opencode.jsonc files in workspaces that were not visited since the last
  // restart still hold the old apiKey. Patching them is fast; automatically
  // disposing the engine from this reactive path is not, and it can kill a
  // healthy engine immediately before Send.
  const [
    lastManagedAiConfigAppliedForServerToken,
    setLastManagedAiConfigAppliedForServerToken,
  ] = createSignal("");

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
      activateWorkspace: (workspaceId, options) => workspaceStore.activateWorkspace(workspaceId, options),
      createScratchWorkspace: () => workspaceStore.createScratchWorkspace(),
      forgetWorkspace: (workspaceId, options) => workspaceStore.forgetWorkspace(workspaceId, options),
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
    activeWorkspaceId: () => workspaceStoreRef?.activeWorkspaceId() ?? "",
    activeWorkspaceRoot: () => workspaceStoreRef?.activeWorkspaceRoot().trim() ?? "",
    workspaces: () => workspaceStoreRef?.workspaces() ?? [],
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
  } = workspaceSessionSelection;
  const [unreadSessionIds, setUnreadSessionIds] = createSignal<UnreadSessionMap>({});
  const SESSION_DIRECTORY_OVERRIDE_KEY = "veslo.session-workspace-override.v1";
  const SUBAGENT_DECORATIONS_PREF_KEY = "veslo.subagent-decorations.v1";
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
  const readSubagentDecorationsState = (): SubagentDecorationsPersistenceV1 => {
    if (typeof window === "undefined") return emptySubagentDecorationsPersistence();
    try {
      const raw = window.localStorage.getItem(SUBAGENT_DECORATIONS_PREF_KEY);
      return parseSubagentDecorationsPersistence(raw) ?? emptySubagentDecorationsPersistence();
    } catch {
      return emptySubagentDecorationsPersistence();
    }
  };
  const writeSubagentDecorationsState = (value: SubagentDecorationsPersistenceV1) => {
    if (typeof window === "undefined") return;
    try {
      const payload = serializeSubagentDecorationsPersistence(value);
      if (payload) {
        window.localStorage.setItem(SUBAGENT_DECORATIONS_PREF_KEY, payload);
      } else {
        window.localStorage.removeItem(SUBAGENT_DECORATIONS_PREF_KEY);
      }
    } catch {
      // ignore
    }
  };
  const toSubagentLocale = (language: Language): SubagentLocale => (language === "cs" ? "cs" : "en");

  const [sessionDirectoryOverrideById, setSessionDirectoryOverrideById] = createSignal<
    Record<string, string>
  >(readSessionDirectoryOverrides());
  const [subagentDecorationsState, setSubagentDecorationsState] = createSignal<SubagentDecorationsPersistenceV1>(
    emptySubagentDecorationsPersistence(),
  );
  const [subagentDecorationsReady, setSubagentDecorationsReady] = createSignal(false);
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

  const resolveConversationServerWorkspaceId = (workspaceIdRaw: string) => {
    const workspaceId = workspaceIdRaw.trim();
    if (!workspaceId) return "";

    const workspace = workspaceStore.workspaces().find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) return workspaceId;

    if (workspace.workspaceType === "remote" && workspace.remoteType === "veslo") {
      return (
        workspace.vesloWorkspaceId?.trim() ||
        parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
        parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
        workspaceId
      );
    }

    return workspace.vesloWorkspaceId?.trim() || workspaceId;
  };

  const resolvePassiveConversationReadClient = async () => {
    let serverClient = vesloServerClient();
    if (isTauriRuntime() && startupPreference() !== "server" && vesloServerStatus() === "disconnected") {
      await ensureLocalVesloServerRunning().catch((error) => {
        wsDebug("conversation-read:server-start:failed", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      });
      serverClient = vesloServerClient();
    }
    if (serverClient) return serverClient;

    if (isTauriRuntime()) {
      await ensureLocalVesloServerRunning().catch((error) => {
        wsDebug("conversation-read:server-start:failed", {
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      });
      serverClient = vesloServerClient();
    }

    return serverClient;
  };

  const ensureConversationReadWorkspaceRegistered = async (
    serverClient: NonNullable<ReturnType<typeof vesloServerClient>>,
    workspaceIdRaw: string,
    directoryRaw?: string | null,
  ) => {
    const workspaceId = workspaceIdRaw.trim();
    const fallback = resolveConversationServerWorkspaceId(workspaceId);
    if (!workspaceId) return "";

    const workspace = workspaceStore.workspaces().find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "local") return fallback;

    const workspaceRootRaw = workspace.path?.trim() || workspace.directory?.trim() || "";
    const targetDirectoryRaw = directoryRaw?.trim() || workspaceRootRaw;
    const workspaceRoot = normalizeDirectoryPath(workspaceRootRaw);
    const targetDirectory = normalizeDirectoryPath(targetDirectoryRaw);
    if (!targetDirectory) return fallback;
    const matchDirectories = new Set([workspaceRoot, targetDirectory].filter(Boolean));
    type ConversationWorkspaceRegistryEntry = {
      id: string;
      path?: string;
      directory?: string;
      baseUrl?: string;
      opencodeUsername?: string;
      opencodePassword?: string;
      opencode?: {
        baseUrl?: string;
        directory?: string;
        username?: string;
      };
    };

    const normalizeBaseUrlForCompare = (value: string | null | undefined) =>
      value?.trim().replace(/\/+$/, "") ?? "";
    const parseWorkspaceMountId = (value: string | null | undefined) => {
      const baseUrl = normalizeBaseUrlForCompare(value);
      if (!baseUrl) return "";
      try {
        const match = new URL(baseUrl).pathname.match(/^\/workspace\/([^/]+)\/opencode(?:\/.*)?$/);
        return match ? decodeURIComponent(match[1] ?? "").trim() : "";
      } catch {
        return "";
      }
    };

    const resolveLocalOpencodeRegistration = async () => {
      if (!isTauriRuntime()) return null;
      try {
        const info = await engineInfo(workspaceId, workspaceRootRaw || targetDirectoryRaw);
        const resolvedBaseUrl = normalizeBaseUrlForCompare(info.baseUrl);
        if (!resolvedBaseUrl) return null;
        return {
          baseUrl: resolvedBaseUrl,
          directory: info.projectDir?.trim() || targetDirectoryRaw || workspaceRootRaw,
          opencodeUsername: info.opencodeUsername?.trim() || null,
          opencodePassword: info.opencodePassword?.trim() || null,
        };
      } catch (error) {
        wsDebug("conversation-read:engine-info:failed", {
          workspaceId,
          directory: targetDirectory,
          error: error instanceof Error ? error.message : safeStringify(error),
        });
        return null;
      }
    };

    const matchesRegistration = (
      entry: ConversationWorkspaceRegistryEntry,
      registration: Awaited<ReturnType<typeof resolveLocalOpencodeRegistration>>,
    ) => {
      if (!registration?.baseUrl) return true;
      const existingBaseUrl = normalizeBaseUrlForCompare(entry.baseUrl || entry.opencode?.baseUrl);
      const mountId = parseWorkspaceMountId(registration.baseUrl);
      if (mountId && entry.id !== mountId) return false;
      return existingBaseUrl === registration.baseUrl;
    };

    const findMatchingWorkspace = (items: ConversationWorkspaceRegistryEntry[]) => {
      const exact = items.find((entry) => entry.id === fallback);
      if (exact) return exact;
      const match = items.find((entry) => {
        const candidates = [
          entry.path,
          entry.directory,
          entry.opencode?.directory,
        ]
          .map((value) => normalizeDirectoryPath(value?.trim() ?? ""))
          .filter(Boolean);
        return candidates.some((candidate) => matchDirectories.has(candidate));
      });
      return match ?? null;
    };

    const opencodeRegistration = await resolveLocalOpencodeRegistration();

    try {
      const listed = await serverClient.listWorkspaces();
      const existing = findMatchingWorkspace(listed.items);
      if (existing && matchesRegistration(existing, opencodeRegistration)) return existing.id;
    } catch (error) {
      wsDebug("conversation-read:workspace-list:failed", {
        workspaceId,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
    }

    try {
      // Explicit read bootstrap: registers workspace metadata with Veslo server
      // so passive reads can be routed by workspace id. This does not start
      // or contact the OpenCode engine.
      const added = await serverClient.addLocalWorkspace({
        path: workspaceRootRaw || targetDirectoryRaw,
        name: workspace.name?.trim() || undefined,
        baseUrl: opencodeRegistration?.baseUrl ?? undefined,
        directory: opencodeRegistration?.directory || targetDirectoryRaw,
        opencodeUsername: opencodeRegistration?.opencodeUsername ?? undefined,
        opencodePassword: opencodeRegistration?.opencodePassword ?? undefined,
      });
      const registered = findMatchingWorkspace(added.items);
      if (registered) return registered.id;
    } catch (error) {
      wsDebug("conversation-read:workspace-register:failed", {
        workspaceId,
        directory: targetDirectory,
        hasBaseUrl: Boolean(opencodeRegistration?.baseUrl),
        error: error instanceof Error ? error.message : safeStringify(error),
      });
    }

    return fallback;
  };

  const conversationWorkspaceCacheKey = (workspaceId: string, directory: string) => [
    workspaceId.trim(),
    normalizeDirectoryPath(directory) || directory.trim(),
  ].join("\n");

  const resolveConversationServerWorkspaceForSend = async (
    workspaceId: string,
    directory: string,
    preflight: SendPreflightContext | undefined,
    reason: string,
  ): Promise<SendConversationWorkspaceResolution | null> => {
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedDirectory = directory.trim();
    const tracePayload = preflight ? { traceId: preflight.traceId } : undefined;
    if (!normalizedWorkspaceId || !normalizedDirectory) {
      recordSendTrace(`${reason}:conversation-workspace-skipped-empty`, {
        ...(tracePayload ?? {}),
        hasWorkspaceId: Boolean(normalizedWorkspaceId),
        hasDirectory: Boolean(normalizedDirectory),
      });
      return null;
    }

    const cacheKey = conversationWorkspaceCacheKey(normalizedWorkspaceId, normalizedDirectory);
    const cached = preflight?.conversationWorkspaceByDirectory.get(cacheKey);
    if (cached) {
      recordSendTrace(`${reason}:conversation-workspace-cache-hit`, {
        ...(tracePayload ?? {}),
        workspaceId: normalizedWorkspaceId,
        directory: normalizedDirectory,
      });
      return await cached;
    }

    const promise = sendTraceStep(
      `${reason}:conversation-workspace-resolve`,
      async () => {
        const serverClient = await sendTraceStep(
          `${reason}:resolve-passive-client`,
          () => resolvePassiveConversationReadClient(),
          {
            ...(tracePayload ?? {}),
            vesloServerStatus: vesloServerStatus(),
            hasCachedClient: Boolean(vesloServerClient()),
          },
        );
        if (!serverClient) {
          recordSendTrace(`${reason}:conversation-workspace-unavailable-client`, tracePayload);
          return null;
        }

        const serverWorkspaceId = await sendTraceStep(
          `${reason}:ensure-workspace-registered`,
          () => ensureConversationReadWorkspaceRegistered(
            serverClient,
            normalizedWorkspaceId,
            normalizedDirectory,
          ),
          {
            ...(tracePayload ?? {}),
            workspaceId: normalizedWorkspaceId,
            directory: normalizedDirectory,
          },
        );
        if (!serverWorkspaceId) {
          recordSendTrace(`${reason}:conversation-workspace-unavailable-id`, {
            ...(tracePayload ?? {}),
            workspaceId: normalizedWorkspaceId,
            directory: normalizedDirectory,
          });
          return null;
        }

        recordSendTrace(`${reason}:conversation-workspace-resolved`, {
          ...(tracePayload ?? {}),
          workspaceId: normalizedWorkspaceId,
          serverWorkspaceId,
          directory: normalizedDirectory,
        });
        return {
          serverClient,
          serverWorkspaceId,
          workspaceId: normalizedWorkspaceId,
          directory: normalizedDirectory,
        };
      },
      {
        ...(tracePayload ?? {}),
        workspaceId: normalizedWorkspaceId,
        directory: normalizedDirectory,
      },
    );

    preflight?.conversationWorkspaceByDirectory.set(cacheKey, promise);
    return await promise;
  };

  const listConversationsFromVesloReadApi = async (
    workspaceId: string,
    directory?: string,
  ) => {
    const serverClient = await resolvePassiveConversationReadClient();
    if (!serverClient) {
      return { workspaceId, serverWorkspaceId: "", items: [], source: "unavailable" as const };
    }
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
    if (!serverWorkspaceId) {
      return { workspaceId, serverWorkspaceId: "", items: [], source: "unavailable" as const };
    }
    const result = await serverClient.listConversations(serverWorkspaceId, directory);
    rememberConversationScopesFromSessions(workspaceId, directory, result.items);
    return { ...result, serverWorkspaceId };
  };

  const getTranscriptFromVesloReadApi = async (
    workspaceId: string,
    sessionId: string,
    limit: number,
    directory?: string,
  ) => {
    const serverClient = await resolvePassiveConversationReadClient();
    if (!serverClient) return null;
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
    if (!serverWorkspaceId) return null;
    const snapshot = await serverClient.getSessionTranscript(serverWorkspaceId, sessionId, limit, directory);
    rememberConversationScopeFromTranscript(workspaceId, directory, snapshot);
    return snapshot.source === "unavailable" ? null : snapshot;
  };

  const createConversationFromVesloWriteApi = async (
    workspaceId: string,
    directory: string,
    title?: string,
    preflight?: SendPreflightContext,
  ) => {
    const tracePayload = preflight ? { traceId: preflight.traceId } : undefined;
    recordSendTrace("createConversationFromVesloWriteApi:start", {
      ...(tracePayload ?? {}),
      workspaceId,
      directory,
      hasTitle: Boolean(title?.trim()),
    });
    const resolution = await resolveConversationServerWorkspaceForSend(
      workspaceId,
      directory,
      preflight,
      "createConversationFromVesloWriteApi",
    );
    if (!resolution) {
      recordSendTrace("createConversationFromVesloWriteApi:unavailable", tracePayload);
      return null;
    }
    const result = await sendTraceStep(
      "createConversationFromVesloWriteApi:create",
      () => resolution.serverClient.createConversation(resolution.serverWorkspaceId, {
        directory,
        title,
      }),
      {
        ...(tracePayload ?? {}),
        workspaceId,
        serverWorkspaceId: resolution.serverWorkspaceId,
        directory,
      },
    );
    rememberConversationScope({
      sessionId: result.id,
      workspaceId,
      workspaceRoot: resolveWorkspaceRootForConversationScope(workspaceId, directory),
      directory,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
    });
    return result;
  };

  const runConversationFromVesloWriteApi = async (
    sessionId: string,
    input: VesloConversationRunInput,
    options: {
      sendTraceId?: string | null;
      preflight?: SendPreflightContext;
      targetWorkspace?: SendTargetWorkspaceScope | null;
    } = {},
  ) => {
    const traceId = options.preflight?.traceId || options.sendTraceId?.trim() || activeSendTraceId() || "";
    const tracePayload = traceId ? { traceId } : undefined;
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }
    const scope = resolveSelectedSessionBrowseScope(normalizedSessionId);
    const targetWorkspace = options.targetWorkspace ?? options.preflight?.targetWorkspace ?? null;
    const workspaceId = scope?.workspaceId?.trim() || targetWorkspace?.workspaceId?.trim() || workspaceStore.activeWorkspaceId().trim();
    if (!workspaceId) {
      throw new Error("Workspace id is required for conversation run.");
    }
    const targetWorkspaceId = targetWorkspace?.workspaceId?.trim() || "";
    if (targetWorkspaceId && workspaceId !== targetWorkspaceId) {
      throw new Error("Conversation workspace does not match the send target workspace.");
    }
    const workspaceRoot = scope?.workspaceRoot?.trim() || targetWorkspace?.workspaceRoot?.trim() || workspaceStore.activeWorkspaceRoot().trim();
    const directory = input.directory?.trim() || scope?.directory?.trim() || targetWorkspace?.directory?.trim() || workspaceRoot;
    if (!directory) {
      throw new Error("Conversation directory is required.");
    }

    recordSendTrace("runConversationFromVesloWriteApi:start", {
      ...(tracePayload ?? {}),
      sessionId: normalizedSessionId,
      workspaceId,
      directory,
      kind: input.kind,
      clientMessageId: typeof input.clientMessageId === "string" ? input.clientMessageId : null,
      origin: typeof input.origin === "string" ? input.origin : null,
      hasConversationScope: Boolean(scope?.conversationId),
    });
    const resolution = await resolveConversationServerWorkspaceForSend(
      workspaceId,
      directory,
      options.preflight,
      "runConversationFromVesloWriteApi",
    );
    if (!resolution) {
      recordSendTrace("runConversationFromVesloWriteApi:unavailable", tracePayload);
      return null;
    }
    const conversationId = scope?.conversationId?.trim() || normalizedSessionId;
    const result = await sendTraceStep(
      "runConversationFromVesloWriteApi:run",
      () => resolution.serverClient.runConversation(
        resolution.serverWorkspaceId,
        conversationId,
        {
          ...input,
          directory,
        },
        {
          sendTraceId: traceId || undefined,
        },
      ),
      {
        ...(tracePayload ?? {}),
        workspaceId,
        serverWorkspaceId: resolution.serverWorkspaceId,
        conversationId,
        kind: input.kind,
      },
    );
    recordExternalSendTraceEntries(result.debugTrace);
    rememberConversationScope({
      sessionId: result.opencodeSessionId || normalizedSessionId,
      workspaceId,
      workspaceRoot: resolveWorkspaceRootForConversationScope(workspaceId, directory),
      directory,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
    });
    rememberLatestConversationRunId({
      workspaceId,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
      uiSessionId: normalizedSessionId,
      runId: result.runId,
    });
    return result;
  };

  const abortConversationFromVesloWriteApi = async (sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("Session id is required.");
    }
    const scope = resolveSelectedSessionBrowseScope(normalizedSessionId);
    const workspaceId = scope?.workspaceId?.trim() || workspaceStore.activeWorkspaceId().trim();
    if (!workspaceId) {
      throw new Error("Workspace id is required for conversation abort.");
    }
    const workspaceRoot = scope?.workspaceRoot?.trim() || workspaceStore.activeWorkspaceRoot().trim();
    const directory = scope?.directory?.trim() || sessionDirectoryOverrideById()[normalizedSessionId]?.trim() || workspaceRoot;
    if (!directory) {
      throw new Error("Conversation directory is required.");
    }
    const conversationId = scope?.conversationId?.trim() || normalizedSessionId;
    const runId = resolveLatestConversationRunId({
      workspaceId,
      conversationId,
      opencodeSessionId: scope?.opencodeSessionId,
      uiSessionId: normalizedSessionId,
    });
    if (!runId) {
      throw new Error("Conversation run id is not available for abort.");
    }

    const serverClient = await resolvePassiveConversationReadClient();
    if (!serverClient) return null;
    const serverWorkspaceId = await ensureConversationReadWorkspaceRegistered(serverClient, workspaceId, directory);
    if (!serverWorkspaceId) return null;
    const result = await serverClient.abortConversation(serverWorkspaceId, conversationId, {
      directory,
      runId,
    });
    rememberConversationScope({
      sessionId: result.opencodeSessionId || normalizedSessionId,
      workspaceId,
      workspaceRoot: resolveWorkspaceRootForConversationScope(workspaceId, directory),
      directory,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
    });
    return result;
  };

  const sessionStore = createSessionStore({
    client,
    routing: workspaceRouting,
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot().trim(),
    selectedSessionId,
    setSelectedSessionId,
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
      listConversations: async (workspaceId, directory) => {
        const result = await listConversationsFromVesloReadApi(workspaceId, directory);
        return { items: result.items, source: result.source };
      },
    }),
    shouldBrowseSessionFromDb: (sessionId) => {
      const transcriptScope = resolveSelectedSessionBrowseScope(sessionId);
      if (transcriptScope) return true;
      return !engineReady();
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
    // VSLO-86 — selectSession uses this to decide between the offline DB
    // transcript (browse mode) and a live SDK call that would cold-spawn the
    // engine. engineReady() flips to true only after sendPrompt has driven
    // the engine through ensureEngineForWorkspace.
    engineReady: () => engineReady(),
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
    selectedSessionStatus,
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
  const busySessionByWorkspaceId = createMemo<Record<string, { sessionId: string; startedAt: number }>>(
    () => workspaceStoreRef?.workspaceBusy() ?? {},
  );
  const activeConversationBusy = createMemo(() => {
    const sessionId = activeSessionId();
    const scope = sessionId ? resolveSelectedSessionBrowseScope(sessionId) : null;
    const workspaceId = scope?.workspaceId?.trim() || workspaceStoreRef?.activeWorkspaceId().trim() || "";
    const entry = workspaceId ? busySessionByWorkspaceId()[workspaceId] : null;
    return Boolean(entry && sessionId && entry.sessionId === sessionId);
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
        return await client.getSessionLatestRunArtifacts(serverWorkspaceId, scope.sessionId);
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

  const [sessionsLoaded, setSessionsLoaded] = createSignal(false);
  const loadSessionsWithReady = async (scopeRoot?: string) => {
    await loadSessions(scopeRoot);
    setSessionsLoaded(true);
  };

  createEffect(() => {
    if (!routedClient()) {
      setSessionsLoaded(false);
    }
  });

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

  type PartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

  const attachmentToFile = async (attachment: ComposerAttachment): Promise<File> => {
    const response = await fetch(attachment.dataUrl);
    if (!response.ok) {
      throw new Error(`Failed to read attachment ${attachment.name}.`);
    }
    const blob = await response.blob();
    return new File([blob], attachment.name, {
      type: attachment.mimeType || blob.type || "application/octet-stream",
    });
  };

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    const fallbackBuffer = (globalThis as {
      Buffer?: { from: (input: Uint8Array) => { toString: (encoding: string) => string } };
    }).Buffer;
    if (fallbackBuffer) {
      return fallbackBuffer.from(bytes).toString("base64");
    }
    if (typeof btoa !== "function") {
      throw new Error("Base64 encoder is unavailable");
    }
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const slice = bytes.subarray(index, index + chunkSize);
      for (const byte of slice) {
        binary += String.fromCharCode(byte);
      }
    }
    return btoa(binary);
  };

  const resolveSessionDirectoryRelativePath = (sessionID: string, filename: string) => {
    const workspaceRoot = workspaceProjectDir().trim();
    const sessionDirectory = (sessionDirectoryOverrideById()[sessionID] ?? workspaceRoot).trim();
    if (!workspaceRoot || !sessionDirectory) {
      throw new Error("Session directory is not available for attachment staging.");
    }

    const workspaceRootForCheck = normalizeDirectoryPath(workspaceRoot) || workspaceRoot;
    const sessionDirectoryForCheck = normalizeDirectoryPath(sessionDirectory) || sessionDirectory;
    return toWorkspaceRelativeFromSessionDir({
      workspaceRoot: workspaceRootForCheck,
      sessionDirectory: sessionDirectoryForCheck,
      filename,
    });
  };

  const resolveWorkspaceAbsolutePath = (relativePath: string) => {
    const workspaceRoot = workspaceProjectDir().trim().replace(/[\\/]+$/, "");
    const normalizedRelativePath = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!workspaceRoot || !normalizedRelativePath) {
      throw new Error("Workspace path is not available for staged attachments.");
    }
    return `${workspaceRoot}/${normalizedRelativePath}`;
  };

  const resolveCollisionSafeAttachmentPath = async (
    client: NonNullable<ReturnType<typeof vesloServerClient>>,
    fileSessionId: string,
    preferredPath: string,
    reservedPaths: Set<string>,
  ) => {
    const normalizedPreferred = preferredPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    const slashIndex = normalizedPreferred.lastIndexOf("/");
    const directoryRel = slashIndex === -1 ? "" : normalizedPreferred.slice(0, slashIndex);
    const filename = slashIndex === -1 ? normalizedPreferred : normalizedPreferred.slice(slashIndex + 1);
    const knownCollisions = new Set(reservedPaths);

    let attempt = 0;
    while (attempt < 512) {
      const candidatePath = pickCollisionSafeName({
        directoryRel,
        filename,
        existingPaths: knownCollisions,
      });

      const result = await client.readFileBatch(fileSessionId, [candidatePath]);
      const item = result.items[0];
      if (item?.ok) {
        knownCollisions.add(candidatePath);
        attempt += 1;
        continue;
      }
      if (!item || item.code === "file_not_found") {
        reservedPaths.add(candidatePath);
        return candidatePath;
      }
      throw new Error(item.message ?? `Unable to stage ${filename}.`);
    }

    throw new Error(`Failed to resolve a unique filename for ${filename}.`);
  };

  const resolveWorkspaceIdForAttachmentStaging = async (
    client: NonNullable<ReturnType<typeof vesloServerClient>>,
  ) => {
    const response = await client.listWorkspaces();
    const items = Array.isArray(response.items) ? response.items : [];
    const active = workspaceStore.activeWorkspaceDisplay();
    const activeId = response.activeId?.trim() ?? "";
    const cachedWorkspaceId = (vesloServerWorkspaceId() ?? "").trim();

    const findByPath = (targetPath: string) => {
      const normalizedTarget = normalizeDirectoryPath(targetPath.trim());
      if (normalizedTarget === "") return null;
      return items.find((entry) => {
        const candidates = [
          normalizeDirectoryPath((entry.path ?? "").trim()),
          normalizeDirectoryPath((entry.directory ?? "").trim()),
          normalizeDirectoryPath((entry.opencode?.directory ?? "").trim()),
        ].filter(Boolean);
        return candidates.includes(normalizedTarget);
      }) ?? null;
    };

    let resolved = "";
    if (active.workspaceType === "remote" && active.remoteType === "veslo") {
      const inferredWorkspaceId =
        parseVesloWorkspaceIdFromUrl(active.vesloHostUrl ?? "") ??
        parseVesloWorkspaceIdFromUrl(active.baseUrl ?? "") ??
        parseVesloWorkspaceIdFromUrl(vesloServerUrl().trim());
      const storedId = active.vesloWorkspaceId?.trim() || inferredWorkspaceId || envVesloWorkspaceId || "";
      resolved =
        (storedId && items.find((entry) => entry.id === storedId)?.id) ||
        (cachedWorkspaceId && items.find((entry) => entry.id === cachedWorkspaceId)?.id) ||
        findByPath(active.directory?.trim() ?? active.path?.trim() ?? "")?.id ||
        activeId ||
        (items.length === 1 ? items[0]?.id ?? "" : "");
    } else if (active.workspaceType === "local") {
      const activeRoot = workspaceStore.activeWorkspaceRoot().trim();
      resolved =
        findByPath(activeRoot)?.id ||
        (!activeRoot && items.length === 1 ? (activeId || items[0]?.id || "") : "");
    }

    if (resolved) {
      setVesloServerWorkspaceId(resolved);
    }

    return resolved;
  };

  type AttachmentStagingWorkspaceReady = {
    client: NonNullable<ReturnType<typeof vesloServerClient>>;
    workspaceId: string;
  };

  const recoverWorkspaceReadyForAttachmentStaging = async (
    fallbackClient: NonNullable<ReturnType<typeof vesloServerClient>>,
  ): Promise<AttachmentStagingWorkspaceReady> => {
    const active = workspaceStore.activeWorkspaceDisplay();
    if (!isTauriRuntime() || startupPreference() === "server" || active.workspaceType !== "local") {
      throw new Error("Veslo server workspace is not ready for attachments.");
    }

    recordSendTrace("sendPrompt:attachment-workspace-recover", {
      activeWorkspaceId: workspaceStore.activeWorkspaceId().trim(),
      activeRoot: workspaceStore.activeWorkspaceRoot().trim(),
    });

    const restarted = await vesloServerRestart();
    setVesloServerHostInfo(restarted);
    const running = resolveRunningVesloServerHostInfo(restarted);
    if (!running?.baseUrl?.trim()) {
      setVesloServerStatus("disconnected");
      setVesloServerCapabilities(null);
      setVesloServerCheckedAt(Date.now());
      throw new Error("Veslo server workspace is not ready for attachments.");
    }

    const result = await checkVesloServer(
      running.baseUrl.trim(),
      running.clientToken?.trim() || undefined,
      running.hostToken?.trim() || undefined,
    );
    setVesloServerStatus(result.status);
    setVesloServerCapabilities(result.capabilities);
    setVesloServerCheckedAt(Date.now());
    if (result.status !== "connected") {
      throw new Error("Veslo server workspace is not ready for attachments.");
    }

    const client = vesloServerClient() ?? fallbackClient;
    const workspaceId = await resolveWorkspaceIdForAttachmentStaging(client);
    if (!workspaceId) {
      throw new Error("Veslo server workspace is not ready for attachments.");
    }
    return { client, workspaceId };
  };

  const ensureWorkspaceReadyForAttachmentStaging = async (
    client: NonNullable<ReturnType<typeof vesloServerClient>>,
  ): Promise<AttachmentStagingWorkspaceReady> => {
    const workspaceId = await resolveWorkspaceIdForAttachmentStaging(client);
    if (workspaceId) return { client, workspaceId };
    return await recoverWorkspaceReadyForAttachmentStaging(client);
  };

  const shouldRecoverAttachmentStagingWorkspace = (error: unknown) => {
    if (error instanceof VesloServerError) {
      return error.status === 404;
    }
    const message = messageFromUnknownError(error).toLowerCase();
    return message.includes("workspace") && message.includes("not");
  };

  const stageAttachmentsIntoSessionDirectory = async (
    draft: ComposerDraft,
    sessionID: string,
    preflight?: SendPreflightContext,
  ): Promise<StagedSessionAttachment[]> => {
    const tracePayload = preflight ? { traceId: preflight.traceId } : undefined;
    const attachmentsToStage = draft.attachments;
    if (!attachmentsToStage.length) {
      recordSendTrace("stageAttachmentsIntoSessionDirectory:skip-empty", {
        ...(tracePayload ?? {}),
        sessionID,
      });
      return [];
    }

    let client = vesloServerClient();
    if (!client || vesloServerStatus() !== "connected") {
      throw new Error("Connect to Veslo server before sending attachments.");
    }
    const scope = resolveSelectedSessionBrowseScope(sessionID);
    const workspaceIdForResolution = scope?.workspaceId?.trim() || workspaceStore.activeWorkspaceId().trim();
    const directoryForResolution =
      scope?.directory?.trim() ||
      sessionDirectoryOverrideById()[sessionID]?.trim() ||
      workspaceStore.activeWorkspaceRoot().trim();
    const resolution =
      workspaceIdForResolution && directoryForResolution
        ? await resolveConversationServerWorkspaceForSend(
            workspaceIdForResolution,
            directoryForResolution,
            preflight,
            "stageAttachmentsIntoSessionDirectory",
          )
        : null;
    if (resolution) {
      client = resolution.serverClient;
    }
    let ready: AttachmentStagingWorkspaceReady = resolution?.serverWorkspaceId
      ? { client, workspaceId: resolution.serverWorkspaceId }
      : await ensureWorkspaceReadyForAttachmentStaging(client);

    const reservedPaths = new Set<string>();
    const stagedAttachments: StagedSessionAttachment[] = [];
    let fileSession: Awaited<ReturnType<typeof ready.client.createFileSession>>;
    try {
      fileSession = await sendTraceStep(
        "stageAttachmentsIntoSessionDirectory:create-file-session",
        () => ready.client.createFileSession(ready.workspaceId, {
          ttlSeconds: 15 * 60,
          write: true,
        }),
        {
          ...(tracePayload ?? {}),
          sessionID,
          workspaceId: ready.workspaceId,
          attachmentCount: attachmentsToStage.length,
        },
      );
    } catch (error) {
      if (!shouldRecoverAttachmentStagingWorkspace(error)) {
        throw error;
      }
      ready = await recoverWorkspaceReadyForAttachmentStaging(ready.client);
      fileSession = await sendTraceStep(
        "stageAttachmentsIntoSessionDirectory:create-file-session",
        () => ready.client.createFileSession(ready.workspaceId, {
          ttlSeconds: 15 * 60,
          write: true,
        }),
        {
          ...(tracePayload ?? {}),
          sessionID,
          workspaceId: ready.workspaceId,
          attachmentCount: attachmentsToStage.length,
        },
      );
    }

    try {
      for (const attachment of attachmentsToStage) {
        const file = await attachmentToFile(attachment);
        const preferredPath = resolveSessionDirectoryRelativePath(sessionID, file.name);
        const relativePath = await resolveCollisionSafeAttachmentPath(
          ready.client,
          fileSession.session.id,
          preferredPath,
          reservedPaths,
        );
        const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
        const writeResult = await ready.client.writeFileBatch(fileSession.session.id, [
          {
            path: relativePath,
            contentBase64,
          },
        ]);
        const item = writeResult.items[0];
        if (!item?.ok) {
          throw new Error(item?.message ?? `Failed to stage ${attachment.name}.`);
        }
        stagedAttachments.push({
          name: attachment.name,
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          relativePath,
          absolutePath: resolveWorkspaceAbsolutePath(relativePath),
        });
      }
      recordSendTrace("stageAttachmentsIntoSessionDirectory:done", {
        ...(tracePayload ?? {}),
        sessionID,
        workspaceId: ready.workspaceId,
        attachmentCount: stagedAttachments.length,
      });
    } finally {
      await ready.client.closeFileSession(fileSession.session.id).catch(() => undefined);
    }

    return stagedAttachments;
  };

  const buildPromptParts = (draft: ComposerDraft): PartInput[] => {
    const parts: PartInput[] = [];
    const text = draft.resolvedText ?? draft.text;
    parts.push({ type: "text", text } as TextPartInput);

    const root = workspaceProjectDir().trim();
    const toAbsolutePath = (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("/")) return trimmed;
      // Windows absolute path, e.g. C:\foo\bar
      if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
      // Without a workspace root, we cannot safely resolve relative paths.
      // Returning "" avoids emitting invalid file:// URLs.
      if (!root) return "";
      return (root + "/" + trimmed).replace("//", "/");
    };
    const filenameFromPath = (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    };

    for (const part of draft.parts) {
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name } as AgentPartInput);
        continue;
      }
      if (part.type === "file") {
        const absolute = toAbsolutePath(part.path);
        if (!absolute) continue;
        parts.push({
          type: "file",
          mime: "text/plain",
          url: `file://${absolute}`,
          filename: filenameFromPath(part.path),
        } as FilePartInput);
      }
    }

    for (const attachment of draft.attachments) {
      parts.push({
        type: "file",
        url: attachment.dataUrl,
        filename: attachment.name,
        mime: attachment.mimeType,
      } as FilePartInput);
    }

    return parts;
  };

  const buildCommandFileParts = (draft: ComposerDraft): FilePartInput[] => {
    const parts: FilePartInput[] = [];
    const root = workspaceProjectDir().trim();

    const toAbsolutePath = (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("/")) return trimmed;
      if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
      if (!root) return "";
      return (root + "/" + trimmed).replace("//", "/");
    };

    const filenameFromPath = (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    };

    for (const part of draft.parts) {
      if (part.type !== "file") continue;
      const absolute = toAbsolutePath(part.path);
      if (!absolute) continue;
      parts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${absolute}`,
        filename: filenameFromPath(part.path),
      } as FilePartInput);
    }

    for (const attachment of draft.attachments) {
      parts.push({
        type: "file",
        url: attachment.dataUrl,
        filename: attachment.name,
        mime: attachment.mimeType,
      } as FilePartInput);
    }

    return parts;
  };

  async function maybeResolveSkillCommand(
    draft: ComposerDraft,
    traceId?: string | null,
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
    const workspaceId = resolvedDevtoolsWorkspaceId();
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
      });
      return draft;
    }

    try {
      const includeGlobal = workspaceStore.activeWorkspaceDisplay().workspaceType === "local";
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
          includeGlobal,
          textLength: text.length,
        },
      );

      const matchedName = resolution?.match?.name?.trim();
      if (!matchedName) {
        recordSendTrace("maybeResolveSkillCommand:no-match", tracePayload);
        return draft;
      }

      const commands = await sendTraceStep(
        "maybeResolveSkillCommand:list-commands",
        () => listCommands(),
        {
          ...(tracePayload ?? {}),
          matchedName,
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
    const selectedSessionCandidate = selectedSessionId();
    const selectedRealSessionId = isPendingSessionInstanceId(selectedSessionCandidate) ? null : selectedSessionCandidate;
    let sessionID = isPendingSessionInstanceId(options.targetSessionId)
      ? null
      : options.targetSessionId?.trim() || selectedRealSessionId;
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
      targetSessionId: options.targetSessionId ?? null,
      hasClient: Boolean(routedClient()),
      busy: busy(),
      busyLabel: busyLabel(),
    });
    let sendTargetWorkspace = pendingSidebarTargetWorkspace ?? resolveSendTargetWorkspaceScope(sessionID);
    sendPreflight.targetWorkspace = sendTargetWorkspace;
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
    const startSendPromptBusy = (label: string) => {
      if (!blockAppDuringPromptSend) return;
      ownsSendPromptBusy = true;
      setBusy(true);
      setBusyLabel(label);
      setBusyStartedAt(Date.now());
    };
    const stopSendPromptBusy = () => {
      if (!ownsSendPromptBusy) return;
      ownsSendPromptBusy = false;
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
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
    }

    resolvedDraft = await sendTraceStep(
      "sendPrompt:maybe-resolve-skill-command",
      () => maybeResolveSkillCommand(resolvedDraft, sendTraceId),
      {
        traceId: sendTraceId,
        mode: resolvedDraft.mode,
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
    }

    // In browsing mode, engine is not connected. Start it before sending.
    if (!engineReady()) {
      // VSLO-171 F3Ú8: cross-workspace takeover dialog removed.
      // Multi mode (F3Ú6) keeps per-WS clients alive in parallel; single-active
      // fallback may interrupt another worker silently but that's the legacy
      // behavior the multi flag is meant to replace.

      startSendPromptBusy("status.connecting");
      // Yield to the browser's macro task queue so it paints the spinner
      // before the engine start blocks the microtask chain.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        const started = await sendTraceStep(
          "sendPrompt:ensure-engine-for-workspace",
          () => workspaceStore.ensureEngineForWorkspace(sendTargetWorkspace?.workspaceId),
          {
            traceId: sendTraceId,
            activeWorkspaceId: workspaceStore.activeWorkspaceId().trim(),
            activeWorkspaceRoot: workspaceStore.activeWorkspaceRoot().trim(),
            targetWorkspaceId: sendTargetWorkspace?.workspaceId ?? null,
            targetWorkspaceRoot: sendTargetWorkspace?.workspaceRoot ?? null,
          },
        );
        if (!started) {
          recordSendTrace("sendPrompt:engine-not-started", {
            traceId: sendTraceId,
          });
          stopSendPromptBusy();
          return false;
        }
        sendPreflight.runtimeHealthOk = true;
      } catch (error) {
        recordSendTrace("sendPrompt:engine-start-error", {
          traceId: sendTraceId,
          message: messageFromUnknownError(error),
        });
        stopSendPromptBusy();
        return false;
      }
    }

    if (
      !(await sendTraceStep(
        "sendPrompt:ensure-managed-ai-bootstrap-ready",
        () => ensureManagedAiBootstrapReady(),
        {
          traceId: sendTraceId,
          managedAiBootstrapBusy: managedAiBootstrapBusy(),
          reloadBusy: reloadBusy(),
          hasClient: Boolean(routedClient()),
        },
      ))
    ) {
      recordSendTrace("sendPrompt:blocked-managed-ai-bootstrap", {
        traceId: sendTraceId,
      });
      stopSendPromptBusy();
      return false;
    }
    sendPreflight.managedAiReady = true;
    if (
      !(await sendTraceStep(
        "sendPrompt:ensure-local-runtime-reachable",
        () => ensureLocalRuntimeReachableForSend("sendPrompt", sendPreflight),
        {
          traceId: sendTraceId,
          activeWorkspaceId: workspaceStore.activeWorkspaceId().trim(),
          targetWorkspaceId: sendTargetWorkspace?.workspaceId ?? null,
          workspaceType: workspaceStore.activeWorkspaceDisplay().workspaceType,
          hasClient: Boolean(routedClient(sendTargetWorkspace?.workspaceId)),
        },
      ))
    ) {
      recordSendTrace("sendPrompt:blocked-runtime-unreachable", {
        traceId: sendTraceId,
      });
      stopSendPromptBusy();
      return false;
    }

    const c = routedClientForSendTarget(sendTargetWorkspace);
    if (!c) {
      recordSendTrace("sendPrompt:blocked-no-client", {
        traceId: sendTraceId,
      });
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
      return false;
    }

    const pendingDraftSendState = (() => {
      const pendingDraftKey = (activePendingDraftKey() ?? "").trim();
      if (sessionID) return null;
      if (!pendingDraftKey) return null;
      return {
        key: pendingDraftKey,
        meta: activePendingDraftMeta(),
        draftId: activePendingDraftMeta()?.id?.trim() || null,
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
        options.onMaterializedSessionId?.(materializedSessionId);
      } else {
        const selectedAfterCreate = selectedSessionId();
        sessionID = isPendingSessionInstanceId(selectedAfterCreate) ? null : selectedAfterCreate;
      }
    }
    if (!sessionID) {
      recordSendTrace("sendPrompt:blocked-no-session", {
        traceId: sendTraceId,
      });
      stopSendPromptBusy();
      return false;
    }

    const displayedConversationGuard = captureDisplayedConversationGuard(sessionID);
    const sendTargetStillDisplayed = () => displayedConversationStillMatches(displayedConversationGuard);
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
      const runConversationOrLegacy = async (
        input: VesloConversationRunInput,
        legacy: () => Promise<void>,
      ) => {
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
          if (scope?.conversationId) {
            throw new Error("Conversation service is unavailable for this scoped conversation.");
          }
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
          if (scope?.conversationId) {
            throw error;
          }
          console.warn("[conversation-run] falling back to OpenCode SDK", error);
        }

        recordSendTrace("sendPrompt:legacy-run-fallback", {
          traceId: sendTraceId,
          sessionID,
          kind: input.kind,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
        });
        await legacy();
      };

      if (resolvedDraft.mode === "shell") {
        await runConversationOrLegacy(
          {
            kind: "shell",
            directory: sessionDirOverride,
            command: content,
            model,
            agent: agent ?? undefined,
          },
          async () => {
            await shellInSession(c, sessionID, content);
          },
        );
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

        // session.command() expects `model` as a provider/model string and only supports file parts.
        await runConversationOrLegacy(
          {
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
          },
          async () => {
            unwrap(
              await c.session.command({
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
              }),
            );
          },
        );
        commandMessageIDToClear = null;

      } else {
        await runConversationOrLegacy(
          {
            kind: "prompt_async",
            directory: sessionDirOverride,
            model,
            agent: agent ?? undefined,
            variant: requestVariant,
            ...promptOverrides,
            parts,
          },
          async () => {
            const result = await c.session.promptAsync({
              sessionID,
              model,
              agent: agent ?? undefined,
              variant: requestVariant,
              ...promptOverrides,
              parts,
              directory: sessionDirOverride,
            });
            assertNoClientError(result);
          },
        );
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
      stopSendPromptBusy();
    }
  }

  async function abortSession(sessionID?: string) {
    const id = (sessionID ?? selectedSessionId() ?? "").trim();
    if (!id) return;
    const scope = resolveSelectedSessionBrowseScope(id);
    const abortSessionViaScopedLegacy = async (): Promise<boolean> => {
      if (!scope?.workspaceId) return false;
      const opencodeSessionId = scope.opencodeSessionId?.trim() || id;
      if (!opencodeSessionId || opencodeSessionId === scope.conversationId?.trim()) return false;
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
      const result = await abortConversationFromVesloWriteApi(id);
      if (result) return;
      recordSendTrace("abortSession:conversation-abort-unavailable", {
        sessionID: id,
        hasConversationScope: Boolean(scope?.conversationId),
      });
      if (scope?.conversationId) {
        throw new Error("Conversation service is unavailable for this scoped conversation.");
      }
    } catch (error) {
      recordSendTrace("abortSession:conversation-abort-error", {
        sessionID: id,
        hasConversationScope: Boolean(scope?.conversationId),
        message: messageFromUnknownError(error),
      });
      if (scope?.conversationId) {
        // Abort is a safe/idempotent stop operation. If the local app lost the
        // submitted runId after reload, still stop the scoped OpenCode session
        // through the exact workspace client instead of failing closed.
        if (await abortSessionViaScopedLegacy()) {
          recordSendTrace("abortSession:scoped-legacy-fallback", { sessionID: id });
          return;
        }
        throw error;
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

  function retryLastPrompt() {
    const text = lastPromptSent().trim();
    if (!text) return;
    void sendPrompt({
      mode: "prompt",
      text,
      parts: [{ type: "text", text }],
      attachments: [],
    }, {
      clientMessageId: createSessionClientMessageId(),
      origin: "app:retry-last-prompt",
    });
  }

  async function compactCurrentSession(sessionIdOverride?: string) {
    const c = routedClient();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const sessionID = (sessionIdOverride ?? selectedSessionId() ?? "").trim();
    if (!sessionID) {
      throw new Error("Select a session before compacting.");
    }

    const visible = messages();
    if (!visible.length) {
      throw new Error("Nothing to compact yet.");
    }

    const model = selectedSessionModel();
    const startedAt = perfNow();
    const modelLabel = `${model.providerID}/${model.modelID}`;
    recordPerfLog(developerMode(), "session.compact", "start", {
      sessionID,
      messageCount: visible.length,
      model: modelLabel,
      variant: modelVariant() ?? null,
    });

    try {
      const directory = sessionDirectoryOverrideById()[sessionID] ?? (workspaceProjectDir().trim() || undefined);
      const scope = resolveSelectedSessionBrowseScope(sessionID);
      try {
        const result = await runConversationFromVesloWriteApi(sessionID, {
          kind: "summarize",
          directory,
          providerID: model.providerID,
          modelID: model.modelID,
        });
        if (result) {
          finishPerf(developerMode(), "session.compact", "done", startedAt, {
            sessionID,
            messageCount: visible.length,
            model: modelLabel,
          });
          return;
        }
        recordSendTrace("compactSession:conversation-run-unavailable", {
          sessionID,
          hasConversationScope: Boolean(scope?.conversationId),
        });
        if (scope?.conversationId) {
          throw new Error("Conversation service is unavailable for this scoped conversation.");
        }
      } catch (error) {
        recordSendTrace("compactSession:conversation-run-error", {
          sessionID,
          hasConversationScope: Boolean(scope?.conversationId),
          message: messageFromUnknownError(error),
        });
        if (scope?.conversationId) {
          throw error;
        }
        console.warn("[conversation-compact] falling back to OpenCode SDK", error);
      }

      recordSendTrace("compactSession:legacy-run-fallback", { sessionID });
      await compactSessionTyped(c, sessionID, model, {
        directory,
      });
      finishPerf(developerMode(), "session.compact", "done", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
      });
    } catch (error) {
      finishPerf(developerMode(), "session.compact", "error", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
      throw error;
    }
  }

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
    const status = sessionID ? sessionStatusById()[sessionID] ?? null : null;
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

  const restorePromptFromUserMessage = (message: MessageWithParts) => {
    const text = message.parts
      .filter(isVisibleTextPart)
      .map((part) => String((part as { text?: string }).text ?? ""))
      .join("");
    setPrompt(text);
  };

  async function replaceUserMessage(
    messageID: string,
    draft: ComposerDraft,
    options: AppReplaceUserMessageOptions,
  ): Promise<boolean> {
    const sendCorrelation = normalizeSessionSendCorrelation(options);
    if (!sendCorrelation.clientMessageId) {
      recordSendTrace("replaceUserMessage:blocked-missing-client-message-id", {
        origin: sendCorrelation.origin,
      });
      return false;
    }
    const replacePreflight = createSendPreflightContext(options.sendTraceId);
    const sendTraceId = replacePreflight.traceId;
    const sessionID = (options.targetSessionId?.trim() || selectedSessionId() || "").trim();
    if (!sessionID || !messageID.trim()) return false;

    recordSendTrace("replaceUserMessage:start", {
      traceId: sendTraceId,
      sessionID,
      messageID,
      clientMessageId: sendCorrelation.clientMessageId,
      origin: sendCorrelation.origin,
      engineReady: engineReady(),
      hasClient: Boolean(client()),
    });

    if (
      !(await sendTraceStep(
        "replaceUserMessage:ensure-scoped-workspace-active",
        () => ensureSelectedSessionWorkspaceActiveForSend(sessionID, sendTraceId),
        { traceId: sendTraceId, sessionID },
      ))
    ) {
      recordSendTrace("replaceUserMessage:blocked-scoped-workspace", { traceId: sendTraceId, sessionID });
      return false;
    }
    const sendTargetWorkspace = resolveSendTargetWorkspaceScope(sessionID);
    replacePreflight.targetWorkspace = sendTargetWorkspace;
    if (!(await ensureManagedAiBootstrapReady())) return false;
    if (!(await ensureLocalRuntimeReachableForSend("replaceUserMessage", replacePreflight))) return false;
    const c = routedClientForSendTarget(sendTargetWorkspace);
    if (!c) {
      recordSendTrace("replaceUserMessage:blocked-no-client", {
        traceId: sendTraceId,
        sessionID,
        workspaceId: sendTargetWorkspace?.workspaceId ?? null,
      });
      return false;
    }

    await abortSessionSafe(c, sessionID);

    const previousRevertMessageID = selectedSession()?.revert?.messageID ?? null;
    const next = await revertSession(c, sessionID, messageID);
    upsertLocalSession(next);

    const accepted = await sendPrompt(draft, {
      targetSessionId: sessionID,
      sendTraceId: options.sendTraceId,
      clientMessageId: sendCorrelation.clientMessageId,
      origin: sendCorrelation.origin,
    });
    if (!accepted) {
      try {
        const restored = previousRevertMessageID
          ? await revertSession(c, sessionID, previousRevertMessageID)
          : await unrevertSession(c, sessionID);
        upsertLocalSession(restored);
      } catch (error) {
        reportError(error, "session.replaceUserMessage.restore");
      }
    }
    return accepted;
  }

  async function undoLastUserMessage() {
    const c = routedClient();
    const sessionID = (selectedSessionId() ?? "").trim();
    if (!c || !sessionID) return;

    // Revert is rejected while the session is busy. We *usually* have an accurate
    // session status via SSE, but to be resilient to transient desync we attempt
    // an abort even when we think we're idle.
    await abortSessionSafe(c, sessionID);

    const revertMessageID = selectedSession()?.revert?.messageID ?? null;
    const users = messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });

    let target: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = messageIdFromInfo(candidate);
      if (!id) continue;
      if (!revertMessageID || id < revertMessageID) {
        target = candidate;
        break;
      }
    }

    if (!target) return;
    const messageID = messageIdFromInfo(target);
    if (!messageID) return;

    const next = await revertSession(c, sessionID, messageID);
    upsertLocalSession(next);
    restorePromptFromUserMessage(target);
  }

  async function redoLastUserMessage() {
    const c = routedClient();
    const sessionID = (selectedSessionId() ?? "").trim();
    if (!c || !sessionID) return;

    await abortSessionSafe(c, sessionID);

    const revertMessageID = selectedSession()?.revert?.messageID ?? null;
    if (!revertMessageID) return;

    const users = messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });

    const next = users.find((message) => {
      const id = messageIdFromInfo(message);
      return Boolean(id) && id > revertMessageID;
    });

    if (!next) {
      const session = await unrevertSession(c, sessionID);
      upsertLocalSession(session);
      setPrompt("");
      return;
    }

    const messageID = messageIdFromInfo(next);
    if (!messageID) return;

    const nextSession = await revertSession(c, sessionID, messageID);
    upsertLocalSession(nextSession);

    let prior: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = messageIdFromInfo(candidate);
      if (id && id < messageID) {
        prior = candidate;
        break;
      }
    }

    if (prior) {
      restorePromptFromUserMessage(prior);
      return;
    }

    setPrompt("");
  }

  async function renameSessionTitle(sessionID: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }
    
    await renameSession(sessionID, trimmed);
    await refreshSidebarWorkspaceSessions(workspaceStore.activeWorkspaceId()).catch(e => reportError(e, "sidebar.refreshSessions"));
  }

  async function deleteSessionById(sessionID: string, workspaceID?: string) {
    const trimmed = sessionID.trim();
    if (!trimmed) return;
    const c = routedClient();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const workspaceId = (workspaceID ?? "").trim();
    const workspace = workspaceId
      ? workspaceStore.workspaces().find((item) => item.id === workspaceId)
      : null;
    const workspaceRoot = workspace
      ? workspace.workspaceType === "local"
        ? workspace.path?.trim() ?? ""
        : workspace.directory?.trim() ?? ""
      : workspaceStore.activeWorkspaceRoot().trim();

    // Session may have been moved to a different directory via chooseFolderForCurrentSession.
    // Use the override directory so the engine deletes from the correct .opencode/sessions/.
    const overrideDir = sessionDirectoryOverrideById()[trimmed] ?? "";
    const root = normalizeDirectoryPath(overrideDir) || workspaceRoot;

    const params = root ? { sessionID: trimmed, directory: root } : { sessionID: trimmed };
    unwrap(await c.session.delete(params));

    // Remove the deleted session from the store and sidebar locally.
    // SSE will handle any further sync — calling loadSessions/refreshSidebarWorkspaceSessions
    // here races with SSE and can wipe unrelated sessions from the store.
    persistSessionDirectoryOverride(trimmed, null);
    setSessions(sessions().filter((s) => s.id !== trimmed));
    setComposerDraftBySessionId((current) => deleteSessionComposerDraft(current, trimmed));
    const sidebarWorkspaceId = workspace?.id ?? workspaceStore.activeWorkspaceId();
    removeSessionFromWorkspaceSidebar(sidebarWorkspaceId, trimmed);

    // If we're currently routed to the deleted session, navigate away immediately.
    // (Otherwise the route effect can try to re-select a session that no longer exists.)
    try {
      const path = location.pathname.toLowerCase();
      if (path === `/session/${trimmed.toLowerCase()}`) {
        navigate("/session", { replace: true });
      }
    } catch {
      // ignore
    }

    // If the deleted session was selected, clear selection so routing can fall back cleanly.
    if (selectedSessionId() === trimmed) {
      setSelectedSessionId(null);
      const activeWorkspace = workspaceStore.activeWorkspaceId().trim();
      if (activeWorkspace) {
        clearWorkspaceLastSessionIfSelected(activeWorkspace, trimmed);
      }
    }

    const nextStatus = { ...sessionStatusById() };
    if (nextStatus[trimmed]) {
      delete nextStatus[trimmed];
      setSessionStatusById(nextStatus);
    }
  }


  async function listAgents(): Promise<Agent[]> {
    const c = routedClient();
    if (!c) return [];
    const list = unwrap(await c.app.agents());
    return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  }

  const BUILTIN_COMPACT_COMMAND = {
    id: "builtin:compact",
    name: "compact",
    description: t("commands.compact_description", currentLocale()),
    source: "command" as const,
  };

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

  async function listCommands(): Promise<{ id: string; name: string; description?: string; source?: "command" | "mcp" | "skill" }[]> {
    const c = routedClient();
    if (!c) return [];
    const list = await listCommandsTyped(c, workspaceStore.activeWorkspaceRoot().trim() || undefined);
    if (list.some((entry) => entry.name === "compact")) {
      return list;
    }
    return [BUILTIN_COMPACT_COMMAND, ...list];
  }

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

  async function saveSessionExport(sessionID: string) {
    const c = routedClient();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const session = unwrap(await c.session.get({ sessionID }));
    const messages = unwrap(await c.session.messages({ sessionID }));
    let todos: TodoItem[] = [];
    try {
      todos = normalizeTodoItems(unwrap(await c.session.todo({ sessionID })));
    } catch {
      // ignore
    }

    const payload = {
      session,
      messages,
      todos,
      exportedAt: new Date().toISOString(),
      source: "veslo",
    };

    const baseName = session.title || session.slug || session.id;
    const safeName = baseName
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const fileName = `session-${safeName || session.id}.json`;
    return downloadSessionExport(payload, fileName);
  }

  function downloadSessionExport(payload: unknown, fileName: string) {
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return fileName;
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
  const mcpRuntimeStatusRefreshInFlightByKey = new Map<string, Promise<void>>();
  const [mcpConnectingName, setMcpConnectingName] = createSignal<string | null>(null);
  const [selectedMcp, setSelectedMcp] = createSignal<string | null>(null);
  const [automationItems, setAutomationItems] = createSignal<WorkspaceAutomationItem[]>([]);
  const [automationWorkspaces, setAutomationWorkspaces] = createSignal<AutomationWorkspaceSummary[]>([]);
  const [scheduledJobs, setScheduledJobs] = createSignal<ScheduledJob[]>([]);
  const [scheduledJobsStatus, setScheduledJobsStatus] = createSignal<string | null>(null);
  const [scheduledJobsBusy, setScheduledJobsBusy] = createSignal(false);
  const [scheduledJobsUpdatedAt, setScheduledJobsUpdatedAt] = createSignal<number | null>(null);
  const [soulStatusByWorkspaceId, setSoulStatusByWorkspaceId] = createSignal<
    Record<string, VesloSoulStatus | null>
  >({});
  const [soulOverview, setSoulOverview] = createSignal<VesloSoulOverviewResponse | null>(null);
  const [soulOverviewError, setSoulOverviewError] = createSignal<string | null>(null);
  const [soulOverviewBusy, setSoulOverviewBusy] = createSignal(false);
  const [activeSoulHeartbeats, setActiveSoulHeartbeats] = createSignal<VesloSoulHeartbeatEntry[]>([]);
  const [soulStatusBusy, setSoulStatusBusy] = createSignal(false);
  const [soulHeartbeatsBusy, setSoulHeartbeatsBusy] = createSignal(false);
  const [soulError, setSoulError] = createSignal<string | null>(null);

  // MCP OAuth modal state
  const [mcpAuthModalOpen, setMcpAuthModalOpen] = createSignal(false);
  const [mcpAuthEntry, setMcpAuthEntry] = createSignal<McpDirectoryInfo | null>(null);
  const [mcpAuthNeedsReload, setMcpAuthNeedsReload] = createSignal(false);
  let resolveSessionCapabilitySkillInventoryWorkspaces: () => { id: string; label: string; path: string }[] = () => [];

  const extensionsStore = createExtensionsStore({
    client,
    routing: workspaceRouting,
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
  const [managedAiAccess, setManagedAiAccess] = createSignal<ManagedAiAccessProfile | null>(null);
  const [managedAiGatewayAccessToken, setManagedAiGatewayAccessToken] = createSignal("");
  const [managedAiAccessBusy, setManagedAiAccessBusy] = createSignal(false);
  const [managedAiAccessError, setManagedAiAccessError] = createSignal<string | null>(null);
  const [denAuthRevision, setDenAuthRevision] = createSignal(0);
  const [managedAiAccessRefreshNonce, setManagedAiAccessRefreshNonce] = createSignal(0);
  const [managedAiAccessRetryAttempt, setManagedAiAccessRetryAttempt] = createSignal(0);
  const [managedAiBootstrapPendingCount, setManagedAiBootstrapPendingCount] = createSignal(0);
  const managedAiAccessModel = createMemo(() => managedAiAccess()?.defaultModel ?? null);
  let lastManagedAiAccessResetKey = "";
  // When the managed AI profile changes (admin reassigns user, credential
  // is rotated, etc.) we need to re-apply config on the next workspace patch.
  // Do this by semantic value, not object identity: the access bundle can be
  // refreshed/recreated during polling without changing the effective profile.
  createEffect(() => {
    const nextKey = JSON.stringify(managedAiAccess() ?? null);
    if (nextKey === lastManagedAiAccessResetKey) return;
    lastManagedAiAccessResetKey = nextKey;
    setLastManagedAiConfigAppliedForServerToken("");
    lastKnownConfigSnapshotByWs.clear();
    inactiveWorkspaceBaseUrlHealedFor.clear();
  });
  const managedAiBootstrapBusy = createMemo(
    () => managedAiAccessBusy() || managedAiBootstrapPendingCount() > 0,
  );
  const requestManagedAiAccessRefresh = () => {
    setManagedAiAccessRefreshNonce((value) => value + 1);
  };
  const logoutLocalDenAuth = async () => {
    clearDenAuth();
    clearManagedAiAccessCache();
    setOnboardingStep("auth");
    setView("onboarding");
    await flushPendingDesktopSnapshotWrite();
    requestManagedAiAccessRefresh();
  };
  const denGatewayAccessToken = createMemo(() => {
    denAuthRevision();
    return readDenAuth()?.token?.trim() ?? "";
  });
  const managedAiAccessCacheContext = createMemo(() => {
    denAuthRevision();
    const gatewayClient = gatewayVesloServerClient();
    const managedAiBaseUrl = managedAiGatewayBaseUrl();
    const denAuth = readDenAuth();
    const gatewayBaseUrl = managedAiBaseUrl || (isTauriRuntime() ? denAuth?.denApiBase ?? "" : "") || gatewayClient?.baseUrl || "";
    return {
      cacheKey: buildManagedAiAccessCacheKey({
        userId: denAuth?.user?.id,
        orgId: denAuth?.orgId || denAuth?.org?.id,
        gatewayBaseUrl,
      }),
      userId: denAuth?.user?.id?.trim() ?? "",
      gatewayBaseUrl,
    };
  });
  const [managedAiAccessProofCacheState, setManagedAiAccessProofCacheState] =
    createSignal<ManagedAiAccessProofCacheState>({
      cacheKey: "",
      loaded: true,
      record: null,
    });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    const context = managedAiAccessCacheContext();
    const cacheKey = context.cacheKey.trim();
    const userId = context.userId.trim();
    if (!cacheKey || !userId) {
      setManagedAiAccessProofCacheState({ cacheKey, loaded: true, record: null });
      return;
    }
    const currentState = untrack(managedAiAccessProofCacheState);
    if (currentState.cacheKey === cacheKey && currentState.loaded) return;

    let cancelled = false;
    setManagedAiAccessProofCacheState({ cacheKey, loaded: false, record: null });
    void readManagedAiAccessProofCache(cacheKey, userId)
      .then((record) => {
        if (cancelled) return;
        setManagedAiAccessProofCacheState({ cacheKey, loaded: true, record });
      })
      .catch(() => {
        if (cancelled) return;
        setManagedAiAccessProofCacheState({ cacheKey, loaded: true, record: null });
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  const getConfigSnapshot = (content: string | null) => {
    if (!content?.trim()) return "";
    try {
      const parsed = parse(content) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const copy = { ...parsed };
        delete copy.model;
        return JSON.stringify(copy);
      }
      return content;
    } catch {
      return content;
    }
  };

  const beginManagedAiBootstrap = () => {
    let released = false;
    setManagedAiBootstrapPendingCount((count) => count + 1);
    return () => {
      if (released) return;
      released = true;
      setManagedAiBootstrapPendingCount((count) => Math.max(0, count - 1));
    };
  };

  const hasUsableManagedAiRuntimeConfigForSend = async (): Promise<boolean> => {
    if (!isTauriRuntime()) return false;
    const workspace = workspaceStore.activeWorkspaceDisplay();
    if (workspace.workspaceType !== "local") return false;

    const providerRoutingLocalHost = activeVesloServerHostInfo();
    const providerRoutingLocalBaseUrl =
      providerRoutingLocalHost?.baseUrl ?? deriveLocalVesloServerUrlFromOpencodeBaseUrl(baseUrl()) ?? "";
    const providerRoutingEngineBaseUrl =
      providerRoutingLocalHost?.engineUrl ?? providerRoutingLocalBaseUrl;
    const gatewayClient = gatewayVesloServerClient();
    const providerRoutingTarget = resolveManagedAiProviderRoutingTarget({
      isDesktopRuntime: isTauriRuntime(),
      workspaceType: workspace.workspaceType,
      activeBaseUrl: providerRoutingLocalBaseUrl,
      engineBaseUrl: providerRoutingEngineBaseUrl,
      activeToken: providerRoutingLocalHost?.clientToken ?? "",
      gatewayBaseUrl: gatewayClient?.baseUrl ?? "",
      gatewayToken: gatewayClient?.token ?? "",
    });
    if (!providerRoutingTarget?.serverClientToken) return false;

    const providerId = managedAiAccess()?.providerId ?? null;
    const vesloClient = vesloServerClient();
    const vesloWorkspaceId = vesloServerWorkspaceId();
    const vesloCapabilities = resolvedVesloCapabilities();
    const canUseVesloServer =
      vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.config?.read;

    try {
      if (canUseVesloServer) {
        const config = await vesloClient.getConfig(vesloWorkspaceId);
        return hasUsableManagedAiRuntimeConfig({
          content: JSON.stringify(config.opencode ?? {}, null, 2),
          providerId,
          gatewayBaseUrl: providerRoutingTarget.engineBaseUrl,
          serverClientToken: providerRoutingTarget.serverClientToken,
        });
      }

      const root = workspaceStore.activeWorkspacePath().trim();
      if (!root) return false;
      const configFile = await readOpencodeConfig("project", root);
      return hasUsableManagedAiRuntimeConfig({
        content: configFile.content,
        providerId,
        gatewayBaseUrl: providerRoutingTarget.engineBaseUrl,
        serverClientToken: providerRoutingTarget.serverClientToken,
      });
    } catch {
      return false;
    }
  };

  const sendRuntimeReadiness = createSendRuntimeReadiness<Client>({
    isTauriRuntime,
    activeWorkspaceDisplay: () => workspaceStore.activeWorkspaceDisplay(),
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    clientDirectory: () => clientDirectory(),
    workspaces: () => workspaceStore.workspaces(),
    routedClient,
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
    setEngineReady,
    populateSidebarFromDb: async (workspaceId: string, directory: string) => {
      // Set status to "loading" SYNCHRONOUSLY before any await, so the idle-loader
      // effect (line ~2964) doesn't fire and try to contact the engine API.
      markWorkspaceSidebarLoading(workspaceId);
      const result = await listConversationsFromVesloReadApi(workspaceId, directory);
      const { visible: items } = partitionVesloUtilitySessions(
        result.items.map(applyPendingInitialSessionTitle),
      );
      replaceWorkspaceSidebarSessions(workspaceId, items);
    },
    hydrateLatestSessionFromDb: async (workspaceId: string, directory: string) => {
      const result = await listConversationsFromVesloReadApi(workspaceId, directory);
      if (result.items.length === 0) return;
      const latest = result.items[0];
      if (!latest) return;
      const snapshot = await getTranscriptFromVesloReadApi(workspaceId, latest.id, 50, directory);
      if (!snapshot) return;
      // Only populate the cache — don't change selectedSessionId.
      // The route effect and selectSession will pick the correct session
      // when the user clicks. Changing selectedSessionId here interfered
      // with the user's session selection and caused race conditions.
      sessionStore.hydrateTranscriptSnapshot(snapshot);
    },
  });
  workspaceStoreRef = workspaceStore;

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
    createEmptyComposerDraft,
    pendingSessionDraftsList,
    pendingSessionDraftsGet,
    pendingSessionDraftsPut,
    pendingSessionDraftsDelete,
    formatPendingDraftAttachmentRestoreError: pendingSessionDraftController.formatPendingDraftAttachmentRestoreError,
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
      activateWorkspace: (workspaceId, options) => workspaceStore.activateWorkspace(workspaceId, options),
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
    activateWorkspace: (workspaceId, options) => workspaceStore.activateWorkspace(workspaceId, options),
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

  // VSLO-171 — per-workspace pending permissions polling is scheduled outside
  // the component body so the single-client SSE skip is shared and testable.
  createPermissionPollingScheduler({
    routedWorkspaceCount: () => workspaceRouting.entryIds().length,
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId().trim() || null,
    activeSendTraceId: () => activeSendTraceId() ?? null,
    engineReady: () => engineReady(),
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
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
    selectedSessionId,
    resolveSelectedSessionBrowseScope,
    saveWorkspaceSnapshot: (workspaceId) => sessionStore.saveWorkspaceSnapshot(workspaceId),
    loadWorkspaceSnapshot: (workspaceId) => sessionStore.loadWorkspaceSnapshot(workspaceId),
    clearSelectedSession: () => {
      wsDebug("snapshot:clearSelectedSession:app", {
        selectedSessionId: selectedSessionId(),
        activeWorkspaceId: workspaceStore.activeWorkspaceId(),
        route: location.pathname,
      });
      setSelectedSessionId(null);
      if (location.pathname.toLowerCase().startsWith("/session/")) {
        navigate("/session", { replace: true });
      }
    },
    debug: wsDebug,
  });

  type PendingSkillRegistryReplay = {
    eventId: string;
  };

  const skillRegistryReloadTriggerForEvent = (event: {
    skillId?: string | null;
    installationId?: string | null;
  }): ReloadTrigger => ({
    type: "skill",
    action: "updated",
    name: event.skillId ?? event.installationId ?? undefined,
  });

  const shouldRefreshAfterSkillRegistryMaterialization = (result: {
    synced?: boolean;
    reloadRequired?: boolean;
  }) => result.synced === true || result.reloadRequired === true;

  const refreshAfterSkillRegistryMaterialization = async (result: {
    synced?: boolean;
    reloadRequired?: boolean;
  }) => {
    if (!shouldRefreshAfterSkillRegistryMaterialization(result)) return;
    await refreshSkills({ force: true });
    await extensionsStore.invalidateSkillRegistryInventory();
  };

  const skillRegistryMaterializationAuthContext = () => {
    denAuthRevision();
    const auth = readDenAuth();
    return {
      denApiBase: auth?.denApiBase?.trim() || undefined,
      denToken: auth?.token?.trim() || undefined,
      denOrgId: auth?.orgId?.trim() || undefined,
      denUserId: auth?.user?.id?.trim() || undefined,
    };
  };

  const [pendingSkillRegistryWorkspaceReplays, setPendingSkillRegistryWorkspaceReplays] = createSignal<
    Record<string, PendingSkillRegistryReplay>
  >({});
  const [pendingGlobalSkillRegistryReplay, setPendingGlobalSkillRegistryReplay] =
    createSignal<PendingSkillRegistryReplay | null>(null);
  const skillRegistryWorkspaceReplayInFlight = new Set<string>();
  let skillRegistryGlobalReplayInFlight = false;

  const queuePendingSkillRegistryWorkspaceReplay = (workspaceId: string, eventId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setPendingSkillRegistryWorkspaceReplays((current) => ({
      ...current,
      [id]: { eventId },
    }));
  };

  const clearPendingSkillRegistryWorkspaceReplay = (workspaceId: string, eventId: string) => {
    setPendingSkillRegistryWorkspaceReplays((current) => {
      if (current[workspaceId]?.eventId !== eventId) return current;
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
  };

  const replayPendingSkillRegistryWorkspaceUpdate = (
    client: VesloServerClient,
    workspaceId: string,
    pending: PendingSkillRegistryReplay,
  ) => {
    if (skillRegistryWorkspaceReplayInFlight.has(workspaceId)) return;
    skillRegistryWorkspaceReplayInFlight.add(workspaceId);
    void (async () => {
      try {
        const result = await client.syncWorkspaceSkillMaterialization(
          workspaceId,
          skillRegistryMaterializationAuthContext(),
        );
        await refreshAfterSkillRegistryMaterialization(result);
        clearPendingSkillRegistryWorkspaceReplay(workspaceId, pending.eventId);
      } catch (error) {
        reportError(error, "skills.registry.workspace.replay");
      } finally {
        skillRegistryWorkspaceReplayInFlight.delete(workspaceId);
      }
    })();
  };

  const replayPendingGlobalSkillRegistryUpdate = (client: VesloServerClient, pending: PendingSkillRegistryReplay) => {
    if (skillRegistryGlobalReplayInFlight) return;
    skillRegistryGlobalReplayInFlight = true;
    void (async () => {
      try {
        const result = await client.syncGlobalSkillMaterialization(skillRegistryMaterializationAuthContext());
        await refreshAfterSkillRegistryMaterialization(result);
        setPendingGlobalSkillRegistryReplay((current) =>
          current?.eventId === pending.eventId ? null : current,
        );
      } catch (error) {
        reportError(error, "skills.registry.global.replay");
      } finally {
        skillRegistryGlobalReplayInFlight = false;
      }
    })();
  };

  createEffect(() => {
    const client = vesloServerClient();
    const status = vesloServerStatus();
    const busyWorkspaces = workspaceStore.workspaceBusy();
    const workspaceReplays = pendingSkillRegistryWorkspaceReplays();
    const globalReplay = pendingGlobalSkillRegistryReplay();
    skillRegistryMaterializationAuthContext();
    if (!client || status !== "connected") return;

    for (const [workspaceId, pending] of Object.entries(workspaceReplays)) {
      if (busyWorkspaces[workspaceId]) continue;
      replayPendingSkillRegistryWorkspaceUpdate(client, workspaceId, pending);
    }

    const hasActiveRun = Object.values(workspaceStore.workspaceBusy()).some(Boolean);
    if (globalReplay && !hasActiveRun) {
      replayPendingGlobalSkillRegistryUpdate(client, globalReplay);
    }
  });

  let skillRegistryEventsKey = "";
  createEffect(() => {
    denAuthRevision();
    const client = vesloServerClient();
    const auth = readDenAuth();
    const orgId = auth?.orgId?.trim() ?? "";
    const baseUrl = client?.baseUrl?.trim() ?? "";
    const workspaceId = workspaceStore.activeWorkspaceId().trim();
    const token = client?.token?.trim() ?? "";
    const status = vesloServerStatus();
    const nextKey = JSON.stringify({ baseUrl, orgId, token: token ? "set" : "none", workspaceId, status });
    if (nextKey === skillRegistryEventsKey) return;
    skillRegistryEventsKey = nextKey;

    if (!client || status !== "connected") return;

    const listener = createSkillRegistryEventsListener({
      registryBaseUrl: client.baseUrl,
      token: client.token,
      orgId,
      workspaceId: workspaceId || undefined,
      getActiveWorkspaceId: () => workspaceStore.activeWorkspaceId(),
      onInventoryInvalidated: () =>
        extensionsStore.invalidateSkillRegistryInventory().catch(e => reportError(e, "skills.registry.invalidate")),
      onWorkspaceUpdatePending: async (update) => {
        const trigger = skillRegistryReloadTriggerForEvent(update.event);
        if (workspaceStore.workspaceBusy()[update.workspaceId]) {
          await client.syncWorkspaceSkillMaterialization(update.workspaceId, {
            ...skillRegistryMaterializationAuthContext(),
            activeRun: true,
          });
          markReloadRequired("skills", trigger);
          queuePendingSkillRegistryWorkspaceReplay(update.workspaceId, update.event.id);
          return;
        }
        const result = await client.syncWorkspaceSkillMaterialization(
          update.workspaceId,
          skillRegistryMaterializationAuthContext(),
        );
        await refreshAfterSkillRegistryMaterialization(result);
      },
      onIdleWorkspaceUpdate: async (update) => {
        const result = await client.syncWorkspaceSkillMaterialization(
          update.workspaceId,
          skillRegistryMaterializationAuthContext(),
        );
        await refreshAfterSkillRegistryMaterialization(result);
      },
      onGlobalUpdate: async (update) => {
        const hasActiveRun = Object.values(workspaceStore.workspaceBusy()).some(Boolean);
        if (hasActiveRun) {
          await client.syncGlobalSkillMaterialization({
            ...skillRegistryMaterializationAuthContext(),
            activeRun: true,
          });
          markReloadRequired("skills", skillRegistryReloadTriggerForEvent(update.event));
          setPendingGlobalSkillRegistryReplay({ eventId: update.event.id });
          return;
        }
        const result = await client.syncGlobalSkillMaterialization(skillRegistryMaterializationAuthContext());
        await refreshAfterSkillRegistryMaterialization(result);
      },
      onError: (error) => reportError(error, "skills.registry.events"),
    });

    listener.start();
    onCleanup(() => listener.stop());
  });

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

  const sidebarWorkspaceSessions = createSidebarWorkspaceSessions({
    workspaceStore,
    workspaceRouting,
    engineReady: () => engineReady(),
    developerMode: () => developerMode(),
    sessions: () => sessions(),
    sessionDirectoryOverrideById,
    resolveSessionDirectory,
    applySessionDirectoryOverride,
    applyPendingInitialSessionTitle,
    listConversationsFromVesloReadApi,
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
    replaceWorkspaceSidebarSessions,
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

  const handleActivateWorkspace: typeof workspaceStore.activateWorkspace = (workspaceId, options) => {
    if (typeof workspaceId === "string") {
      clearStaleWorkspaceSessionError(workspaceId);
    }
    return workspaceStore.activateWorkspace(workspaceId, options);
  };

  createEffect(() => {
    const liveIds = new Set(
      sidebarWorkspaceGroups().flatMap((group) => group.sessions.map((session) => session.id)),
    );
    setUnreadSessionIds((current) => pruneUnreadSessions(current, liveIds));
  });
  const SESSION_ARCHIVE_MIGRATION_KEY_PREFIX = "veslo.session-archives-cloud-migrated.v1:";

  const readLegacyArchivedSessionIds = () => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  const clearLegacyArchivedSessionIds = () => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY);
    } catch {
      // ignore
    }
  };

  const readArchiveMigrationDone = (accountId: string) => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}${accountId}`) === "true";
    } catch {
      return false;
    }
  };

  const writeArchiveMigrationDone = (accountId: string) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(`${SESSION_ARCHIVE_MIGRATION_KEY_PREFIX}${accountId}`, "true");
    } catch {
      // ignore
    }
  };

  const [sessionArchiveRecords, setSessionArchiveRecords] = createSignal<VesloSessionArchiveRecord[]>([]);
  const [sessionArchiveReady, setSessionArchiveReady] = createSignal(false);
  const [sessionArchivePendingIds, setSessionArchivePendingIds] = createSignal<Set<string>>(new Set());

  const applySessionArchiveRecords = (items: VesloSessionArchiveRecord[]) => {
    setSessionArchiveRecords(sortArchivedSessionsByRecency(items));
    setSessionArchiveReady(true);
  };

  const archivedSessionIds = createMemo(() => sessionArchiveRecords().map((record) => record.sessionId));
  const sessionArchives = createMemo(() =>
    sortArchivedSessionsByRecency(
      sessionArchiveRecords().map((record) => toSessionArchiveItem(record, workspaceStore.workspaces())),
    ),
  );

  const withPendingArchivedSession = async (sessionId: string, task: () => Promise<void>) => {
    const id = sessionId.trim();
    if (!id) return;
    if (sessionArchivePendingIds().has(id)) return;

    setSessionArchivePendingIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    try {
      await task();
    } finally {
      setSessionArchivePendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const loadSessionArchives = async () => {
    const client = vesloArchiveClient();
    const ownerKey = sessionArchiveOwnerKey();
    if (!client || !ownerKey) {
      setSessionArchiveRecords([]);
      setSessionArchiveReady(true);
      return;
    }

    const response = await client.listSessionArchives();
    applySessionArchiveRecords(response.items ?? []);
  };

  let lastSessionArchiveClientKey = "";
  let failedSessionArchiveClientKey = "";
  let sessionArchiveLoadInFlightKey = "";
  let lastSessionArchiveRetryCheckedAt: number | null = null;
  createEffect(() => {
    const client = vesloArchiveClient();
    const ownerKey = sessionArchiveOwnerKey();
    const archiveServerStatus = vesloServerStatus();
    const archiveServerCheckedAt = vesloServerCheckedAt();
    const key = client && ownerKey ? `${client.baseUrl}::${client.token ?? ""}::${ownerKey}` : "";
    const retryFailedSessionArchiveLoad =
      Boolean(key) &&
      failedSessionArchiveClientKey === key &&
      archiveServerStatus === "connected" &&
      archiveServerCheckedAt !== null &&
      archiveServerCheckedAt !== lastSessionArchiveRetryCheckedAt;

    if (key === lastSessionArchiveClientKey && !retryFailedSessionArchiveLoad) return;
    if (sessionArchiveLoadInFlightKey === key) return;

    lastSessionArchiveClientKey = key;
    if (retryFailedSessionArchiveLoad) {
      lastSessionArchiveRetryCheckedAt = archiveServerCheckedAt;
    } else {
      lastSessionArchiveRetryCheckedAt = null;
    }
    sessionArchiveLoadInFlightKey = key;
    setSessionArchiveReady(false);
    void loadSessionArchives()
      .then(() => {
        if (sessionArchiveLoadInFlightKey !== key) return;
        failedSessionArchiveClientKey = "";
        lastSessionArchiveRetryCheckedAt = null;
      })
      .catch((error) => {
        if (sessionArchiveLoadInFlightKey !== key) return;
        failedSessionArchiveClientKey = key;
        reportError(error, "sessionArchives.load");
        setSessionArchiveRecords([]);
        setSessionArchiveReady(true);
      })
      .finally(() => {
        if (sessionArchiveLoadInFlightKey === key) {
          sessionArchiveLoadInFlightKey = "";
        }
      });
  });

  let sessionArchiveMigrationRunning = false;
  createEffect(() => {
    const client = vesloArchiveClient();
    const ownerKey = sessionArchiveOwnerKey();
    const ready = sessionArchiveReady();
    const records = sessionArchiveRecords();
    const groups = sidebarWorkspaceGroups();

    if (!client || !ownerKey || !ready || sessionArchiveMigrationRunning) return;
    if (readArchiveMigrationDone(ownerKey)) return;

    const legacyIds = readLegacyArchivedSessionIds();
    if (legacyIds.length === 0) {
      writeArchiveMigrationDone(ownerKey);
      return;
    }

    if (records.length > 0) {
      clearLegacyArchivedSessionIds();
      writeArchiveMigrationDone(ownerKey);
      return;
    }

    const migrationRecords = buildLegacyArchiveMigration(legacyIds, groups);
    if (migrationRecords.length === 0) {
      const allGroupsSettled =
        groups.length > 0 && groups.every((group) => group.status === "ready" || group.status === "error");
      if (allGroupsSettled) {
        clearLegacyArchivedSessionIds();
        writeArchiveMigrationDone(ownerKey);
      }
      return;
    }

    sessionArchiveMigrationRunning = true;
    void (async () => {
      try {
        let latest: VesloSessionArchiveRecord[] = records;
        for (const record of migrationRecords) {
          const { sessionId, ...payload } = record;
          latest = (await client.putSessionArchive(sessionId, payload)).items ?? [];
        }
        applySessionArchiveRecords(latest);
        clearLegacyArchivedSessionIds();
        writeArchiveMigrationDone(ownerKey);
      } catch (error) {
        reportError(error, "sessionArchives.migrateLegacy");
      } finally {
        sessionArchiveMigrationRunning = false;
      }
    })();
  });

  const archiveSidebarSession = async (workspaceId: string, sessionId: string) => {
    const client = vesloArchiveClient();
    const ownerKey = sessionArchiveOwnerKey();
    if (!client || !ownerKey) {
      setError("A Veslo server connection or cloud sign-in is required to archive sessions.");
      return;
    }

    const group = sidebarWorkspaceGroups().find((entry) => entry.workspace.id === workspaceId) ?? null;
    const session = group?.sessions.find((entry) => entry.id === sessionId) ?? null;
    if (!group || !session) return;

    await withPendingArchivedSession(sessionId, async () => {
      const response = await client.putSessionArchive(
        sessionId,
        buildSessionArchiveSnapshot({ session, workspace: group.workspace }),
      );
      applySessionArchiveRecords(response.items ?? []);
      clearLegacyArchivedSessionIds();
      writeArchiveMigrationDone(ownerKey);
    });
  };

  const unarchiveSession = async (sessionId: string) => {
    const client = vesloArchiveClient();
    const ownerKey = sessionArchiveOwnerKey();
    if (!client || !ownerKey) {
      setError("A Veslo server connection or cloud sign-in is required to unarchive sessions.");
      return;
    }

    await withPendingArchivedSession(sessionId, async () => {
      const response = await client.deleteSessionArchive(sessionId);
      applySessionArchiveRecords(response.items ?? []);
      clearLegacyArchivedSessionIds();
      writeArchiveMigrationDone(ownerKey);
    });
  };

  type SidebarSubagentCandidate = {
    workspaceId: string;
    sessionId: string;
    parentSessionId: string;
    sessionTitle: string;
    parentSessionTitle: string;
  };

  const subagentCandidates = createMemo<SidebarSubagentCandidate[]>(() => {
    const candidates: SidebarSubagentCandidate[] = [];
    const seenSessionIds = new Set<string>();

    for (const group of sidebarWorkspaceGroups()) {
      const bySessionId = new Map(
        group.sessions.map((session) => [session.id, session] as const),
      );
      for (const session of group.sessions) {
        const parentSessionId = typeof session.parentID === "string" ? session.parentID.trim() : "";
        if (!parentSessionId || seenSessionIds.has(session.id)) continue;
        seenSessionIds.add(session.id);
        candidates.push({
          workspaceId: group.workspace.id,
          sessionId: session.id,
          parentSessionId,
          sessionTitle: session.title?.trim() ?? "",
          parentSessionTitle: bySessionId.get(parentSessionId)?.title?.trim() ?? "",
        });
      }
    }

    return candidates;
  });

  const nextSubagentOccurrenceIndex = (
    existingSessions: SubagentDecorationPersistentSession[],
    roleKey: string,
  ) => {
    const used = new Set<number>();
    for (const session of existingSessions) {
      if (session.roleKey !== roleKey) continue;
      if (Number.isFinite(session.occurrenceIndex) && session.occurrenceIndex > 0) {
        used.add(Math.floor(session.occurrenceIndex));
      }
    }
    let index = 1;
    while (used.has(index)) index += 1;
    return index;
  };

  const nextSubagentColor = (existingSessions: SubagentDecorationPersistentSession[]) => {
    const usedColors = new Set(
      existingSessions
        .map((session) => session.color?.trim() ?? "")
        .filter((color) => color.length > 0),
    );
    for (const color of SUBAGENT_DECORATION_PALETTE) {
      if (!usedColors.has(color)) return color;
    }
    let attempt = usedColors.size + 1;
    while (true) {
      const generated = `hsl(${(attempt * 47) % 360} 72% 46%)`;
      if (!usedColors.has(generated)) return generated;
      attempt += 1;
    }
  };

  const buildSubagentRoleEntry = (input: {
    locale: SubagentLocale;
    roleKey: string;
    roleLabel: string;
    aiFirstName: string;
    existingRole: SubagentDecorationPersistentRole | null;
    fallbackPrompt: string;
  }): SubagentDecorationPersistentRole => {
    const fallbackProfile = classifySubagentRoleDeterministic({
      locale: input.locale,
      prompt: input.fallbackPrompt,
    });
    const roleCatalogProfile = roleProfileFromRoleKey(input.roleKey, input.locale);
    const fallbackCs = roleCatalogProfile?.firstNameByLocale.cs ?? fallbackProfile.firstNameByLocale.cs;
    const fallbackEn = roleCatalogProfile?.firstNameByLocale.en ?? fallbackProfile.firstNameByLocale.en;

    const aiFirstName = input.aiFirstName.trim();
    const firstNameByLocale = input.existingRole?.firstNameByLocale ?? {
      cs: input.locale === "cs" ? (aiFirstName || fallbackCs) : fallbackCs,
      en: input.locale === "en" ? (aiFirstName || fallbackEn) : fallbackEn,
    };

    return {
      roleKey: input.roleKey,
      roleLabel: input.existingRole?.roleLabel?.trim() || input.roleLabel,
      firstNameByLocale: {
        cs: firstNameByLocale.cs.trim() || fallbackCs,
        en: firstNameByLocale.en.trim() || fallbackEn,
      },
    };
  };

  let subagentDecorationQueue = Promise.resolve();
  const pendingSubagentDecorationSessionIds = new Set<string>();

  const ensureSubagentDecorationForSession = async (candidate: SidebarSubagentCandidate) => {
    const locale = toSubagentLocale(currentLocale());
    const deterministic = classifySubagentRoleDeterministic({
      locale,
      prompt: `${candidate.sessionTitle}\n${candidate.parentSessionTitle}`,
    });

    const roleKey = normalizeSubagentRoleKey(deterministic.roleKey) ?? deterministic.roleKey;
    const roleProfile = roleProfileFromRoleKey(roleKey, locale);
    const roleLabel =
      deterministic.roleLabel?.trim() ||
      roleProfile?.roleLabel ||
      deterministic.roleLabel;
    const aiFirstName = deterministic.firstName;

    setSubagentDecorationsState((current) => {
      if (current.sessions.some((entry) => entry.sessionId === candidate.sessionId)) {
        return current;
      }

      const siblingSessions = current.sessions.filter((entry) =>
        entry.workspaceId === candidate.workspaceId &&
        entry.parentSessionId === candidate.parentSessionId
      );
      const existingRole = current.roles.find((entry) => entry.roleKey === roleKey) ?? null;
      const roleEntry = buildSubagentRoleEntry({
        locale,
        roleKey,
        roleLabel,
        aiFirstName,
        existingRole,
        fallbackPrompt: `${candidate.sessionTitle}\n${candidate.parentSessionTitle}`,
      });
      const roles = existingRole
        ? current.roles.map((entry) => (entry.roleKey === roleKey ? roleEntry : entry))
        : [...current.roles, roleEntry];

      const sessionEntry: SubagentDecorationPersistentSession = {
        sessionId: candidate.sessionId,
        workspaceId: candidate.workspaceId,
        parentSessionId: candidate.parentSessionId,
        roleKey,
        roleLabel,
        color: nextSubagentColor(siblingSessions),
        occurrenceIndex: nextSubagentOccurrenceIndex(siblingSessions, roleKey),
      };

      return {
        ...current,
        roles,
        sessions: [...current.sessions, sessionEntry],
      };
    });
  };

  createEffect(() => {
    if (!subagentDecorationsReady()) return;
    const knownDecoratedIds = new Set(
      subagentDecorationsState().sessions.map((entry) => entry.sessionId),
    );
    for (const candidate of subagentCandidates()) {
      if (knownDecoratedIds.has(candidate.sessionId)) continue;
      if (pendingSubagentDecorationSessionIds.has(candidate.sessionId)) continue;

      pendingSubagentDecorationSessionIds.add(candidate.sessionId);
      subagentDecorationQueue = subagentDecorationQueue
        .then(async () => {
          await ensureSubagentDecorationForSession(candidate);
        })
        .catch(() => {})
        .finally(() => {
          pendingSubagentDecorationSessionIds.delete(candidate.sessionId);
        });
    }
  });

  const subagentDecorationsBySessionId = createMemo<Record<string, SidebarSubagentDecoration>>(() => {
    if (!subagentDecorationsReady()) return {};
    const locale = normalizeSubagentLocale(toSubagentLocale(currentLocale())) ?? "en";
    const state = subagentDecorationsState();
    const visibleSubagentIds = new Set(subagentCandidates().map((candidate) => candidate.sessionId));
    if (visibleSubagentIds.size === 0) return {};

    const model = buildSubagentDecorationModel({
      locale,
      roles: state.roles,
      sessions: state.sessions.map((entry) => ({
        sessionId: entry.sessionId,
        parentSessionId: `${entry.workspaceId}:${entry.parentSessionId}`,
        roleKey: entry.roleKey,
        roleLabel: entry.roleLabel,
        color: entry.color,
        occurrenceIndex: entry.occurrenceIndex,
      })),
    });

    const map: Record<string, SidebarSubagentDecoration> = {};
    for (const item of model.decorations) {
      if (!visibleSubagentIds.has(item.sessionId)) continue;
      map[item.sessionId] = {
        label: item.displayName,
        color: item.color,
      };
    }
    return map;
  });

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
    if (!sessionsLoaded()) return;
    if (creatingSession()) return;
    if (selectedSessionId()) return;

    // Keep /session as a draft-ready empty state until the user picks a session
    // or sends a prompt. Avoid auto-selecting prior sessions on app launch.
    return;
  });

  let lastRouteClientResumeKey = "";
  let routeResumeSelectionAlreadyHandledForSession = "";
  const clearDisplayedSessionForBareRoute = () => {
    batch(() => {
      setSelectedSessionId(null);
      setMessages([]);
      setTodos([]);
    });
  };

  createEffect(() => {
    const rawPath = location.pathname.trim();
    const path = rawPath.toLowerCase();
    if (!path.startsWith("/session/")) return;

    const [, , sessionSegment] = rawPath.split("/");
    const id = (sessionSegment ?? "").trim();

    const routeBrowseScope = resolveSelectedSessionBrowseScope(id);
    const routeWorkspaceId = routeBrowseScope?.workspaceId?.trim() || undefined;
    const routeWorkspaceRoot =
      routeBrowseScope?.workspaceRoot?.trim() ||
      clientDirectory() ||
      workspaceStore.activeWorkspaceRoot().trim();
    const connectionKey = [
      id,
      routedClient(routeWorkspaceId) ? "live" : "offline",
      routeWorkspaceId ?? "",
      routeWorkspaceRoot,
      routeBrowseScope?.directory?.trim() || "",
      routeBrowseScope?.conversationId?.trim() || "",
      routeBrowseScope?.opencodeSessionId?.trim() || "",
      connectedVersion() ?? "",
    ].join("::");
    const routeResumeDecision = resolveRouteResumeDecision({
      path: rawPath,
      routeSessionId: id,
      isPendingSession: isPendingSessionInstanceId(id),
      routeWorkspaceId,
      activeWorkspaceId: workspaceStore.activeWorkspaceId().trim(),
      connectionKey,
      lastConnectionKey: lastRouteClientResumeKey,
      selectedSessionId: selectedSessionId(),
      hasBrowseScope: Boolean(routeBrowseScope),
      visibleMessageCount: visibleMessages().length,
      selectedSessionLoadingEarlierMessages: selectedSessionLoadingEarlierMessages(),
      ownNavigationSessionId: routeResumeSelectionAlreadyHandledForSession,
    });

    switch (routeResumeDecision.type) {
      case "ignore":
        if (routeResumeDecision.reason === "foreign-workspace") {
          lastRouteClientResumeKey = "";
        }
        if (routeResumeDecision.reason === "already-loaded") {
          lastRouteClientResumeKey = connectionKey;
        }
        return;
      case "consume-own-navigation":
        routeResumeSelectionAlreadyHandledForSession = "";
        lastRouteClientResumeKey = routeResumeDecision.connectionKey;
        return;
      case "select-session":
        lastRouteClientResumeKey = routeResumeDecision.connectionKey;
        void selectSession(routeResumeDecision.sessionId);
        return;
    }
  });

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
          const match = directoryHint
            ? items.find((entry) => {
                const entryPath = normalizeDirectoryPath((entry.opencode?.directory ?? entry.directory ?? entry.path ?? "").trim());
                return Boolean(entryPath && entryPath === directoryHint);
              })
            : (response.activeId ? items.find((entry) => entry.id === response.activeId) : null) ?? items[0];
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
      const root = normalizeDirectoryPath(workspaceStore.activeWorkspaceRoot().trim());
      if (!root) {
        setVesloServerWorkspaceId(null);
        return;
      }

      let cancelled = false;
      const resolveWorkspace = async () => {
        try {
          const response = await client.listWorkspaces();
          if (cancelled) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const match = items.find((entry) => {
            const candidates = [
              normalizeDirectoryPath(entry.path),
              normalizeDirectoryPath(entry.directory),
              normalizeDirectoryPath(entry.opencode?.directory),
            ].filter(Boolean);
            return candidates.includes(root);
          });
          setVesloServerWorkspaceId(match?.id ?? null);
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

    setVesloServerWorkspaceId(null);
  });

  const resolveSharedBundleWorkerTarget = () => {
    const pref = startupPreference();
    const hostInfo = activeVesloServerHostInfo();
    const settings = vesloServerSettings();

    const localHostUrl = normalizeVesloServerUrl(hostInfo?.baseUrl ?? "") ?? "";
    const localToken = hostInfo?.clientToken?.trim() ?? "";
    const serverHostUrl = normalizeVesloServerUrl(settings.urlOverride ?? "") ?? "";
    const serverToken = settings.token?.trim() ?? "";

    if (pref === "server") {
      return {
        hostUrl: serverHostUrl || localHostUrl,
        token: serverToken || localToken,
      };
    }

    if (pref === "local") {
      return {
        hostUrl: localHostUrl || serverHostUrl,
        token: localToken || serverToken,
      };
    }

    if (localHostUrl) {
      return {
        hostUrl: localHostUrl,
        token: localToken || serverToken,
      };
    }

    return {
      hostUrl: serverHostUrl,
      token: serverToken || localToken,
    };
  };

  const waitForSharedBundleImportTarget = async (timeoutMs = 20_000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const client = vesloServerClient();
      const workspaceId = vesloServerWorkspaceId();
      if (client && workspaceId && vesloServerStatus() === "connected") {
        return { client, workspaceId };
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 200);
      });
    }
    throw new Error("Veslo worker is not ready yet.");
  };

  const createWorkerForSharedBundle = async (request: SharedBundleDeepLink, bundle: SharedBundleV1) => {
    const target = resolveSharedBundleWorkerTarget();
    const hostUrl = target.hostUrl.trim();
    const token = target.token.trim();
    if (!hostUrl || !token) {
      throw new Error("Share link detected. Configure an Veslo worker host and token, then open the link again.");
    }

    const label = (request.label?.trim() || bundle.name?.trim() || "Shared setup").slice(0, 80);
    const ok = await workspaceStore.createRemoteWorkspaceFlow({
      vesloHostUrl: hostUrl,
      vesloToken: token,
      directory: null,
      displayName: label,
      manageBusy: false,
      closeModal: false,
    });

    if (!ok) {
      throw new Error("Failed to create a worker from this share link.");
    }
  };

  createEffect(() => {
    const request = pendingSharedBundleInvite();
    if (!request || booting()) {
      return;
    }

    if (sharedBundleImportBusy()) {
      return;
    }

    if (request.intent === "import_current") {
      const client = vesloServerClient();
      const workspaceId = vesloServerWorkspaceId();
      const connected = vesloServerStatus() === "connected";
      if (!client || !workspaceId || !connected) {
        if (!sharedBundleNoticeShown()) {
          setSharedBundleNoticeShown(true);
          setError("Share link detected. Connect to a writable Veslo worker to import this bundle.");
        }
        return;
      }
    } else {
      const target = resolveSharedBundleWorkerTarget();
      if (!target.hostUrl.trim() || !target.token.trim()) {
        if (!sharedBundleNoticeShown()) {
          setSharedBundleNoticeShown(true);
          setError("Share link detected. Configure an Veslo host and token to create a new worker.");
        }
        return;
      }
    }

    let cancelled = false;
    setSharedBundleImportBusy(true);

    void (async () => {
      try {
        const bundle = await fetchSharedBundle(request.bundleUrl);
        if (cancelled) return;

        if (request.intent === "new_worker") {
          await createWorkerForSharedBundle(request, bundle);
          if (cancelled) return;
        }

        const { client, workspaceId } = await waitForSharedBundleImportTarget();
        if (cancelled) return;

        const { payload, importedSkillsCount } = buildImportPayloadFromBundle(bundle);
        await client.importWorkspace(workspaceId, payload);
        await refreshSkills({ force: true });
        await refreshHubSkills({ force: true });
        setError(null);
        if (importedSkillsCount > 0) {
          console.log(`[veslo] imported ${importedSkillsCount} skills from share bundle`);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : safeStringify(error);
          setError(addOpencodeCacheHint(message));
        }
      } finally {
        if (!cancelled) {
          setSharedBundleImportBusy(false);
          setPendingSharedBundleInvite(null);
          setSharedBundleNoticeShown(false);
        }
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
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

  type SessionCapabilitiesLoadStatus = "idle" | "loading" | "ready" | "error";

  const [sessionCapabilitiesSnapshot, setSessionCapabilitiesSnapshot] =
    createSignal<SessionCapabilitiesSnapshot | null>(null);
  const [sessionCapabilitiesStatus, setSessionCapabilitiesStatus] =
    createSignal<SessionCapabilitiesLoadStatus>("idle");
  const [sessionCapabilitiesError, setSessionCapabilitiesError] = createSignal<string | null>(null);

  const normalizeCapabilityDirectoryForMatch = (value?: string | null) =>
    normalizeSessionCapabilityDirectory(normalizeDirectoryPath(value ?? ""));

  const workspaceLabelForSessionCapabilities = (workspace: WorkspaceInfo | null | undefined, fallback: string) =>
    workspace?.displayName?.trim() ||
    workspace?.name?.trim() ||
    workspace?.vesloWorkspaceName?.trim() ||
    workspace?.id ||
    fallback;

  const findWorkspaceForSessionCapabilityDirectory = (directory: string): WorkspaceInfo | null => {
    const normalizedDirectory = normalizeCapabilityDirectoryForMatch(directory);
    if (!normalizedDirectory) return null;

    return (
      workspaceStore
        .workspaces()
        .find((workspace) =>
          [workspace.path, workspace.directory]
            .map((candidate) => normalizeCapabilityDirectoryForMatch(candidate))
            .some((candidate) => candidate === normalizedDirectory),
        ) ?? null
    );
  };

  const selectedSessionCapabilitySource = createMemo(() =>
    resolveSessionCapabilitySessionSource({
      selectedSessionId: selectedSessionId(),
      selectedSession: selectedSession(),
      workspaceGroups: sidebarWorkspaceGroups(),
      resolveDirectory: (session) => resolveSessionDirectory({ id: session.id, directory: session.directory ?? "" }),
    }),
  );

  const selectedSessionCapabilityDirectory = createMemo(() => {
    const session = selectedSessionCapabilitySource()?.session;
    return session
      ? normalizeSessionCapabilityDirectory(resolveSessionDirectory({ id: session.id, directory: session.directory ?? "" }))
      : "";
  });

  const selectedSessionCapabilityWorkspace = createMemo(() =>
    selectedSessionCapabilitySource()?.workspace ??
    findWorkspaceForSessionCapabilityDirectory(selectedSessionCapabilityDirectory()),
  );

  const selectedSessionCapabilitiesScope = createMemo<SessionCapabilitiesScope | null>(() => {
    const session = selectedSessionCapabilitySource()?.session;
    if (!session) return null;

    const directory = selectedSessionCapabilityDirectory();
    const workspace = selectedSessionCapabilityWorkspace();
    return {
      directory,
      workspaceId: workspace?.id,
      workspaceLabel: workspaceLabelForSessionCapabilities(workspace, directory),
      workspaceType: workspace?.workspaceType,
    };
  });

  resolveSessionCapabilitySkillInventoryWorkspaces = () => {
    const directory = selectedSessionCapabilityDirectory();
    if (!directory) return [];
    const workspace = selectedSessionCapabilityWorkspace();
    if (workspace?.workspaceType === "remote") return [];
    return [{
      id: workspace?.id || `session:${directory}`,
      label: workspaceLabelForSessionCapabilities(workspace, directory),
      path: directory,
    }];
  };

  const filterSessionMcpStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
    const configured = new Set(entries.map((entry) => entry.name));
    return Object.fromEntries(Object.entries(status).filter(([name]) => configured.has(name))) as McpStatusMap;
  };

  const matchingRuntimeClientForSessionCapabilities = (directory: string, workspace: WorkspaceInfo | null) => {
    const runtimeClient = client();
    if (!runtimeClient) return null;

    const activeWorkspaceId = workspaceStore.activeWorkspaceId().trim();
    if (workspace?.id && activeWorkspaceId && workspace.id !== activeWorkspaceId) return null;

    if (workspace?.id && workspace.id === activeWorkspaceId) return runtimeClient;

    const active = workspaceStore.activeWorkspaceDisplay();
    const normalizedDirectory = normalizeCapabilityDirectoryForMatch(directory);
    const activeCandidates = [
      active.path,
      active.directory,
      workspaceStore.activeWorkspaceRoot(),
      workspaceProjectDir(),
    ].map((candidate) => normalizeCapabilityDirectoryForMatch(candidate));
    return activeCandidates.includes(normalizedDirectory) ? runtimeClient : null;
  };

  const runtimeMatchContextForSessionCapabilities = () => {
    const active = workspaceStore.activeWorkspaceDisplay();
    return {
      activeWorkspaceId: workspaceStore.activeWorkspaceId().trim(),
      activeWorkspacePath: normalizeCapabilityDirectoryForMatch(active.path),
      activeWorkspaceDirectory: normalizeCapabilityDirectoryForMatch(active.directory),
      activeWorkspaceRoot: normalizeCapabilityDirectoryForMatch(workspaceStore.activeWorkspaceRoot()),
      workspaceProjectDir: normalizeCapabilityDirectoryForMatch(workspaceProjectDir()),
    };
  };

  const loadSessionMcpStatuses = async (
    directory: string,
    entries: McpServerEntry[],
    workspace: WorkspaceInfo | null,
  ): Promise<McpStatusMap> => {
    if (!entries.length) return {};
    if (!engineReady()) return {};
    const runtimeClient = matchingRuntimeClientForSessionCapabilities(directory, workspace);
    if (!runtimeClient) return {};

    try {
      const status = unwrap(await runtimeClient.mcp.status({ directory }));
      return filterSessionMcpStatuses(status as McpStatusMap, entries);
    } catch {
      return {};
    }
  };

  const remoteWorkspaceContextForSessionCapabilities = (workspace: WorkspaceInfo | null) => {
    if (!workspace || workspace.workspaceType !== "remote" || workspace.remoteType !== "veslo") return null;
    const vesloClient = vesloServerClient();
    if (vesloServerStatus() !== "connected" || !vesloClient) return null;

    const activeWorkspaceId = workspaceStore.activeWorkspaceId().trim();
    const selectedHost = normalizeVesloServerUrl(workspace.vesloHostUrl ?? "") ?? "";
    const connectedHost = normalizeVesloServerUrl(vesloServerBaseUrl()) ?? "";
    if (selectedHost && connectedHost && selectedHost !== connectedHost && workspace.id !== activeWorkspaceId) {
      return null;
    }

    const inferredWorkspaceId =
      workspace.vesloWorkspaceId?.trim() ||
      parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
      parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
      (workspace.id === activeWorkspaceId ? vesloServerWorkspaceId()?.trim() ?? "" : "");
    if (!inferredWorkspaceId) return null;

    return { vesloClient, workspaceId: inferredWorkspaceId };
  };

  const loadLocalSessionCapabilities = async (
    scope: SessionCapabilitiesScope,
    workspace: WorkspaceInfo | null,
  ): Promise<Omit<SessionCapabilitiesSnapshot, "loadedAt">> => {
    const directory = scope.directory;
    const [mcpEntries] = await Promise.all([
      readEffectiveMcpServerEntries(directory),
      refreshSkillInventory(),
    ]);
    const inventory = filterSessionSkillInventoryByScope(skillInventory(), {
      directory,
      workspaceId: scope.workspaceId,
    });
    const statuses = await loadSessionMcpStatuses(directory, mcpEntries, workspace);
    return {
      directory,
      skills: buildSessionSkillRows(inventory),
      mcp: buildSessionMcpRows(mcpEntries, statuses),
    };
  };

  const loadRemoteSessionCapabilities = async (
    scope: SessionCapabilitiesScope,
    workspace: WorkspaceInfo,
  ): Promise<Omit<SessionCapabilitiesSnapshot, "loadedAt">> => {
    const directory = scope.directory;
    const remoteContext = remoteWorkspaceContextForSessionCapabilities(workspace);
    if (!remoteContext) {
      return { directory, skills: [], mcp: [] };
    }

    const [skillsResponse, mcpResponse] = await Promise.all([
      remoteContext.vesloClient.listSkills(remoteContext.workspaceId, { includeGlobal: true }),
      remoteContext.vesloClient.listMcp(remoteContext.workspaceId),
    ]);
    const skillItems = Array.isArray(skillsResponse.items) ? skillsResponse.items : [];
    const workspaceId = scope.workspaceId || workspace.id || directory;
    const workspaceLabel = scope.workspaceLabel || workspaceLabelForSessionCapabilities(workspace, directory);
    const workspaceSkillsByWorkspaceId: BuildSkillInventoryInput["workspaceSkillsByWorkspaceId"] = {
      [workspaceId]: {
        workspace: {
          id: workspaceId,
          label: workspaceLabel,
          path: directory,
          kind: "remote",
        },
        skills: skillItems
          .filter((entry) => entry.scope !== "global")
          .map((entry) => ({
            name: entry.name,
            path: entry.path,
            description: entry.description,
            trigger: entry.trigger,
          })),
      },
    };
    const inventory = buildSkillInventory({
      globalSkills: skillItems
        .filter((entry) => entry.scope === "global")
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          description: entry.description,
          trigger: entry.trigger,
        })),
      workspaceSkillsByWorkspaceId,
      hubSkills: [],
    });
    const mcpEntries: McpServerEntry[] = (Array.isArray(mcpResponse.items) ? mcpResponse.items : []).map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source,
      disabledByTools: entry.disabledByTools,
    }));
    const statuses = await loadSessionMcpStatuses(directory, mcpEntries, workspace);
    return {
      directory,
      skills: buildSessionSkillRows(inventory),
      mcp: buildSessionMcpRows(mcpEntries, statuses),
    };
  };

  const sessionCapabilitiesCache = createSessionCapabilitiesCache(async (scope) => {
    const workspace = findWorkspaceForSessionCapabilityDirectory(scope.directory);
    if (workspace?.workspaceType === "remote") {
      return loadRemoteSessionCapabilities(scope, workspace);
    }
    return loadLocalSessionCapabilities(scope, workspace);
  });
  const sessionCapabilitiesLoadContextByDirectory = new Map<string, string>();
  let sessionCapabilitiesRequestVersion = 0;

  const sessionSkillInventoryContextForCapabilities = (scope: SessionCapabilitiesScope) =>
    filterSessionSkillInventoryByScope(skillInventory(), scope)
      .flatMap((item) => [
        item.globalInstance?.id ?? "",
        ...item.workspaceInstances.map((instance) => instance.id),
      ])
      .filter(Boolean)
      .join("|");

  createEffect(() => {
    const scope = selectedSessionCapabilitiesScope();
    const workspace = selectedSessionCapabilityWorkspace();
    const serverCapabilities = resolvedVesloCapabilities();
    const loadContext = scope
      ? JSON.stringify({
          directory: scope.directory,
          workspaceId: scope.workspaceId ?? "",
          workspaceType: scope.workspaceType ?? "",
          remoteStatus: vesloServerStatus(),
          remoteBaseUrl: vesloServerBaseUrl(),
          remoteWorkspaceId: vesloServerWorkspaceId() ?? "",
          hasRemoteClient: Boolean(vesloServerClient()),
          remoteSkillsRead: Boolean(serverCapabilities?.skills?.read),
          remoteMcpRead: Boolean(serverCapabilities?.mcp?.read),
          runtimeBaseUrl: baseUrl().trim(),
          runtimeVersion: connectedVersion() ?? "",
          hasRuntimeClient: Boolean(client()),
          runtimeMatch: runtimeMatchContextForSessionCapabilities(),
          matchedWorkspaceId: workspace?.id ?? "",
          skillInventory: sessionSkillInventoryContextForCapabilities(scope),
        })
      : "";

    const requestVersion = ++sessionCapabilitiesRequestVersion;
    if (!scope) {
      setSessionCapabilitiesSnapshot(null);
      setSessionCapabilitiesStatus("idle");
      setSessionCapabilitiesError(null);
      return;
    }

    setSessionCapabilitiesStatus("loading");
    setSessionCapabilitiesError(null);

    const previousContext = scope.directory ? sessionCapabilitiesLoadContextByDirectory.get(scope.directory) : undefined;
    const force = previousContext !== undefined && previousContext !== loadContext;
    void sessionCapabilitiesCache
      .load(scope, { force })
      .then((snapshot) => {
        if (requestVersion !== sessionCapabilitiesRequestVersion) return;
        sessionCapabilitiesLoadContextByDirectory.set(snapshot.directory, loadContext);
        setSessionCapabilitiesSnapshot(snapshot);
        setSessionCapabilitiesStatus("ready");
        setSessionCapabilitiesError(null);
      })
      .catch((error) => {
        if (requestVersion !== sessionCapabilitiesRequestVersion) return;
        setSessionCapabilitiesSnapshot(null);
        setSessionCapabilitiesStatus("error");
        setSessionCapabilitiesError(error instanceof Error ? error.message : safeStringify(error));
      });
  });

  function updateVesloServerSettings(next: VesloServerSettings) {
    const stored = writeVesloServerSettings(next);
    setVesloServerSettings(stored);
  }

  const resetVesloServerSettings = () => {
    clearVesloServerSettings();
    setVesloServerSettings({});
  };

  const [editRemoteWorkspaceOpen, setEditRemoteWorkspaceOpen] = createSignal(false);
  const [editRemoteWorkspaceId, setEditRemoteWorkspaceId] = createSignal<string | null>(null);
  const [editRemoteWorkspaceError, setEditRemoteWorkspaceError] = createSignal<string | null>(null);
  const [deepLinkRemoteWorkspaceDefaults, setDeepLinkRemoteWorkspaceDefaults] = createSignal<RemoteWorkspaceDefaults | null>(null);
  const [pendingRemoteConnectDeepLink, setPendingRemoteConnectDeepLink] = createSignal<RemoteWorkspaceDefaults | null>(null);
  const [pendingSharedBundleInvite, setPendingSharedBundleInvite] = createSignal<SharedBundleDeepLink | null>(null);
  const [sharedBundleImportBusy, setSharedBundleImportBusy] = createSignal(false);
  const [sharedBundleNoticeShown, setSharedBundleNoticeShown] = createSignal(false);
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = createSignal(false);
  const [renameWorkspaceId, setRenameWorkspaceId] = createSignal<string | null>(null);
  const [renameWorkspaceName, setRenameWorkspaceName] = createSignal("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = createSignal(false);

  const queueRemoteConnectDeepLink = (rawUrl: string): boolean => {
    const parsed = parseRemoteConnectDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingRemoteConnectDeepLink(parsed);
    return true;
  };

  const queueSharedBundleDeepLink = (rawUrl: string): boolean => {
    const parsed = parseSharedBundleDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingSharedBundleInvite(parsed);
    setSharedBundleNoticeShown(false);
    return true;
  };

  const [authCompleteExchangeBusy, setAuthCompleteExchangeBusy] = createSignal(false);
  const [authenticatedUser, setAuthenticatedUser] = createSignal<string | null>(null);
  let desktopAuthStatusPollController: AbortController | null = null;
  let exchangedCodes = new Set<string>();

  const cancelDesktopAuthStatusPolling = () => {
    if (!desktopAuthStatusPollController) return;
    try {
      desktopAuthStatusPollController.abort();
    } catch {
      // ignore
    }
    desktopAuthStatusPollController = null;
  };

  const sleepDesktopAuthPoll = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };

      const cleanup = () => {
        window.clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
      };

      if (signal) {
        if (signal.aborted) {
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

  const finishDesktopBrowserAuth = (code: string, exchangeProof?: ReturnType<typeof readDesktopAuthExchangeProof>) => {
    if (authCompleteExchangeBusy()) {
      return;
    }
    if (exchangedCodes.has(code)) {
      return;
    }

    cancelDesktopAuthStatusPolling();
    setAuthCompleteExchangeBusy(true);
    setError(null);
    void exchangeHandoffCode(code, exchangeProof)
      .then(async (result) => {
        if (result.ok) {
          exchangedCodes.add(code);
          writeDenAuth(result.state);
          await flushPendingDesktopSnapshotWrite();
          clearDesktopAuthExchangeProof(exchangeProof?.sessionId);
          requestManagedAiAccessRefresh();
          setError(null);
          setOnboardingStep("connecting");
          setView("onboarding");
          setBooting(true);
          const rebootstrapTimeout = setTimeout(() => {
            console.warn("[boot] post-auth bootstrap timed out after 15s - forcing boot complete");
            setBooting(false);
          }, 15_000);
          void workspaceStore.bootstrapOnboarding().finally(() => {
            clearTimeout(rebootstrapTimeout);
            setBooting(false);
          });
          return;
        }

        console.error("[den-auth] exchange failed:", result.error);
        if (exchangeProof) {
          clearDesktopAuthExchangeProof(exchangeProof.sessionId);
        }
        setError(`Sign in failed: ${result.error}`);
        setOnboardingStep("auth");
        setView("onboarding");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : safeStringify(error);
        console.error("[den-auth] exchange failed:", message);
        if (exchangeProof) {
          clearDesktopAuthExchangeProof(exchangeProof.sessionId);
        }
        setError(`Sign in failed: ${message}`);
        setOnboardingStep("auth");
        setView("onboarding");
      })
      .finally(() => {
        setAuthCompleteExchangeBusy(false);
      });
  };

  const startDesktopAuthStatusPolling = (sessionId: string) => {
    const initialProof = readDesktopAuthExchangeProof(sessionId);
    if (!initialProof) {
      return;
    }

    cancelDesktopAuthStatusPolling();
    const controller = new AbortController();
    desktopAuthStatusPollController = controller;

    void (async () => {
      let consecutiveFailures = 0;

      while (!controller.signal.aborted) {
        const latestProof = readDesktopAuthExchangeProof(sessionId);
        if (!latestProof) {
          return;
        }

        if (authCompleteExchangeBusy()) {
          return;
        }

        const statusResult = await getDesktopBrowserAuthStatus(sessionId, controller.signal);
        if (controller.signal.aborted) {
          return;
        }

        if (!statusResult.ok) {
          if (statusResult.statusCode === 404) {
            return;
          }
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) {
            console.warn("[den-auth] desktop auth polling stopped after repeated failures:", statusResult.error);
            return;
          }
        } else {
          consecutiveFailures = 0;
          if (statusResult.status === "authorized" && statusResult.code) {
            finishDesktopBrowserAuth(statusResult.code, latestProof);
            return;
          }

          if (
            statusResult.status === "expired" ||
            statusResult.status === "cancelled" ||
            statusResult.status === "exchanged"
          ) {
            return;
          }
        }

        try {
          await sleepDesktopAuthPoll(1_250, controller.signal);
        } catch (error) {
          const name = error instanceof DOMException ? error.name : "";
          if (name === "AbortError") {
            return;
          }
          throw error;
        }
      }
    })().catch((error) => {
      if (controller.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[den-auth] desktop auth polling failed:", message);
    });
  };

  const openDesktopAuthUrl = async (url: string) => {
    if (isTauriRuntime()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const resumePendingDesktopBrowserAuth = async (reopenBrowser: boolean): Promise<boolean> => {
    const pending = readPendingDesktopAuthSession();
    if (!pending) {
      return false;
    }

    setError(null);
    startDesktopAuthStatusPolling(pending.sessionId);
    if (reopenBrowser && pending.authorizeUrl) {
      await openDesktopAuthUrl(pending.authorizeUrl);
    }
    return true;
  };

  const startDesktopBrowserSignIn = async () => {
    setError(null);
    if (await resumePendingDesktopBrowserAuth(true)) {
      return;
    }

    let url = `${getDenApiBase()}/?desktopOnboarding=1`;
    const startResult = await startDesktopBrowserAuth("signin");
    if (startResult.ok) {
      url = startResult.authorizeUrl;
      startDesktopAuthStatusPolling(startResult.sessionId);
    } else {
      console.warn("[den-auth] /start failed, falling back to legacy onboarding URL:", startResult.error);
    }
    await openDesktopAuthUrl(url);
  };

  const resumeDesktopBrowserSignIn = async () => {
    if (await resumePendingDesktopBrowserAuth(false)) {
      return;
    }
    await startDesktopBrowserSignIn();
  };

  const queueAuthCompleteDeepLink = (rawUrl: string): boolean => {
    const payload = parseAuthCompleteDeepLink(rawUrl);
    if (!payload) {
      return false;
    }

    if (authCompleteExchangeBusy()) {
      return true;
    }

    const exchangeProof = readDesktopAuthExchangeProof(payload.sessionId);
    finishDesktopBrowserAuth(payload.code, exchangeProof);

    return true;
  };

  onMount(() => {
    if (typeof window !== "undefined") {
      try {
        clearLegacySessionModelPersistence(window.localStorage);
      } catch {
        // ignore
      }
    }
  });

  onCleanup(() => {
    cancelDesktopAuthStatusPolling();
  });

  onMount(() => {
    const unsubscribe = subscribeDenAuthChanges(() => {
      setDenAuthRevision((value) => value + 1);
    });
    onCleanup(unsubscribe);
  });

  const resolveDenUserLabel = (auth: ReturnType<typeof readDenAuth>) => {
    return resolveAuthenticatedDenUserLabel(auth);
  };

  createEffect(() => {
    denAuthRevision();

    const auth = readDenAuth();
    setAuthenticatedUser(resolveDenUserLabel(auth));
    setAuthenticatedAccountId(auth?.user?.id?.trim() || null);
    if (!auth) return;

    const token = auth?.token?.trim() ?? "";
    const denApiBase = auth?.denApiBase?.trim() ?? "";
    if (!token || !denApiBase) return;
    if ((auth?.user?.name?.trim() ?? "") || (auth?.user?.email?.trim() ?? "")) return;

    let canceled = false;
    void (async () => {
      try {
        const response = await fetch(`${denApiBase.replace(/\/+$/, "")}/v1/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok || canceled) return;
        const payload = (await response.json()) as { user?: { id?: unknown; name?: unknown; email?: unknown } };
        const userId = typeof payload?.user?.id === "string" ? payload.user.id.trim() : "";
        if (!userId) return;
        const userName = typeof payload?.user?.name === "string" ? payload.user.name.trim() : "";
        const userEmail = typeof payload?.user?.email === "string" ? payload.user.email.trim() : "";
        if (canceled) return;
        setAuthenticatedUser(resolvePreferredDenUserLabel({
          id: userId,
          name: userName || undefined,
          email: userEmail || undefined,
        }));
        setAuthenticatedAccountId(userId);
        writeDenAuth({
          ...auth,
          user: {
            id: userId,
            name: userName || undefined,
            email: userEmail || undefined,
          },
        });
      } catch {
        // keep local value
      }
    })();

    onCleanup(() => {
      canceled = true;
    });
  });

  const managedAiAccessMessage = createMemo(() => {
    if (managedAiAccess()) return AI_ACCESS_ADMIN_MANAGED_MESSAGE;
    if (managedAiAccessBusy()) return AI_ACCESS_LOADING_MESSAGE;
    return managedAiAccessError() ?? AI_ACCESS_NOT_CONFIGURED_MESSAGE;
  });

  const managedAiAccessProviderLabel = createMemo(() => {
    const profile = managedAiAccess();
    if (!profile) return null;
    const provider = providers().find((entry) => entry.id === profile.providerId);
    return provider?.name ?? profile.providerId;
  });

  const managedAiAccessDefaultModelLabel = createMemo(() => {
    const profile = managedAiAccess();
    if (!profile) return null;
    return formatModelLabel(profile.defaultModel, providers());
  });

  const managedAiAccessBlockedReason = createMemo(() => {
    const userToken = denGatewayAccessToken();
    if (!userToken || !gatewayVesloServerClient()) {
      return null;
    }
    if (managedAiAccess()) return null;
    if (managedAiAccessBusy()) return AI_ACCESS_LOADING_MESSAGE;
    return managedAiAccessError() ?? AI_ACCESS_NOT_CONFIGURED_MESSAGE;
  });

  createEffect(() => {
    authenticatedUser();
    if (managedAiAccess()) return;

    const userToken = denGatewayAccessToken();
    const localAuth = vesloServerAuth();
    const hostInfo = activeVesloServerHostInfo();
    const workspace = workspaceStore.activeWorkspaceDisplay();

    if (
      !shouldEnsureManagedAiLocalGateway({
        isDesktopRuntime: isTauriRuntime(),
        workspaceType: workspace.workspaceType,
        userToken,
        localServerRunning: Boolean(hostInfo?.baseUrl?.trim()),
        localClientToken: localAuth.token,
      })
    ) {
      return;
    }

    let cancelled = false;
    void ensureLocalVesloServerRunning({ ignoreStartupPreference: true })
      .then((ok) => {
        if (!cancelled && ok) {
          requestManagedAiAccessRefresh();
        }
      })
      .catch((error) => {
        if (!cancelled) reportError(error, "managedAi.localGateway");
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    authenticatedUser();
    managedAiAccessRefreshNonce();

    const gatewayClient = gatewayVesloServerClient();
    const managedAiBaseUrl = managedAiGatewayBaseUrl();
    const userToken = denGatewayAccessToken();
    const cacheContext = managedAiAccessCacheContext();
    const managedAiCacheKey = cacheContext.cacheKey;
    const gatewayLocalAuth = vesloServerAuth();
    const proofCacheState = managedAiAccessProofCacheState();
    if (
      isTauriRuntime() &&
      managedAiCacheKey &&
      (!proofCacheState.loaded || proofCacheState.cacheKey !== managedAiCacheKey)
    ) {
      if (!managedAiAccess()) {
        setManagedAiAccessBusy(true);
      }
      return;
    }

    const proofCachedAccess =
      isTauriRuntime() && proofCacheState.cacheKey === managedAiCacheKey
        ? proofCacheState.record
        : null;
    const cachedAccess = proofCachedAccess ?? readManagedAiAccessCache(managedAiCacheKey);
    const refreshPreflight = resolveManagedAiAccessRefreshPreflight({
      hasGatewayClient: Boolean(gatewayClient),
      managedAiBaseUrl,
      userToken,
      deferForLocalGateway: shouldDeferManagedAiAccessRefresh({
        gatewayBaseUrl: managedAiBaseUrl || gatewayClient?.baseUrl || "",
        isDesktopRuntime: isTauriRuntime(),
        localClientToken: gatewayLocalAuth.token,
      }),
      cachedAccessPresent: Boolean(cachedAccess),
      freshCachedAccessPresent: Boolean(proofCachedAccess),
    });
    if (refreshPreflight.type === "reset") {
      setManagedAiAccess(null);
      setManagedAiGatewayAccessToken("");
      setManagedAiAccessBusy(false);
      setManagedAiAccessError(null);
      setManagedAiAccessRetryAttempt(0);
      return;
    }
    if (refreshPreflight.type === "use-cache") {
      if (cachedAccess) {
        setManagedAiAccess(cachedAccess.profile);
        setManagedAiGatewayAccessToken(cachedAccess.gatewayAccessToken);
        setManagedAiAccessError(null);
      }
      setManagedAiAccessBusy(false);
      setManagedAiAccessRetryAttempt(0);
      return;
    }

    let cancelled = false;
    let retryTimeoutId: number | null = null;
    if (refreshPreflight.applyCachedAccessFirst && cachedAccess) {
      setManagedAiAccess(cachedAccess.profile);
      setManagedAiGatewayAccessToken(cachedAccess.gatewayAccessToken);
      setManagedAiAccessError(null);
    }
    setManagedAiAccessBusy(true);
    setManagedAiAccessError(null);

    const scheduleRetry = (profilePresent: boolean) => {
      if (
        !shouldRetryManagedAiAccessRefresh({
          hasGatewayClient: true,
          userToken,
          profilePresent,
        })
      ) {
        setManagedAiAccessRetryAttempt(0);
        return;
      }

      const delayMs = resolveManagedAiAccessRetryDelayMs(managedAiAccessRetryAttempt());
      retryTimeoutId = window.setTimeout(() => {
        if (cancelled) return;
        setManagedAiAccessRetryAttempt((value) => value + 1);
        requestManagedAiAccessRefresh();
      }, delayMs);
    };

    const loadManagedAiAccess = loadManagedAiAccessSingleFlight(
      managedAiCacheKey,
      () =>
        managedAiBaseUrl
          ? requestManagedAiAccessBundle(managedAiBaseUrl, userToken)
          : gatewayClient!.getMyAiAccess(userToken),
    );

    void loadManagedAiAccess
      .then((response) => {
        if (cancelled) return;
        const { profile, gatewayAccessToken, reason } = resolveManagedAiAccessBundleState({
          aiAccess: response.aiAccess,
          accessToken: response.accessToken,
          fallbackAccessToken: userToken,
          requireGatewayAccessToken: Boolean(managedAiBaseUrl),
        });
        const successDecision = resolveManagedAiAccessRefreshSuccess({
          profile,
          gatewayAccessToken,
          reason,
        });
        if (successDecision.type === "apply-profile") {
          setManagedAiAccess(successDecision.profile);
          setManagedAiGatewayAccessToken(successDecision.gatewayAccessToken);
          setManagedAiAccessError(successDecision.error);
          writeManagedAiAccessCache(
            managedAiCacheKey,
            successDecision.profile,
            successDecision.gatewayAccessToken,
          );
          setManagedAiAccessRetryAttempt(0);
          return;
        }
        setManagedAiAccess(null);
        setManagedAiGatewayAccessToken(successDecision.gatewayAccessToken);
        setManagedAiAccessError(successDecision.error);
        clearManagedAiAccessCache(managedAiCacheKey);
        scheduleRetry(false);
      })
      .catch((error) => {
        if (cancelled) return;
        const failureDecision = resolveManagedAiAccessRefreshFailure({
          cachedAccessPresent: Boolean(cachedAccess),
          errorMessage: describeRequestError(error, "Failed to load AI access"),
        });
        if (failureDecision.clearProfile) {
          setManagedAiAccess(null);
        }
        if (failureDecision.gatewayAccessToken !== null) {
          setManagedAiGatewayAccessToken(failureDecision.gatewayAccessToken);
        }
        setManagedAiAccessError(failureDecision.error);
        scheduleRetry(false);
      })
      .finally(() => {
        if (cancelled) return;
        setManagedAiAccessBusy(false);
      });

    onCleanup(() => {
      cancelled = true;
      if (retryTimeoutId != null) {
        window.clearTimeout(retryTimeoutId);
      }
    });
  });

  createEffect(() => {
    authenticatedUser();

    if (typeof window === "undefined") return;
    const gatewayClient = gatewayVesloServerClient();
    const userToken = denGatewayAccessToken();
    if (!gatewayClient || !userToken) return;

    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      requestManagedAiAccessRefresh();
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);

    onCleanup(() => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    });
  });

  createEffect(() => {
    const pending = pendingRemoteConnectDeepLink();
    if (!pending || booting()) {
      return;
    }

    setView("dashboard");
    setTab("scheduled");
    setDeepLinkRemoteWorkspaceDefaults(pending);
    workspaceStore.setCreateRemoteWorkspaceOpen(true);
    setPendingRemoteConnectDeepLink(null);
  });

  createEffect(() => {
    if (workspaceStore.createRemoteWorkspaceOpen()) {
      return;
    }
    if (!deepLinkRemoteWorkspaceDefaults()) {
      return;
    }
    setDeepLinkRemoteWorkspaceDefaults(null);
  });

  const showRemoteActions = createMemo(() => isRemoteUiEnabled());
  const quickAddWorkerEnabled = createMemo(
    () => (CLOUD_ONLY_MODE || showRemoteActions()) && !isTauriRuntime(),
  );

  const openCreateRemoteWorkspace = () => {
    if (!quickAddWorkerEnabled()) {
      workspaceStore.setCreateRemoteWorkspaceOpen(true);
      return;
    }

    const target = resolveSharedBundleWorkerTarget();
    const hostUrl = normalizeVesloServerUrl(target.hostUrl ?? "") ?? "";
    const token = target.token?.trim() ?? "";
    const defaults: RemoteWorkspaceDefaults = {
      vesloHostUrl: hostUrl || null,
      vesloToken: token || null,
      directory: null,
      displayName: null,
    };

    const requiresToken = !CLOUD_ONLY_MODE;
    if (!hostUrl || (requiresToken && !token)) {
      setDeepLinkRemoteWorkspaceDefaults(defaults);
      workspaceStore.setCreateRemoteWorkspaceOpen(true);
      return;
    }

    void (async () => {
      const ok = await workspaceStore.createRemoteWorkspaceFlow({
        vesloHostUrl: hostUrl,
        vesloToken: token,
        directory: null,
        displayName: null,
      });
      if (ok) return;
      setDeepLinkRemoteWorkspaceDefaults(defaults);
      workspaceStore.setCreateRemoteWorkspaceOpen(true);
    })();
  };

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

  const testVesloServerConnection = async (next: VesloServerSettings) => {
    const derived = normalizeVesloServerUrl(next.urlOverride ?? "");
    if (!derived) {
      setVesloServerStatus("disconnected");
      setVesloServerCapabilities(null);
      setVesloServerCheckedAt(Date.now());
      return false;
    }
    const result = await checkVesloServer(derived, next.token, vesloServerAuth().hostToken);
    setVesloServerStatus(result.status);
    setVesloServerCapabilities(result.capabilities);
    setVesloServerCheckedAt(Date.now());
    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isTauriRuntime()) {
      const active = workspaceStore.activeWorkspaceDisplay();
      const shouldAttach = !routedClient() || active.workspaceType !== "remote" || active.remoteType !== "veslo";
      if (shouldAttach) {
        await workspaceStore
          .createRemoteWorkspaceFlow({
            vesloHostUrl: derived,
            vesloToken: next.token ?? null,
          })
          .catch(e => reportError(e, "workspace.createRemoteFlow"));
      }
    }
    return ok;
  };

  const reconnectVesloServer = async () => {
    if (vesloReconnectBusy()) return false;
    setVesloReconnectBusy(true);
    try {
      if (
        isTauriRuntime() &&
        startupPreference() !== "server" &&
        workspaceStore.activeWorkspaceDisplay().workspaceType === "local"
      ) {
        return await ensureLocalVesloServerRunning();
      }

      let hostInfo = vesloServerHostInfo();
      if (isTauriRuntime()) {
        try {
          hostInfo = await vesloServerInfo();
          setVesloServerHostInfo(hostInfo);
        } catch {
          hostInfo = null;
          setVesloServerHostInfo(null);
        }
      }

      // Repair stale local token state by syncing settings token from the live host.
      const runningHostInfo = resolveRunningVesloServerHostInfo(hostInfo);
      if (runningHostInfo?.clientToken?.trim() && startupPreference() !== "server") {
        const liveToken = runningHostInfo.clientToken.trim();
        const settings = vesloServerSettings();
        if ((settings.token?.trim() ?? "") !== liveToken) {
          updateVesloServerSettings({ ...settings, token: liveToken });
        }
      }

      const url = vesloServerBaseUrl().trim();
      const auth = vesloServerAuth();
      if (!url) {
        setVesloServerStatus("disconnected");
        setVesloServerCapabilities(null);
        setVesloServerCheckedAt(Date.now());
        return false;
      }

      const result = await checkVesloServer(url, auth.token, auth.hostToken);
      setVesloServerStatus(result.status);
      setVesloServerCapabilities(result.capabilities);
      setVesloServerCheckedAt(Date.now());
      return result.status === "connected" || result.status === "limited";
    } finally {
      setVesloReconnectBusy(false);
    }
  };

  let ensureLocalVesloServerRunningInFlight: Promise<boolean> | null = null;
  ensureLocalVesloServerRunning = async (options) => {
    if (!isTauriRuntime()) return false;
    if (!options?.ignoreStartupPreference && startupPreference() === "server") return false;
    if (workspaceStore.activeWorkspaceDisplay().workspaceType !== "local") return false;
    if (ensureLocalVesloServerRunningInFlight) {
      return ensureLocalVesloServerRunningInFlight;
    }

    ensureLocalVesloServerRunningInFlight = (async () => {
      let info: VesloServerInfo | null = null;
      try {
        info = await vesloServerInfo();
        setVesloServerHostInfo(info);
      } catch {
        setVesloServerHostInfo(null);
      }

      const liveInfo = resolveRunningVesloServerHostInfo(info);
      if (liveInfo?.baseUrl?.trim()) {
        const result = await checkVesloServer(
          liveInfo.baseUrl.trim(),
          liveInfo.clientToken?.trim() || undefined,
          liveInfo.hostToken?.trim() || undefined,
        );
        setVesloServerStatus(result.status);
        setVesloServerCapabilities(result.capabilities);
        setVesloServerCheckedAt(Date.now());
        if (result.status !== "disconnected") {
          return true;
        }
      }

      const restarted = await vesloServerRestart();
      setVesloServerHostInfo(restarted);
      const restartedInfo = resolveRunningVesloServerHostInfo(restarted);
      const baseUrl = restartedInfo?.baseUrl?.trim() ?? "";
      if (!baseUrl) {
        setVesloServerStatus("disconnected");
        setVesloServerCapabilities(null);
        setVesloServerCheckedAt(Date.now());
        return false;
      }

      const result = await checkVesloServer(
        baseUrl,
        restartedInfo?.clientToken?.trim() || undefined,
        restartedInfo?.hostToken?.trim() || undefined,
      );
      setVesloServerStatus(result.status);
      setVesloServerCapabilities(result.capabilities);
      setVesloServerCheckedAt(Date.now());
      return result.status !== "disconnected";
    })().finally(() => {
      ensureLocalVesloServerRunningInFlight = null;
    });

    return ensureLocalVesloServerRunningInFlight;
  };

  let lastLocalVesloEnsureKey = "";
  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (startupPreference() === "server") return;
    if (workspaceStore.activeWorkspaceDisplay().workspaceType !== "local") return;

    const nextKey = [
      workspaceStore.activeWorkspaceId().trim(),
      workspaceStore.activeWorkspaceRoot().trim(),
      baseUrl().trim(),
    ].join("::");
    if (!nextKey.replace(/:/g, "")) return;
    if (nextKey === lastLocalVesloEnsureKey) return;

    const scheduledKey = nextKey;
    void ensureLocalVesloServerRunning()
      .then((ok) => {
        if (ok) {
          lastLocalVesloEnsureKey = scheduledKey;
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
        reportError(error, "veslo-server.ensure.effect");
      });
  });

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

  const refreshMcpServers = createMcpServersRefresher({
    projectDir: () => workspaceProjectDir(),
    workspaceType: () => workspaceStore.activeWorkspaceDisplay().workspaceType,
    activeWorkspaceId: () => workspaceStore.activeWorkspaceId(),
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
    scheduleRuntimeStatusRefresh: scheduleMcpRuntimeStatusRefresh,
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
      await workspaceStore.activateWorkspace(workspaceStore.activeWorkspaceId(), { origin: "app:reload-workspace-engine" });
      await refreshMcpServers();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to apply runtime changes.";
      setError(message);
      return false;
    }
  };

  const systemState = createSystemState({
    client,
    routing: workspaceRouting,
    sessions,
    sessionStatusById,
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

  const markManagedAiConfigApplied = (reloadKey: string): void => {
    if (!reloadKey) return;
    if (lastManagedAiConfigAppliedForServerToken() === reloadKey) return;
    setLastManagedAiConfigAppliedForServerToken(reloadKey);
    console.log("[managed-ai] config applied; destructive engine reload deferred", { reloadKey });
  };

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

  const activeReloadBlockingSessions = createMemo(() => {
    const statuses = sessionStatusById();
    return sessions()
      .filter((session) => statuses[session.id] === "running")
      .map((session) => ({
        id: session.id,
        title: session.title?.trim() || session.slug?.trim() || session.id,
      }));
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
        await abortSession(session.id);
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

  // Scheduler helpers - must be defined after workspaceStore
  const automationItemKey = (workspaceId: string, automationId: string) => `${workspaceId}:${automationId}`;

  const automationWorkspaceName = (workspace: WorkspaceInfo) =>
    workspace.vesloWorkspaceName?.trim() ||
    workspace.displayName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    workspace.id;

  const activeAutomationWorkspace = createMemo(() => {
    const activeWorkspaceId = workspaceStore.activeWorkspaceId().trim();
    if (!activeWorkspaceId) return null;
    return automationWorkspaces().find((workspace) =>
      workspace.appWorkspaceId === activeWorkspaceId &&
      workspace.status === "ready" &&
      Boolean(workspace.serverWorkspaceId)
    ) ?? null;
  });

  const resolveAutomationWorkspaceMap = async (
    client = vesloServerClient(),
  ): Promise<AutomationWorkspaceSummary[]> => {
    const appWorkspaces = workspaceStore.workspaces();

    if (vesloServerStatus() !== "connected" || !client) {
      return appWorkspaces.map((workspace) => ({
        appWorkspaceId: workspace.id,
        serverWorkspaceId: null,
        name: automationWorkspaceName(workspace),
        path: workspace.directory ?? workspace.path ?? null,
        workspaceType: workspace.workspaceType,
        status: "unavailable",
        error: "Veslo server not ready.",
      }));
    }

    const response = await client.listWorkspaces();
    const items = Array.isArray(response.items) ? response.items : [];
    return buildAutomationWorkspaceSummaries({
      appWorkspaces,
      serverWorkspaces: items,
      connectedServerBaseUrl: client.baseUrl,
    });
  };

  const scheduledJobsSource = createMemo<"local" | "remote">(() => {
    return workspaceStore.activeWorkspaceDisplay().workspaceType === "remote" ? "remote" : "local";
  });

  const scheduledJobsSourceReady = createMemo(() => {
    const client = vesloServerClient();
    return vesloServerStatus() === "connected" && Boolean(client);
  });

  const ensureScheduledJobsSourceReady = async () => {
    if (scheduledJobsSourceReady()) return true;
    if (scheduledJobsSource() !== "local" || !isTauriRuntime() || startupPreference() === "server") {
      return false;
    }
    return await ensureLocalVesloServerRunning({ ignoreStartupPreference: true });
  };

  const ensureScheduledJobsClient = async (): Promise<VesloServerClient | null> => {
    const currentClient = vesloServerClient();
    if (vesloServerStatus() === "connected" && currentClient) {
      return currentClient;
    }

    if (scheduledJobsSource() !== "local" || !isTauriRuntime() || startupPreference() === "server") {
      return null;
    }

    await ensureLocalVesloServerRunning({ ignoreStartupPreference: true });

    const ensuredClient = vesloServerClient();
    if (vesloServerStatus() === "connected" && ensuredClient) {
      return ensuredClient;
    }

    let liveInfo: VesloServerInfo | null = null;
    try {
      liveInfo = await vesloServerInfo();
      setVesloServerHostInfo(liveInfo);
    } catch {
      setVesloServerHostInfo(null);
    }

    const runningInfo = resolveRunningVesloServerHostInfo(liveInfo);
    const baseUrl = runningInfo?.baseUrl?.trim() ?? "";
    if (!baseUrl) {
      return null;
    }

    const clientToken = runningInfo?.clientToken?.trim() || undefined;
    const hostToken = runningInfo?.hostToken?.trim() || undefined;
    const result = await checkVesloServer(baseUrl, clientToken, hostToken);
    setVesloServerStatus(result.status);
    setVesloServerCapabilities(result.capabilities);
    setVesloServerCheckedAt(Date.now());

    if (result.status !== "connected") {
      return null;
    }

    return createVesloServerClient({ baseUrl, token: clientToken, hostToken });
  };

  const refreshScheduledJobs = async (options?: { force?: boolean }) => {
    if (scheduledJobsBusy() && !options?.force) return;

    setScheduledJobsBusy(true);
    setScheduledJobsStatus(null);

    const client = await ensureScheduledJobsClient().catch((error) => {
      reportError(error, "scheduled.ensureSourceReady");
      return null;
    });

    const serverStatus = vesloServerStatus();
    if (!client || serverStatus !== "connected") {
      setScheduledJobs([]);
      setAutomationItems([]);
      setAutomationWorkspaces([]);
      const statusMessage =
        serverStatus === "disconnected"
          ? "Veslo server unavailable. Connect to sync automations."
          : serverStatus === "limited"
            ? "Veslo server needs a token to load automations."
            : "Veslo server not ready.";
      setScheduledJobsStatus(statusMessage);
      setScheduledJobsBusy(false);
      return;
    }

    try {
      const workspaceMap = await resolveAutomationWorkspaceMap(client);
      const nextWorkspaces = [...workspaceMap];
      const readyWorkspaces = nextWorkspaces.filter((workspace) => workspace.status === "ready" && workspace.serverWorkspaceId);
      let partialFailure = false;

      const itemGroups = await Promise.all(
        readyWorkspaces.map(async (workspace) => {
          const serverWorkspaceId = workspace.serverWorkspaceId!;
          try {
            const response = await client.listAutomations(serverWorkspaceId);
            const items = Array.isArray(response.items) ? response.items : [];
            const runEntries = await Promise.all(
              items.map(async (automation) => {
                try {
                  const runs = await client.listAutomationRuns(serverWorkspaceId, automation.id);
                  return [automation.id, Array.isArray(runs.items) ? runs.items : []] as const;
                } catch {
                  return [automation.id, []] as const;
                }
              }),
            );
            const runsByAutomationId = Object.fromEntries(runEntries);
            return items.map((automation) => ({
              key: automationItemKey(serverWorkspaceId, automation.id),
              workspace,
              automation,
              runs: runsByAutomationId[automation.id] ?? [],
            }));
          } catch (error) {
            partialFailure = true;
            const message = error instanceof Error ? error.message : String(error);
            const index = nextWorkspaces.findIndex((item) => item.appWorkspaceId === workspace.appWorkspaceId);
            if (index >= 0) {
              nextWorkspaces[index] = { ...workspace, status: "error", error: message || "Failed to load automations." };
            }
            return [] as WorkspaceAutomationItem[];
          }
        }),
      );

      setScheduledJobs([]);
      setAutomationWorkspaces(nextWorkspaces);
      setAutomationItems(itemGroups.flat());
      setScheduledJobsUpdatedAt(Date.now());
      setScheduledJobsStatus(partialFailure ? "Some workspaces could not load automations." : null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setScheduledJobs([]);
      setAutomationItems([]);
      setAutomationWorkspaces([]);
      setScheduledJobsStatus(message || "Failed to load automations.");
    } finally {
      setScheduledJobsBusy(false);
    }
  };

  const reloadScheduledJobsSource = async () => {
    await ensureScheduledJobsSourceReady().catch((error) => {
      reportError(error, "scheduled.reloadSource");
      return false;
    });
    await refreshScheduledJobs({ force: true });
  };

  const requireAutomationClient = (workspaceId: string) => {
    const client = vesloServerClient();
    if (!client || vesloServerStatus() !== "connected") {
      throw new Error("Veslo server unavailable. Connect to sync automations.");
    }
    if (!workspaceId) {
      throw new Error("Workspace is required to manage automations.");
    }
    return client;
  };

  const workspaceSummaryForServerId = (workspaceId: string): AutomationWorkspaceSummary => {
    return automationWorkspaces().find((workspace) => workspace.serverWorkspaceId === workspaceId) ?? {
      appWorkspaceId: workspaceId,
      serverWorkspaceId: workspaceId,
      name: workspaceId,
      path: null,
      workspaceType: "remote",
      status: "ready",
      error: null,
    };
  };

  const upsertAutomationItem = (workspaceId: string, automation: VesloAutomation) => {
    const key = automationItemKey(workspaceId, automation.id);
    setAutomationItems((current) => {
      const existing = current.find((item) => item.key === key);
      const nextItem: WorkspaceAutomationItem = {
        key,
        workspace: existing?.workspace ?? workspaceSummaryForServerId(workspaceId),
        automation,
        runs: existing?.runs ?? [],
      };
      return [nextItem, ...current.filter((item) => item.key !== key)];
    });
  };

  const createAutomation = async (workspaceId: string, payload: VesloAutomationCreatePayload) => {
    const client = requireAutomationClient(workspaceId);
    const response = await client.createAutomation(workspaceId, payload);
    upsertAutomationItem(workspaceId, response.automation);
    setScheduledJobsUpdatedAt(Date.now());
  };

  const updateAutomation = async (workspaceId: string, automationId: string, payload: VesloAutomationUpdatePayload) => {
    const client = requireAutomationClient(workspaceId);
    const response = await client.updateAutomation(workspaceId, automationId, payload);
    upsertAutomationItem(workspaceId, response.automation);
    setScheduledJobsUpdatedAt(Date.now());
  };

  const deleteAutomation = async (workspaceId: string, automationId: string) => {
    const client = requireAutomationClient(workspaceId);
    const response = await client.deleteAutomation(workspaceId, automationId);
    upsertAutomationItem(workspaceId, response.automation);
    setScheduledJobsUpdatedAt(Date.now());
  };

  const runAutomation = async (workspaceId: string, automationId: string) => {
    const client = requireAutomationClient(workspaceId);
    const response = await client.runAutomation(workspaceId, automationId);
    const key = automationItemKey(workspaceId, automationId);
    setAutomationItems((current) =>
      current.map((item) =>
        item.key === key
          ? {
              ...item,
              runs: [response.run, ...item.runs.filter((run) => run.id !== response.run.id)],
              automation: {
                ...item.automation,
                lastRunId: response.run.id,
                updatedAt: response.run.finishedAt ?? response.run.startedAt ?? item.automation.updatedAt,
              },
            }
          : item,
      ),
    );
    setScheduledJobsUpdatedAt(Date.now());
  };

  const resolveSoulWorkspaceMap = async () => {
    const client = vesloServerClient();
    if (!client || vesloServerStatus() !== "connected") {
      return {} as Record<string, string>;
    }

    const response = await client.listWorkspaces();
    const items = Array.isArray(response.items) ? response.items : [];
    const map: Record<string, string> = {};

    const idByLocalPath = new Map<string, string>();
    for (const item of items) {
      const path = normalizeDirectoryPath(item.path ?? "");
      if (!path) continue;
      idByLocalPath.set(path, item.id);
    }

    for (const workspace of workspaceStore.workspaces()) {
      if (workspace.workspaceType === "local") {
        const key = normalizeDirectoryPath(workspace.path ?? "");
        if (!key) continue;
        const found = idByLocalPath.get(key);
        if (found) {
          map[workspace.id] = found;
        }
        continue;
      }

      if (workspace.remoteType !== "veslo") {
        continue;
      }

      const explicitId =
        workspace.vesloWorkspaceId?.trim() ||
        parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
        parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "");
      if (explicitId) {
        map[workspace.id] = explicitId;
        continue;
      }

      const directoryHint = normalizeDirectoryPath(workspace.directory ?? workspace.path ?? "");
      if (!directoryHint) continue;
      const match = items.find((entry) => {
        const entryPath = normalizeDirectoryPath(
          (entry.opencode?.directory ?? entry.directory ?? entry.path ?? "") as string,
        );
        return Boolean(entryPath && entryPath === directoryHint);
      });
      if (match?.id) {
        map[workspace.id] = match.id;
      }
    }

    return map;
  };

  let soulOverviewRefreshSeq = 0;
  const refreshSoulOverview = async (client: VesloServerClient) => {
    const requestSeq = ++soulOverviewRefreshSeq;
    setSoulOverviewBusy(true);
    const isCurrentRequest = () =>
      requestSeq === soulOverviewRefreshSeq && vesloServerClient() === client && vesloServerStatus() === "connected";
    try {
      const overview = await client.getSoulOverview(skillRegistryMaterializationAuthContext());
      if (!isCurrentRequest()) {
        return;
      }
      setSoulOverview(overview);
      setSoulOverviewError(null);
    } catch (error) {
      if (!isCurrentRequest()) {
        return;
      }
      const message = error instanceof Error ? error.message : "Failed to load Soul overview.";
      setSoulOverview(null);
      setSoulOverviewError(message);
    } finally {
      if (isCurrentRequest()) {
        setSoulOverviewBusy(false);
      }
    }
  };

  const refreshSoulData = async (options?: { force?: boolean }) => {
    const client = vesloServerClient();
    if (!client || vesloServerStatus() !== "connected") {
      soulOverviewRefreshSeq += 1;
      setSoulOverview(null);
      setSoulOverviewError(null);
      setSoulOverviewBusy(false);
      setSoulStatusByWorkspaceId({});
      setActiveSoulHeartbeats([]);
      setSoulHeartbeatsBusy(false);
      setSoulError(null);
      return;
    }

    void refreshSoulOverview(client);
    if (soulStatusBusy() && !options?.force) return;

    setSoulStatusBusy(true);
    setSoulError(null);
    try {
      const workspaceMap = await resolveSoulWorkspaceMap();
      const workspaceIds = Object.entries(workspaceMap);

      const nextStatusByWorkspace: Record<string, VesloSoulStatus | null> = {};
      for (const workspace of workspaceStore.workspaces()) {
        nextStatusByWorkspace[workspace.id] = null;
      }

      let hadStatusError = false;
      await Promise.all(
        workspaceIds.map(async ([workspaceId, vesloId]) => {
          try {
            const status = await client.getSoulStatus(vesloId);
            nextStatusByWorkspace[workspaceId] = status;
          } catch {
            hadStatusError = true;
            nextStatusByWorkspace[workspaceId] = null;
          }
        }),
      );
      setSoulStatusByWorkspaceId(nextStatusByWorkspace);

      const activeWorkspaceId = workspaceStore.activeWorkspaceId();
      const activeVesloId = workspaceMap[activeWorkspaceId];
      if (!activeVesloId) {
        setActiveSoulHeartbeats([]);
        setSoulHeartbeatsBusy(false);
        if (hadStatusError) {
          setSoulError("Soul status is partially unavailable.");
        }
        return;
      }

      setSoulHeartbeatsBusy(true);
      try {
        const response = await client.listSoulHeartbeats(activeVesloId, 30);
        setActiveSoulHeartbeats(Array.isArray(response.items) ? response.items : []);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load soul heartbeats.";
        setActiveSoulHeartbeats([]);
        setSoulError(message);
      } finally {
        setSoulHeartbeatsBusy(false);
      }

      if (hadStatusError && !soulError()) {
        setSoulError("Soul status is partially unavailable.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load soul status.";
      setSoulOverview(null);
      setSoulStatusByWorkspaceId({});
      setActiveSoulHeartbeats([]);
      setSoulHeartbeatsBusy(false);
      setSoulError(message);
    } finally {
      setSoulStatusBusy(false);
    }
  };

  const activeSoulStatus = createMemo(() => {
    const id = workspaceStore.activeWorkspaceId();
    if (!id) return null;
    return soulStatusByWorkspaceId()[id] ?? null;
  });

  let lastSoulRefreshKey = "";
  createEffect(() => {
    const status = vesloServerStatus();
    const hasClient = Boolean(vesloServerClient());
    const activeWorkspaceId = workspaceStore.activeWorkspaceId();
    const workspacesKey = workspaceStore
      .workspaces()
      .map((workspace) => {
        const root = workspace.workspaceType === "local"
          ? workspace.path?.trim() ?? ""
          : workspace.directory?.trim() ?? workspace.path?.trim() ?? "";
        return [workspace.id, workspace.workspaceType, workspace.remoteType ?? "", root, workspace.vesloWorkspaceId ?? ""].join("|");
      })
      .join(";");
    const key = [status, hasClient ? "1" : "0", activeWorkspaceId, workspacesKey].join("::");
    if (key === lastSoulRefreshKey) return;
    lastSoulRefreshKey = key;
    void refreshSoulData().catch(e => reportError(e, "soul.refresh"));
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    workspaceStore.activeWorkspaceId();
    workspaceProjectDir();
    void refreshMcpServers();
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

  async function connectNotion() {
    if (workspaceStore.activeWorkspaceDisplay().workspaceType !== "local") {
      setNotionError("Notion connections are only available for local workspaces.");
      return;
    }

    const projectDir = workspaceProjectDir().trim();
    if (!projectDir) {
      setNotionError("Pick a workspace folder first.");
      return;
    }

    const vesloClient = vesloServerClient();
    const vesloWorkspaceId = vesloServerWorkspaceId();
    const vesloCapabilities = resolvedVesloCapabilities();
    const canUseVesloServer =
      vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.mcp?.write;

    if (!canUseVesloServer && !isTauriRuntime()) {
      setNotionError("Notion connections require the desktop app.");
      return;
    }

    if (notionBusy()) return;

    setNotionBusy(true);
    setNotionError(null);
    setNotionStatus("connecting");
    setNotionStatusDetail(t("mcp.connecting", currentLocale()));
    setNotionSkillInstalled(false);

    try {
      if (canUseVesloServer) {
        await vesloClient.addMcp(vesloWorkspaceId, {
          name: "notion",
          config: {
            type: "remote",
            url: "https://mcp.notion.com/mcp",
            enabled: true,
          },
        });
      } else {
        const config = await readOpencodeConfig("project", projectDir);
        const raw = config.content ?? "";
        const nextConfig = raw.trim()
          ? (parse(raw) as Record<string, unknown>)
          : { $schema: "https://opencode.ai/config.json" };

        const mcp = typeof nextConfig.mcp === "object" && nextConfig.mcp
          ? { ...(nextConfig.mcp as Record<string, unknown>) }
          : {};
        mcp.notion = {
          type: "remote",
          url: "https://mcp.notion.com/mcp",
          enabled: true,
        };

        nextConfig.mcp = mcp;
        const formatted = JSON.stringify(nextConfig, null, 2);

        const result = await writeOpencodeConfig("project", projectDir, `${formatted}\n`);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
        }
      }

      await refreshMcpServers();
      setNotionStatusDetail(t("mcp.connecting", currentLocale()));
      try {
        window.localStorage.setItem("veslo.notionStatus", "connecting");
        window.localStorage.setItem("veslo.notionStatusDetail", t("mcp.connecting", currentLocale()));
        window.localStorage.setItem("veslo.notionSkillInstalled", "0");
      } catch {
        // ignore
      }
    } catch (e) {
      setNotionStatus("error");
      setNotionError(e instanceof Error ? e.message : "Failed to connect Notion.");
    } finally {
      setNotionBusy(false);
    }
  }

  const filterConfiguredMcpStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
    const configured = new Set(entries.map((entry) => entry.name));
    return Object.fromEntries(Object.entries(status).filter(([name]) => configured.has(name))) as McpStatusMap;
  };

  function scheduleMcpRuntimeStatusRefresh(projectDir: string, entries: McpServerEntry[]) {
    const directory = projectDir.trim();
    const workspaceId = workspaceStore.activeWorkspaceId().trim();
    const activeClient = routedClient();

    if (!entries.length || !directory || !engineReady() || !activeClient) {
      setMcpStatuses({});
      return;
    }

    const entriesKey = entries.map((entry) => entry.name).join("\0");
    const key = [workspaceId, directory].join("::");
    if (mcpRuntimeStatusRefreshInFlightByKey.has(key)) return;

    const task = (async () => {
      try {
        const status = unwrap(await activeClient.mcp.status({ directory }));
        if (workspaceStore.activeWorkspaceId().trim() !== workspaceId) return;
        if (workspaceProjectDir().trim() !== directory) return;
        if (mcpServers().map((entry) => entry.name).join("\0") !== entriesKey) return;
        setMcpStatuses(filterConfiguredMcpStatuses(status as McpStatusMap, entries));
      } catch {
        if (workspaceStore.activeWorkspaceId().trim() === workspaceId && workspaceProjectDir().trim() === directory) {
          setMcpStatuses({});
        }
      } finally {
        mcpRuntimeStatusRefreshInFlightByKey.delete(key);
      }
    })();
    mcpRuntimeStatusRefreshInFlightByKey.set(key, task);
  }

  async function ensureMcpRuntimeContext() {
    const projectDir = workspaceProjectDir().trim();

    let activeClient = routedClient();
    if (!activeClient) {
      const vesloBaseUrl = vesloServerBaseUrl().trim();
      const auth = vesloServerAuth();
      if (vesloBaseUrl && auth.token) {
        const opencodeUrl = `${vesloBaseUrl.replace(/\/+$/, "")}/opencode`;
        activeClient = createClient(opencodeUrl, undefined, { token: auth.token, mode: "veslo" });
        setClient(activeClient);
      }
    }
    if (!activeClient) {
      throw new Error(t("mcp.connect_server_first", currentLocale()));
    }

    let resolvedProjectDir = projectDir;
    if (!resolvedProjectDir) {
      try {
        const pathInfo = unwrap(await activeClient.path.get());
        const discoveredRaw = normalizeDirectoryQueryPath(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          workspaceStore.setProjectDir(discovered);
        }
      } catch {
        // ignore
      }
    }
    if (!resolvedProjectDir) {
      throw new Error(t("mcp.pick_workspace_first", currentLocale()));
    }

    return { activeClient, resolvedProjectDir };
  }

  function buildMcpAddConfig(entry: McpDirectoryInfo): McpLocalConfig | McpRemoteConfig {
    const entryType = entry.type ?? "remote";
    if (entryType === "remote") {
      if (!entry.url) {
        throw new Error("Missing MCP URL.");
      }
      const oauth: McpRemoteConfig["oauth"] = entry.oauth ? {} : false;
      return {
        type: "remote",
        url: entry.url,
        enabled: true,
        oauth,
      };
    }

    if (!entry.command?.length) {
      throw new Error("Missing MCP command.");
    }

    return {
      type: "local",
      command: entry.command,
      enabled: true,
    };
  }

  async function activateInstalledMcp(entry: McpDirectoryInfo, slug = quickConnectEntryKey(entry)) {
    const { activeClient, resolvedProjectDir } = await ensureMcpRuntimeContext();
    const status = unwrap(
      await activeClient.mcp.add({
        directory: resolvedProjectDir,
        name: slug,
        config: buildMcpAddConfig(entry),
      }),
    );

    setMcpStatuses(status as McpStatusMap);
    await refreshMcpServers();

    if (entry.oauth) {
      setMcpAuthEntry(entry);
      setMcpAuthNeedsReload(true);
      setMcpAuthModalOpen(true);
    } else {
      setMcpStatus(t("mcp.connected", currentLocale()));
    }

    await refreshMcpServers();
  }

  async function connectMcp(entry: (typeof MCP_QUICK_CONNECT)[number]) {
    const startedAt = perfNow();
    const isRemoteWorkspace =
      workspaceStore.activeWorkspaceDisplay().workspaceType === "remote" ||
      (!isTauriRuntime() && vesloServerStatus() === "connected");
    const projectDir = workspaceProjectDir().trim();
    const entryType = entry.type ?? "remote";

    recordPerfLog(developerMode(), "mcp.connect", "start", {
      name: entry.name,
      type: entryType,
      workspaceType: isRemoteWorkspace ? "remote" : "local",
      projectDir: projectDir || null,
    });

    const vesloClient = vesloServerClient();
    let vesloWorkspaceId = vesloServerWorkspaceId();
    const vesloCapabilities = resolvedVesloCapabilities();
    if (!vesloWorkspaceId && vesloClient && vesloServerStatus() === "connected") {
      try {
        const response = await vesloClient.listWorkspaces();
        const match = response.items?.[0];
        if (match?.id) {
          vesloWorkspaceId = match.id;
          setVesloServerWorkspaceId(match.id);
        }
      } catch {
        // ignore
      }
    }
    const canUseVesloServer =
      vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.mcp?.write;

    if (isRemoteWorkspace && !canUseVesloServer) {
      setMcpStatus("Veslo server unavailable. MCP config is read-only.");
      finishPerf(developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "veslo-server-unavailable",
      });
      return;
    }

    if (!canUseVesloServer && !isTauriRuntime()) {
      setMcpStatus(t("mcp.desktop_required", currentLocale()));
      finishPerf(developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return;
    }

    if (!isRemoteWorkspace && !projectDir) {
      setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
      finishPerf(developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return;
    }

    const slug = quickConnectEntryKey(entry);

    try {
      setMcpStatus(null);
      setMcpConnectingName(entry.name);
      const { resolvedProjectDir } = await ensureMcpRuntimeContext();

      const mcpEntryConfig: Record<string, unknown> = {
        type: entryType,
        enabled: true,
      };

      if (entryType === "remote") {
        if (!entry.url) {
          throw new Error("Missing MCP URL.");
        }
        mcpEntryConfig["url"] = entry.url;
        if (entry.oauth) {
          mcpEntryConfig["oauth"] = {};
        }
      }

      if (entryType === "local") {
        if (!entry.command?.length) {
          throw new Error("Missing MCP command.");
        }
        mcpEntryConfig["command"] = entry.command;
      }

      if (canUseVesloServer && vesloClient && vesloWorkspaceId) {
        await vesloClient.addMcp(vesloWorkspaceId, {
          name: slug,
          config: mcpEntryConfig,
        });
      } else {
        const configFile = await readOpencodeConfig("project", resolvedProjectDir);

        let existingConfig: Record<string, unknown> = {};
        if (configFile.exists && configFile.content?.trim()) {
          try {
            existingConfig = parse(configFile.content) ?? {};
          } catch (parseErr) {
            recordPerfLog(developerMode(), "mcp.connect", "config-parse-failed", {
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
            existingConfig = {};
          }
        }

        if (!existingConfig["$schema"]) {
          existingConfig["$schema"] = "https://opencode.ai/config.json";
        }

        const mcpSection = (existingConfig["mcp"] as Record<string, unknown>) ?? {};
        existingConfig["mcp"] = mcpSection;
        mcpSection[slug] = mcpEntryConfig;

        const writeResult = await writeOpencodeConfig(
          "project",
          resolvedProjectDir,
          `${JSON.stringify(existingConfig, null, 2)}\n`
        );
        if (!writeResult.ok) {
          throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
        }
      }

      await activateInstalledMcp(entry, slug);
      finishPerf(developerMode(), "mcp.connect", "done", startedAt, {
        name: entry.name,
        type: entryType,
        slug,
      });
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : t("mcp.connect_failed", currentLocale()));
      finishPerf(developerMode(), "mcp.connect", "error", startedAt, {
        name: entry.name,
        type: entryType,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
    } finally {
      setMcpConnectingName(null);
    }
  }

  function authorizeMcp(entry: McpServerEntry) {
    if (entry.config.type !== "remote" || entry.config.oauth === false) {
      setMcpStatus(t("mcp.login_unavailable", currentLocale()));
      return;
    }

    const matchingQuickConnect = localizedMcpQuickConnect().find((candidate) => {
      const candidateSlug = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return candidateSlug === entry.name || candidate.name === entry.name;
    });

    setMcpAuthEntry(
      matchingQuickConnect ?? {
        name: entry.name,
        description: "",
        type: "remote",
        url: entry.config.url,
        oauth: true,
      },
    );
    setMcpAuthNeedsReload(false);
    setMcpAuthModalOpen(true);
  }

  async function installHubMcpAndActivate(name: string): Promise<{ ok: boolean; message: string }> {
    const result = await installHubMcp(name);
    if (!result.ok) {
      return result;
    }

    const selectedEntry = result.entry ?? hubMcpCards().find((entry) => entry.id === name || entry.name === name);
    if (!selectedEntry) {
      await refreshMcpServers();
      return result;
    }

    const entry: McpDirectoryInfo = {
      id: selectedEntry.id,
      name: selectedEntry.name,
      description: selectedEntry.description ?? "",
      type: selectedEntry.type,
      ...(selectedEntry.url ? { url: selectedEntry.url } : {}),
      ...(selectedEntry.command ? { command: selectedEntry.command } : {}),
      oauth: selectedEntry.oauth,
    };

    try {
      setMcpStatus(null);
      setMcpConnectingName(entry.name);
      await activateInstalledMcp(entry, entry.id || quickConnectEntryKey(entry));
      return result;
    } catch (error) {
      await refreshMcpServers();
      const message = error instanceof Error ? error.message : safeStringify(error);
      setMcpStatus(message);
      return { ok: false, message };
    } finally {
      setMcpConnectingName(null);
    }
  }

  async function logoutMcpAuth(name: string) {
    const isRemoteWorkspace =
      workspaceStore.activeWorkspaceDisplay().workspaceType === "remote" ||
      (!isTauriRuntime() && vesloServerStatus() === "connected");
    const projectDir = workspaceProjectDir().trim();

    const vesloClient = vesloServerClient();
    let vesloWorkspaceId = vesloServerWorkspaceId();
    const vesloCapabilities = resolvedVesloCapabilities();
    if (!vesloWorkspaceId && vesloClient && vesloServerStatus() === "connected") {
      try {
        const response = await vesloClient.listWorkspaces();
        const match = response.items?.[0];
        if (match?.id) {
          vesloWorkspaceId = match.id;
          setVesloServerWorkspaceId(match.id);
        }
      } catch {
        // ignore
      }
    }
    const canUseVesloServer =
      vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.mcp?.write;

    if (isRemoteWorkspace && !canUseVesloServer) {
      setMcpStatus("Veslo server unavailable. MCP auth is read-only.");
      return;
    }

    if (!canUseVesloServer && !isTauriRuntime()) {
      setMcpStatus(t("mcp.desktop_required", currentLocale()));
      return;
    }

    let activeClient = routedClient();
    if (!activeClient) {
      const vesloBaseUrl = vesloServerBaseUrl().trim();
      const auth = vesloServerAuth();
      if (vesloBaseUrl && auth.token) {
        const opencodeUrl = `${vesloBaseUrl.replace(/\/+$/, "")}/opencode`;
        activeClient = createClient(opencodeUrl, undefined, { token: auth.token, mode: "veslo" });
        setClient(activeClient);
      }
    }
    if (!activeClient) {
      setMcpStatus(t("mcp.connect_server_first", currentLocale()));
      return;
    }

    let resolvedProjectDir = projectDir;
    if (!resolvedProjectDir) {
      try {
        const pathInfo = unwrap(await activeClient.path.get());
        const discoveredRaw = normalizeDirectoryQueryPath(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          workspaceStore.setProjectDir(discovered);
        }
      } catch {
        // ignore
      }
    }
    if (!resolvedProjectDir) {
      setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
      return;
    }

    const safeName = validateMcpServerName(name);
    setMcpStatus(null);

    try {
      if (canUseVesloServer && vesloClient && vesloWorkspaceId) {
        await vesloClient.logoutMcpAuth(vesloWorkspaceId, safeName);
      } else {
        try {
          await activeClient.mcp.disconnect({ directory: resolvedProjectDir, name: safeName });
        } catch {
          // ignore
        }
        await activeClient.mcp.auth.remove({ directory: resolvedProjectDir, name: safeName });
      }

      try {
        const status = unwrap(await activeClient.mcp.status({ directory: resolvedProjectDir }));
        setMcpStatuses(status as McpStatusMap);
      } catch {
        // ignore
      }

      await refreshMcpServers();
      setMcpStatus(t("mcp.logout_success", currentLocale()).replace("{server}", safeName));
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : t("mcp.logout_failed", currentLocale()));
    }
  }

  async function removeMcp(name: string) {
    try {
      setMcpStatus(null);

      const vesloClient = vesloServerClient();
      const vesloWorkspaceId = vesloServerWorkspaceId();
      const canUseVesloServer =
        vesloServerStatus() === "connected" &&
        vesloClient &&
        vesloWorkspaceId &&
        resolvedVesloCapabilities()?.mcp?.write;

      const entry = mcpServers().find((server) => server.name === name);
      if (!entry) {
        setMcpStatus("This MCP is no longer available. Refresh and try again.");
        return;
      }
      if (!canRemoveMcpFromProjectConfig(entry)) {
        setMcpStatus("This MCP comes from your global OpenCode config and cannot be removed from this workspace.");
        return;
      }

      if (canUseVesloServer && vesloClient && vesloWorkspaceId) {
        await vesloClient.removeMcp(vesloWorkspaceId, name);
      } else {
        const projectDir = workspaceProjectDir().trim();
        if (!projectDir) {
          setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
          return;
        }
        await removeMcpFromConfig(projectDir, name);
      }

      await refreshMcpServers();
      if (selectedMcp() === name) {
        setSelectedMcp(null);
      }
      setMcpStatus(null);
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : t("mcp.remove_failed", currentLocale()));
    }
  }

  async function createSessionAndOpen(
    initialTitle = "",
    options: {
      blockAppDuringCreate?: boolean;
      managedAiRuntimeAlreadyPrepared?: boolean;
      pendingSession?: PendingSidebarSessionMetadata | null;
      sendTraceId?: string | null;
      preflight?: SendPreflightContext;
    } = {},
  ) {
    const blockAppDuringCreate = options.blockAppDuringCreate ?? true;
    const pendingSidebarSession = options.pendingSession ?? null;
    const preflight = options.preflight;
    const sendTraceId = options.sendTraceId?.trim() || preflight?.traceId || activeSendTraceId();
    const tracePayload = sendTraceId ? { traceId: sendTraceId } : undefined;
    const pendingTargetWorkspace = pendingSidebarSession?.workspaceId?.trim()
      ? {
          workspaceId: pendingSidebarSession.workspaceId.trim(),
          workspaceRoot: pendingSidebarSession.workspaceRoot.trim(),
          directory: pendingSidebarSession.workspaceRoot.trim(),
        }
      : null;
    const targetWorkspace =
      preflight?.targetWorkspace ??
      pendingTargetWorkspace ??
      resolveSendTargetWorkspaceScope(null) ??
      null;
    recordSendTrace("createSessionAndOpen:start", {
      ...(tracePayload ?? {}),
      connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
      activeWorkspaceId: workspaceStore.activeWorkspaceId(),
      activeWorkspaceRoot: workspaceStore.activeWorkspaceRoot().trim(),
      targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
      targetWorkspaceRoot: targetWorkspace?.workspaceRoot ?? null,
      targetDirectory: targetWorkspace?.directory ?? null,
      hasClient: Boolean(routedClient()),
    });
    // Block session creation while a workspace switch is in progress.
    // Without this gate, activeWorkspaceRoot() can return a stale or empty
    // value and the session ends up in the wrong directory.
    const connectingWorkspaceId = workspaceStore.connectingWorkspaceId()?.trim() ?? "";
    if (connectingWorkspaceId && (!targetWorkspace || connectingWorkspaceId === targetWorkspace.workspaceId)) {
      console.warn(
        "[createSessionAndOpen] Blocked: workspace switch in progress",
        { connectingWorkspaceId },
      );
      recordSendTrace("createSessionAndOpen:blocked-connecting", {
        ...(tracePayload ?? {}),
        connectingWorkspaceId,
        targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
      });
      setError("Please wait for the workspace switch to complete.");
      return undefined;
    } else if (connectingWorkspaceId) {
      recordSendTrace("createSessionAndOpen:ignore-unrelated-connecting-workspace", {
        ...(tracePayload ?? {}),
        connectingWorkspaceId,
        targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
      });
    }

    const managedAiPreflightDecision = resolveCreateSessionManagedAiPreflightDecision({
      preflightManagedAiReady: Boolean(preflight?.managedAiReady),
      runtimeAlreadyPrepared: Boolean(options.managedAiRuntimeAlreadyPrepared),
    });
    if (managedAiPreflightDecision.type === "skip") {
      recordSendTrace("createSessionAndOpen:managed-ai-bootstrap-skip", {
        ...(tracePayload ?? {}),
        reason: managedAiPreflightDecision.reason,
      });
      if (preflight) preflight.managedAiReady = true;
    } else {
      const managedAiReady = await sendTraceStep(
        "createSessionAndOpen:ensure-managed-ai-bootstrap-ready",
        () => ensureManagedAiBootstrapReady(),
        {
          ...(tracePayload ?? {}),
          managedAiBootstrapBusy: managedAiBootstrapBusy(),
          reloadBusy: reloadBusy(),
          hasClient: Boolean(routedClient(targetWorkspace?.workspaceId)),
        },
      );
      if (!managedAiReady) {
        recordSendTrace("createSessionAndOpen:blocked-managed-ai-bootstrap", tracePayload);
        return undefined;
      }
      if (preflight) preflight.managedAiReady = true;
    }
    let createRuntimeReady = true;
    const runtimeHealthPreflightDecision = resolveCreateSessionRuntimeHealthPreflightDecision({
      preflightRuntimeHealthOk: Boolean(preflight?.runtimeHealthOk),
    });
    if (runtimeHealthPreflightDecision.type === "skip") {
      recordSendTrace("createSessionAndOpen:health-skip", {
        ...(tracePayload ?? {}),
        reason: runtimeHealthPreflightDecision.reason,
      });
    } else {
      const createRuntimePreflight: SendRuntimePreflightContext = preflight ?? {
        traceId: sendTraceId,
        targetWorkspace,
        runtimeHealthOk: false,
      };
      createRuntimeReady = await sendTraceStep(
        "createSessionAndOpen:ensure-local-runtime-reachable",
        () => ensureLocalRuntimeReachableForSend("createSessionAndOpen", createRuntimePreflight),
        {
          ...(tracePayload ?? {}),
          activeWorkspaceId: workspaceStore.activeWorkspaceId().trim(),
          targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
          workspaceType: workspaceStore.activeWorkspaceDisplay().workspaceType,
          hasClient: Boolean(routedClient(targetWorkspace?.workspaceId)),
        },
      );
      if (createRuntimePreflight.runtimeHealthOk) {
        recordSendTrace("createSessionAndOpen:health-ok", tracePayload);
      }
    }
    if (!createRuntimeReady) {
      recordSendTrace("createSessionAndOpen:runtime-unreachable-continue", tracePayload);
    }
    const c = routedClientForSendTarget(targetWorkspace);
    if (!c) {
      recordSendTrace("createSessionAndOpen:blocked-no-client", tracePayload);
      setError("Local runtime is not ready yet.");
      return undefined;
    }

    // Guard against creating a session with an empty directory, which would
    // cause the bridge to silently fall back to the orchestrator's default
    // directory (possibly a temp folder or the wrong workspace).
    const sessionDirectory =
      pendingSidebarSession?.workspaceRoot?.trim() ||
      targetWorkspace?.directory ||
      targetWorkspace?.workspaceRoot ||
      workspaceStore.activeWorkspaceRoot().trim();
    if (!sessionDirectory) {
      console.warn(
        "[createSessionAndOpen] Blocked: activeWorkspaceRoot is empty",
      );
      recordSendTrace("createSessionAndOpen:blocked-empty-root", tracePayload);
      setError("Workspace directory is not available. Please try again.");
      return undefined;
    }

    const perfEnabled = developerMode();
    const startedAt = perfNow();
    const runId = (() => {
      const key = "__veslo_create_session_run__";
      const w = window as typeof window & { [key]?: number };
      w[key] = (w[key] ?? 0) + 1;
      return w[key];
    })();

    const mark = (event: string, payload?: Record<string, unknown>) => {
      const elapsed = Math.round((perfNow() - startedAt) * 100) / 100;
      recordPerfLog(perfEnabled, "session.create", event, {
        runId,
        elapsedMs: elapsed,
        ...(payload ?? {}),
      });
    };

    mark("start", {
      baseUrl: baseUrl(),
      workspace: sessionDirectory || null,
      workspaceId: targetWorkspace?.workspaceId || workspaceStore.activeWorkspaceId().trim() || null,
    });

    await sendTraceStep(
      "createSessionAndOpen:abort-refresh-settle",
      async () => {
        // Abort any in-flight refresh operations to free up connection resources.
        abortRefreshes();
      },
      tracePayload,
    );

    setError(null);
    if (blockAppDuringCreate) {
      setBusy(true);
      setBusyLabel("status.creating_task");
      setBusyStartedAt(Date.now());
      setCreatingSession(true);
    }

    try {
      const initialSessionTitle = initialTitle.trim();
      let session: Session & {
        conversationId?: string | null;
        opencodeSessionId?: string | null;
        parentConversationId?: string | null;
        branchId?: string | null;
      };
      try {
        mark("session:create:start");
        const activeWorkspaceId = targetWorkspace?.workspaceId || workspaceStore.activeWorkspaceId().trim();
        const vesloCreated = activeWorkspaceId
          ? await sendTraceStep(
              "createSessionAndOpen:veslo-conversation-create",
              () => createConversationFromVesloWriteApi(
                activeWorkspaceId,
                sessionDirectory,
                initialSessionTitle || undefined,
                preflight,
              ).catch((error) => {
              recordSendTrace("createSessionAndOpen:veslo-create-error", {
                ...(tracePayload ?? {}),
                message: error instanceof Error ? error.message : safeStringify(error),
              });
              console.warn("[conversation-create] falling back to OpenCode SDK", error);
              return null;
              }),
              {
                ...(tracePayload ?? {}),
                workspaceId: activeWorkspaceId,
                sessionDirectory,
              },
            )
          : null;
        if (vesloCreated) {
          session = vesloCreated;
        } else {
          recordSendTrace("createSessionAndOpen:legacy-create-fallback", {
            ...(tracePayload ?? {}),
            workspaceId: activeWorkspaceId || null,
          });
          session = unwrap(await sendTraceStep(
            "createSessionAndOpen:legacy-session-create",
            () => c.session.create({
              directory: sessionDirectory,
              title: initialSessionTitle || undefined,
            }),
            {
              ...(tracePayload ?? {}),
              workspaceId: activeWorkspaceId || null,
              sessionDirectory,
            },
          ));
        }
        recordSendTrace("createSessionAndOpen:create-ok", {
          ...(tracePayload ?? {}),
          sessionDirectory,
          conversationId: session.conversationId ?? null,
          opencodeSessionId: session.opencodeSessionId ?? session.id,
        });
        mark("session:create:ok");
      } catch (createErr) {
        recordSendTrace("createSessionAndOpen:create-error", {
          ...(tracePayload ?? {}),
          message: createErr instanceof Error ? createErr.message : safeStringify(createErr),
        });
        mark("session:create:error", {
          error: createErr instanceof Error ? createErr.message : safeStringify(createErr),
        });
        throw createErr;
      }

      if (initialSessionTitle) {
        registerPendingInitialSessionTitle(session.id, initialSessionTitle);
      }
      const displaySession = applyPendingInitialSessionTitle(session);
      // Inject before selecting so route effects can resolve the new session immediately.
      if (blockAppDuringCreate) {
        setBusyLabel("status.loading_session");
      }
      // Inject the new session into the reactive sessions() store so
      // the createEffect bridge (sessions → sidebar) will always include it,
      // even if the background loadSessionsWithReady hasn't returned yet.
      const currentStoreSessions = sessions();
      if (!currentStoreSessions.some((s) => s.id === session.id)) {
        setSessions([session, ...currentStoreSessions]);
      }

      const newItem = buildCreatedSidebarSessionItem({
        session,
        displaySession,
        pendingSidebarSession,
      });
      const wsId = resolveCreatedSessionWorkspaceId({
        pendingSidebarSession,
        targetWorkspaceId: targetWorkspace?.workspaceId,
        connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
        activeWorkspaceId: workspaceStore.activeWorkspaceId(),
      });
      if (wsId) {
        materializePendingSessionInWorkspaceSidebar({
          workspaceId: wsId,
          pendingSessionInstanceId: pendingSidebarSession?.id ?? null,
          item: newItem,
        });
      }

      mark("session:select:start", { sessionID: session.id });
      await sendTraceStep(
        "createSessionAndOpen:select-session",
        () => selectSession(session.id),
        {
          ...(tracePayload ?? {}),
          sessionID: session.id,
        },
      );
      mark("session:select:ok", { sessionID: session.id });

      // setSessionViewLockUntil(Date.now() + 1200);
      if (shouldRouteCreatedSessionAfterSelect({ blockAppDuringCreate, currentView: currentView() })) {
        routeResumeSelectionAlreadyHandledForSession = session.id;
        goToSession(session.id);
      }

      // The new session is already in the sessions() store (injected above)
      // and in the sidebar signal. SSE session.created events will handle
      // any further syncing. Calling loadSessionsWithReady() here would
      // race with the store injection — the server may not have indexed the
      // session yet, so reconcile() would wipe it from the store, causing
      // the sidebar to flash and the route guard to bounce back.
      finishPerf(perfEnabled, "session.create", "done", startedAt, {
        runId,
        sessionID: session.id,
      });
      recordSendTrace("createSessionAndOpen:success", {
        ...(tracePayload ?? {}),
        sessionID: session.id,
      });
      return session.id;
    } catch (e) {
      finishPerf(perfEnabled, "session.create", "error", startedAt, {
        runId,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
      // VSLO-86 Task #20 — workspace switched while session.create was in
      // flight. The guarded routedClient threw to keep the new session from
      // landing in the stale workspace's engine. Don't surface a user-visible
      // error: the user already moved on and the next click will spin up a
      // fresh session in the right workspace.
      if (isWorkspaceClientStaleError(e)) {
        recordSendTrace("createSessionAndOpen:stale-client", {
          ...(tracePayload ?? {}),
          entryWorkspaceId: e.entryWorkspaceId,
          currentWorkspaceId: e.currentWorkspaceId,
        });
        return undefined;
      }
      const message = e instanceof Error ? e.message : t("app.unknown_error", currentLocale());
      recordSendTrace("createSessionAndOpen:error", {
        ...(tracePayload ?? {}),
        message,
      });
      setError(addOpencodeCacheHint(message));
      return undefined;
    } finally {
      if (blockAppDuringCreate) {
        setCreatingSession(false);
        setBusy(false);
      }
    }
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
        await workspaceStore.forgetWorkspace(sourceWorkspaceId);
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

  function runSoulPrompt(promptText: string) {
    const text = promptText.trim();
    if (!text) return;
    void (async () => {
      const sessionId = await createSessionAndOpen();
      if (!sessionId) {
        setPrompt(text);
        return;
      }

      await sendPrompt({
        mode: "prompt",
        text,
        resolvedText: text,
        parts: [{ type: "text", text }],
        attachments: [],
      }, {
        targetSessionId: sessionId,
        clientMessageId: createSessionClientMessageId(),
        origin: "app:soul-prompt",
      });
    })();
  }


  onMount(async () => {
    const mountCleanupFns: Array<() => void> = [];
    const startupGuard = createStartupGuard({
      timeoutMs: 15_000,
      onTimeout: () => {
        console.warn("[boot] app startup timed out after 15s — forcing boot complete");
        setBooting(false);
      },
    });
    onCleanup(() => {
      startupGuard.dispose();
      for (const cleanup of mountCleanupFns.splice(0)) {
        cleanup();
      }
    });

    if (typeof window !== "undefined" && CLOUD_ONLY_MODE) {
      const invite = readVesloConnectInviteFromSearch(window.location.search);
      if (!invite) {
        clearStartupPreference();
        setRememberStartupChoice(false);
        try {
          for (const key of [
            "veslo.baseUrl",
            "veslo.clientDirectory",
            "veslo.projectDir",
            "veslo.onboardingComplete",
          ]) {
            window.localStorage.removeItem(key);
          }
        } catch {
          // ignore
        }
        clearVesloServerSettings();
        hydrateVesloServerSettingsFromEnv();
        setVesloServerSettings(readVesloServerSettings());
      }
    }

    const startupPref = readStartupPreference();
    if (startupPref) {
      setRememberStartupChoice(true);
      setStartupPreference(startupPref);
    }

    if (typeof window !== "undefined") {
      try {
        const storedUpdateAutoCheck = window.localStorage.getItem(
          "veslo.updateAutoCheck"
        );
        const storedUpdateAutoDownload = window.localStorage.getItem(
          "veslo.updateAutoDownload"
        );
        const startupUpdatePreferences = resolveUpdateStartupPreferences({
          storedAutoCheck: storedUpdateAutoCheck,
          storedAutoDownload: storedUpdateAutoDownload,
        });
        setUpdateAutoCheck(startupUpdatePreferences.autoCheck);
        setUpdateAutoDownload(startupUpdatePreferences.autoDownload);
      } catch {
        // ignore
      } finally {
        setUpdatePreferencesReady(true);
      }
    } else {
      setUpdatePreferencesReady(true);
    }

    await pendingSessionDraftController.hydrateActivePendingDraft();
    pendingSessionDraftController.markActivePendingDraftStorageReady();

    const unsubscribeTheme = subscribeToSystemTheme((isDark) => {
      if (themeMode() !== "system") return;
      applyThemeMode(isDark ? "dark" : "light");
    });

    onCleanup(() => {
      unsubscribeTheme();
    });

    createEffect(() => {
      const next = themeMode();
      persistThemeMode(next);
      applyThemeMode(next);
    });

    if (typeof window !== "undefined") {
      try {
        setSubagentDecorationsState(readSubagentDecorationsState());

        // In Tauri/desktop mode, do NOT restore the cached baseUrl from localStorage.
        // OpenCode is assigned a random port on every restart, so the stored URL is
        // always stale after a relaunch. The correct baseUrl is provided by engine_info().
        // Web mode still needs the cached value since it connects to a fixed server URL.
        if (!isTauriRuntime()) {
          const storedBaseUrl = window.localStorage.getItem("veslo.baseUrl");
          if (storedBaseUrl) {
            setBaseUrl(storedBaseUrl);
          }
        }

        const storedClientDir = window.localStorage.getItem(
          "veslo.clientDirectory"
        );
        if (storedClientDir) {
          setClientDirectory(storedClientDir);
        }

        const storedEngineSource = window.localStorage.getItem(ENGINE_SOURCE_PREF_KEY);
        const storedEngineSourceExplicit = parseStoredEngineSourceExplicitPreference(
          window.localStorage.getItem(ENGINE_SOURCE_EXPLICIT_PREF_KEY),
        );
        const storedEngineCustomBinPath = window.localStorage.getItem(ENGINE_CUSTOM_BIN_PATH_PREF_KEY);
        if (storedEngineCustomBinPath) {
          setEngineCustomBinPath(storedEngineCustomBinPath);
        }
        const restoredEngineSource = resolveStoredEngineSourcePreference({
          isTauriRuntime: isTauriRuntime(),
          storedSource: storedEngineSource,
          storedCustomBinPath: storedEngineCustomBinPath,
          storedSourceExplicit: storedEngineSourceExplicit,
        });
        updateEngineSource(restoredEngineSource.source, {
          explicit: restoredEngineSource.explicit,
        });

        const storedEngineRuntime = window.localStorage.getItem(
          "veslo.engineRuntime"
        );
        if (storedEngineRuntime === "direct" || storedEngineRuntime === "veslo-orchestrator") {
          setEngineRuntime(storedEngineRuntime);
        }

        const storedDefaultModel = window.localStorage.getItem(MODEL_PREF_KEY);
        const parsedDefaultModel = parseModelRef(storedDefaultModel);
        if (parsedDefaultModel) {
          setDefaultModel(parsedDefaultModel);
          setLegacyDefaultModel(parsedDefaultModel);
        } else {
          setDefaultModel(DEFAULT_MODEL);
          setLegacyDefaultModel(DEFAULT_MODEL);
          try {
            window.localStorage.setItem(
              MODEL_PREF_KEY,
              formatModelRef(DEFAULT_MODEL)
            );
          } catch {
            // ignore
          }
        }

        const storedThinking = window.localStorage.getItem(THINKING_PREF_KEY);
        if (storedThinking != null) {
          try {
            const parsed = JSON.parse(storedThinking);
            if (typeof parsed === "boolean") {
              setShowThinking(parsed);
            }
          } catch {
            // ignore
          }
        }

        // VSLO-171 F3Ú9 — Performance settings.
        const storedMax = window.localStorage.getItem(MAX_ENGINES_PREF_KEY);
        if (storedMax != null) {
          try {
            const parsed = JSON.parse(storedMax);
            if (typeof parsed === "number" && parsed >= 1 && parsed <= 16) {
              setMaxEngines(parsed);
            }
          } catch {
            // ignore
          }
        }
        const storedIdle = window.localStorage.getItem(IDLE_SUSPEND_MS_PREF_KEY);
        if (storedIdle != null) {
          try {
            const parsed = JSON.parse(storedIdle);
            if (typeof parsed === "number" && parsed >= 0) {
              setIdleSuspendMs(parsed);
            }
          } catch {
            // ignore
          }
        }

        const storedHideTitlebar = window.localStorage.getItem(HIDE_TITLEBAR_PREF_KEY);
        if (storedHideTitlebar != null) {
          try {
            const parsed = JSON.parse(storedHideTitlebar);
            if (typeof parsed === "boolean") {
              setHideTitlebar(parsed);
            }
          } catch {
            // ignore
          }
        }

        const storedAutoCompactContext = window.localStorage.getItem(AUTO_COMPACT_CONTEXT_PREF_KEY);
        if (storedAutoCompactContext !== "true") {
          try {
            const parsed = storedAutoCompactContext == null ? null : JSON.parse(storedAutoCompactContext);
            if (parsed !== true) {
              window.localStorage.setItem(AUTO_COMPACT_CONTEXT_PREF_KEY, JSON.stringify(true));
            }
          } catch {
            window.localStorage.setItem(AUTO_COMPACT_CONTEXT_PREF_KEY, JSON.stringify(true));
          }
        }

        try {
          const startupVariant = resolveStartupModelVariant({
            storedVariant: window.localStorage.getItem(VARIANT_PREF_KEY),
            storedMigrationVersion: window.localStorage.getItem(MODEL_VARIANT_DEFAULT_MIGRATION_KEY),
          });
          setModelVariant(startupVariant.variant);
          if (startupVariant.persistVariant) {
            window.localStorage.setItem(VARIANT_PREF_KEY, startupVariant.variant);
          }
          if (startupVariant.persistMigrationVersion) {
            window.localStorage.setItem(MODEL_VARIANT_DEFAULT_MIGRATION_KEY, startupVariant.persistMigrationVersion);
          }
        } finally {
          setModelVariantPreferenceReady(true);
        }

        const storedUpdateCheckedAt = window.localStorage.getItem(
          "veslo.updateLastCheckedAt"
        );
        if (storedUpdateCheckedAt) {
          const parsed = Number(storedUpdateCheckedAt);
          if (Number.isFinite(parsed) && parsed > 0) {
            setUpdateStatus({ state: "idle", lastCheckedAt: parsed });
          }
        }

        const storedNotionStatus = window.localStorage.getItem("veslo.notionStatus");
        if (
          storedNotionStatus === "disconnected" ||
          storedNotionStatus === "connected" ||
          storedNotionStatus === "connecting" ||
          storedNotionStatus === "error"
        ) {
          setNotionStatus(storedNotionStatus);
        }

        const storedNotionDetail = window.localStorage.getItem("veslo.notionStatusDetail");
        if (storedNotionDetail) {
          setNotionStatusDetail(storedNotionDetail);
        } else if (storedNotionStatus === "connecting") {
          setNotionStatusDetail(t("mcp.connecting", currentLocale()));
        }

        void refreshMcpServers().catch(e => reportError(e, "mcp.refreshServers"));

        const storedNotionSkillInstalled = window.localStorage.getItem("veslo.notionSkillInstalled");
        if (storedNotionSkillInstalled === "1") {
          setNotionSkillInstalled(true);
        }
      } catch {
        // ignore
      }
    }
    setSubagentDecorationsReady(true);

    if (isTauriRuntime()) {
      try {
        setAppVersion(await getVersion());
      } catch {
        // ignore
      }

      try {
        setUpdateEnv(await updaterEnvironment());
      } catch {
        // ignore
      }

      if (!launchUpdateCheckTriggered()) {
        setLaunchUpdateCheckTriggered(true);
        checkForUpdates({ quiet: true }).catch(e => reportError(e, "updates.check"));
      }

      try {
        const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
        const { listen } = await import("@tauri-apps/api/event");
        // Dedupe URLs across both delivery channels (onOpenUrl + single-instance
        // event). On macOS the same URL can arrive twice — once via Apple Events
        // and once via argv of a relaunched second instance — and re-running
        // queueAuthCompleteDeepLink invalidates the one-time auth code.
        const seenUrls = new Set<string>();
        const consumeUrls = (urls: string[] | null | undefined) => {
          if (!Array.isArray(urls)) {
            return;
          }
          for (const url of urls) {
            if (typeof url !== "string" || url.length === 0) continue;
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            if (queueAuthCompleteDeepLink(url) || queueRemoteConnectDeepLink(url) || queueSharedBundleDeepLink(url)) {
              break;
            }
          }
        };

        consumeUrls(await getCurrent());
        const unlisten = await onOpenUrl((urls) => {
          consumeUrls(urls);
        });
        // Single-instance plugin emits this event when a second Veslo instance
        // is launched with deep-link arguments (typical macOS browser handoff).
        // The original instance focuses its window via the Rust side; we still
        // need to deliver the URL payload to the auth/remote-connect handlers.
        const unlistenSingleInstance = await listen<string[]>("deep-link://new-url", (event) => {
          consumeUrls(event.payload);
        });
        mountCleanupFns.push(() => {
          unlisten();
          unlistenSingleInstance();
        });
      } catch {
        // ignore
      }
    }

    if (!isTauriRuntime()) {
      const currentUrl = typeof window === "undefined" ? "" : window.location.href;
      if (currentUrl) {
        queueAuthCompleteDeepLink(currentUrl);
        queueRemoteConnectDeepLink(currentUrl);
        queueSharedBundleDeepLink(currentUrl);
        const remoteStripped = stripRemoteConnectQuery(currentUrl) ?? currentUrl;
        const bundleStripped = stripSharedBundleQuery(remoteStripped) ?? remoteStripped;
        if (bundleStripped !== currentUrl) {
          window.history.replaceState({}, "", bundleStripped);
        }
      }
    }

    if (isTauriRuntime()) {
      try {
        const hydrationPromise = hydrateDenAuthFromDesktopSnapshot().catch(() => false);
        let hydrationTimedOut = false;
        await Promise.race([
          hydrationPromise,
          new Promise<void>((resolve) => {
            window.setTimeout(() => {
              hydrationTimedOut = true;
              resolve();
            }, 1500);
          }),
        ]);
        if (hydrationTimedOut) {
          void hydrationPromise.then((imported) => {
            if (!imported || onboardingStep() !== "auth") {
              return;
            }
            // If the synchronous boot path already established a client by
            // the time the delayed hydration finishes, the retry bootstrap
            // is redundant — and would race the user's current session
            // view through bootstrapOnboarding → connectToServer.
            if (routedClient()) {
              return;
            }
            setOnboardingStep("connecting");
            setBooting(true);
            void workspaceStore.bootstrapOnboarding().finally(() => {
              setBooting(false);
            });
          });
        }
      } catch {
        // ignore desktop auth snapshot hydration failures
      }
    }

    void workspaceStore.bootstrapOnboarding().finally(() => {
      startupGuard.complete();
      setBooting(false);
    });
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    if (!workspaceId) return;
    setSessionModelOverrideById({});
  });

  createMcpAutoRefreshScheduler({
    isTauriRuntime,
    engineReady: () => engineReady(),
    workspaceProjectDir: () => workspaceProjectDir(),
    refreshMcpServers,
  });

  createEffect(() => {
    if (!subagentDecorationsReady()) return;
    writeSubagentDecorationsState(subagentDecorationsState());
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    if (!workspaceId) return;

    setWorkspaceDefaultModelReady(false);
    const workspaceType = workspaceStore.activeWorkspaceDisplay().workspaceType;
    const workspaceRoot = workspaceStore.activeWorkspacePath().trim();
    const activeClient = routedClient();
    const vesloClient = vesloServerClient();
    const vesloWorkspaceId = vesloServerWorkspaceId();
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
        lastKnownConfigSnapshotByWs.set(workspaceRoot, getConfigSnapshot(configFileContent));
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
    const workspace = workspaceStore.activeWorkspaceDisplay();
    const syncPreflight = resolveManagedAiConfigSyncPreflight({
      workspaceDefaultModelReady: workspaceDefaultModelReady(),
      isDesktopRuntime: isTauriRuntime(),
      defaultModelExplicit: defaultModelExplicit(),
      workspaceType: workspace.workspaceType,
      workspaceRoot: workspaceStore.activeWorkspacePath(),
    });
    if (syncPreflight.type === "skip") return;
    denAuthRevision();

    const root = syncPreflight.workspaceRoot;
    const nextModel = defaultModel();
    const managedProfile = managedAiAccess();
    const managedAccessBusy = managedProfile ? false : managedAiAccessBusy();
    const managedAccessError = managedProfile ? null : managedAiAccessError();
    const gatewayClient = gatewayVesloServerClient();
    const providerRoutingLocalHost = activeVesloServerHostInfo();
    const providerRoutingLocalBaseUrl =
      providerRoutingLocalHost?.baseUrl ?? deriveLocalVesloServerUrlFromOpencodeBaseUrl(baseUrl()) ?? "";
    const providerRoutingEngineBaseUrl =
      providerRoutingLocalHost?.engineUrl ?? providerRoutingLocalBaseUrl;
    const providerRoutingTarget = resolveManagedAiProviderRoutingTarget({
      isDesktopRuntime: isTauriRuntime(),
      workspaceType: workspace.workspaceType,
      activeBaseUrl: providerRoutingLocalBaseUrl,
      engineBaseUrl: providerRoutingEngineBaseUrl,
      activeToken: providerRoutingLocalHost?.clientToken ?? "",
      gatewayBaseUrl: gatewayClient?.baseUrl ?? "",
      gatewayToken: gatewayClient?.token ?? "",
    });
    const gatewayAccessToken = managedAiGatewayAccessToken() || denGatewayAccessToken();
    const vesloClient = vesloServerClient();
    const vesloWorkspaceId = vesloServerWorkspaceId();
    const vesloCapabilities = resolvedVesloCapabilities();
    const canUseVesloServer =
      vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.config?.write;
    const providerRoutingReady = Boolean(providerRoutingTarget?.serverClientToken && gatewayAccessToken);
    const providerRoutingReloadKey = providerRoutingTarget
      ? `${providerRoutingTarget.serverClientToken}@${providerRoutingTarget.engineBaseUrl}`
      : "";
    let cancelled = false;
    const releaseManagedAiBootstrap =
      managedProfile && providerRoutingReady ? beginManagedAiBootstrap() : null;

    const writeConfig = async () => {
      try {
        const providerReadinessDecision = resolveManagedAiConfigWriteDecision({
          managedProfilePresent: Boolean(managedProfile),
          providerRoutingReady,
          managedConfigAlreadyCurrent: false,
          shouldPreserveManagedConfig: false,
          defaultModelAlreadyCurrent: false,
        });
        if (
          providerReadinessDecision.type === "skip" &&
          providerReadinessDecision.reason === "provider-routing-not-ready"
        ) {
          return;
        }

        if (canUseVesloServer) {
          const config = await vesloClient.getConfig(vesloWorkspaceId);
          const currentOpencodeContent = JSON.stringify(config.opencode ?? {}, null, 2);

          if (managedProfile && providerRoutingTarget && gatewayAccessToken) {
            const content = formatManagedAiAccessConfig(
              currentOpencodeContent,
              {
                profile: managedProfile,
                serverBaseUrl: providerRoutingTarget.baseUrl,
                engineBaseUrl: providerRoutingTarget.engineBaseUrl,
                serverClientToken: providerRoutingTarget.serverClientToken,
                gatewayAccessToken,
              },
            );
            const desiredSnapshot = getConfigSnapshot(content);
            const wsKey = vesloWorkspaceId;
            // Self-heal: if the file on disk holds an apiKey that differs from
            // the current server client token, the cached snapshot is stale —
            // drop it so the patch below runs even when the desired snapshot
            // matches the cache from a previous workspace.
            const currentApiKey = extractManagedApiKey(currentOpencodeContent);
            if (currentApiKey && currentApiKey !== providerRoutingTarget.serverClientToken) {
              lastKnownConfigSnapshotByWs.delete(wsKey);
            }
            const cachedSnapshotMatches = lastKnownConfigSnapshotByWs.get(wsKey) === desiredSnapshot;
            const redactedServerConfigMatches = managedConfigContentsMatchForServerPatch(
              currentOpencodeContent,
              content,
            );
            const managedDecision = resolveManagedAiConfigWriteDecision({
              managedProfilePresent: Boolean(managedProfile),
              providerRoutingReady,
              managedConfigAlreadyCurrent: cachedSnapshotMatches || redactedServerConfigMatches,
              shouldPreserveManagedConfig: false,
              defaultModelAlreadyCurrent: false,
            });
            if (managedDecision.type === "skip") {
              if (!cachedSnapshotMatches && redactedServerConfigMatches) {
                lastKnownConfigSnapshotByWs.set(wsKey, desiredSnapshot);
              }
              return;
            }
            if (managedDecision.type !== "write-managed-config") {
              lastKnownConfigSnapshotByWs.set(wsKey, desiredSnapshot);
              return;
            }
            await vesloClient.patchConfig(vesloWorkspaceId, {
              opencode: JSON.parse(content) as Record<string, unknown>,
            });
            lastKnownConfigSnapshotByWs.set(wsKey, desiredSnapshot);
            markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
            // Do not auto-dispose/reload the engine here. This effect runs
            // during boot and before Send; a destructive reload can suspend a
            // healthy WSL engine and block the first prompt behind runtime
            // recovery. The banner still marks config as changed, while the
            // managed provider config is available for OpenCode's next read.
            if (
              shouldAutoReloadManagedAiConfig({
                hasManagedProfile: true,
                hasConfigChanged: true,
                hasActiveRuns: anyActiveRuns(),
                canReloadWorkspace: canReloadWorkspace(),
              }) &&
              lastManagedAiConfigAppliedForServerToken() !== providerRoutingReloadKey
            ) {
              markManagedAiConfigApplied(providerRoutingReloadKey);
            }
            return;
          }

          const preserveManagedConfig = shouldPreserveManagedAiConfig({
              content: currentOpencodeContent,
              managedProfile,
              gatewayBaseUrl: providerRoutingTarget?.engineBaseUrl ?? providerRoutingTarget?.baseUrl ?? "",
              serverClientToken: providerRoutingTarget?.serverClientToken ?? "",
              gatewayAccessToken,
              accessBusy: managedAccessBusy,
              accessError: managedAccessError,
          });
          const currentModel = typeof config.opencode?.model === "string" ? parseModelRef(config.opencode.model) : null;
          const defaultModelAlreadyCurrent = Boolean(currentModel && modelEquals(currentModel, nextModel));
          const defaultModelDecision = resolveManagedAiConfigWriteDecision({
            managedProfilePresent: Boolean(managedProfile),
            providerRoutingReady,
            managedConfigAlreadyCurrent: false,
            shouldPreserveManagedConfig: preserveManagedConfig,
            defaultModelAlreadyCurrent,
          });
          if (defaultModelDecision.type === "skip") {
            return;
          }
          if (defaultModelDecision.type !== "write-default-model") return;

          await vesloClient.patchConfig(vesloWorkspaceId, {
            opencode: { model: formatModelRef(nextModel) },
          });
          markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
          return;
        }

        const configFile = await readOpencodeConfig("project", root);
        if (managedProfile && providerRoutingTarget && gatewayAccessToken) {
          const content = formatManagedAiAccessConfig(configFile.content, {
            profile: managedProfile,
            serverBaseUrl: providerRoutingTarget.baseUrl,
            engineBaseUrl: providerRoutingTarget.engineBaseUrl,
            serverClientToken: providerRoutingTarget.serverClientToken,
            gatewayAccessToken,
          });
          const fileDecision = resolveManagedAiConfigWriteDecision({
            managedProfilePresent: Boolean(managedProfile),
            providerRoutingReady,
            managedConfigAlreadyCurrent: (configFile.content ?? "").trim() === content.trim(),
            shouldPreserveManagedConfig: false,
            defaultModelAlreadyCurrent: false,
          });
          if (fileDecision.type === "skip") return;
          if (fileDecision.type !== "write-managed-config") return;

          const result = await writeOpencodeConfig("project", root, content);
          if (!result.ok) {
            throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
          }
          lastKnownConfigSnapshotByWs.set(root, getConfigSnapshot(content));
          markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
          // Do not auto-dispose/reload the engine here — see comment above.
          if (
            shouldAutoReloadManagedAiConfig({
              hasManagedProfile: true,
              hasConfigChanged: true,
              hasActiveRuns: anyActiveRuns(),
              canReloadWorkspace: canReloadWorkspace(),
            }) &&
            lastManagedAiConfigAppliedForServerToken() !== providerRoutingReloadKey
          ) {
            markManagedAiConfigApplied(providerRoutingReloadKey);
          }
          return;
        }

        const preserveManagedConfig = shouldPreserveManagedAiConfig({
            content: configFile.content,
            managedProfile,
            gatewayBaseUrl: providerRoutingTarget?.engineBaseUrl ?? providerRoutingTarget?.baseUrl ?? "",
            serverClientToken: providerRoutingTarget?.serverClientToken ?? "",
            gatewayAccessToken,
            accessBusy: managedAccessBusy,
            accessError: managedAccessError,
        });
        const existingModel = parseDefaultModelFromConfig(configFile.content);
        const defaultModelAlreadyCurrent = Boolean(existingModel && modelEquals(existingModel, nextModel));
        const fileDecision = resolveManagedAiConfigWriteDecision({
          managedProfilePresent: Boolean(managedProfile),
          providerRoutingReady,
          managedConfigAlreadyCurrent: false,
          shouldPreserveManagedConfig: preserveManagedConfig,
          defaultModelAlreadyCurrent,
        });
        if (fileDecision.type === "skip") {
          return;
        }
        if (fileDecision.type !== "write-default-model") return;

        const content = formatConfigWithDefaultModel(configFile.content, nextModel);
        const result = await writeOpencodeConfig("project", root, content);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
        }
        lastKnownConfigSnapshotByWs.set(root, getConfigSnapshot(content));
        markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
      } finally {
        releaseManagedAiBootstrap?.();
      }
    };

    void writeConfig();

    onCleanup(() => {
      cancelled = true;
    });
  });

  // VSLO-86: heal stale gateway baseURL in non-active managed workspaces.
  // The active-workspace patch effect above only fires for the workspace the
  // user has currently open, so any other workspace keeps the baseURL from a
  // previous Veslo server lifetime. After a Tauri restart that allocates a
  // different server port, the engine spawn for those workspaces fails with
  // "Unable to connect" the moment the user opens or creates a session in
  // them. We mirror the same patch flow here for every managed local
  // workspace once per server-client-token rotation, but without restarting
  // any engine — the active workspace's effect handles engine reload, and the
  // other workspaces have no engine running to reload yet.
  createEffect(() => {
    if (!isTauriRuntime()) return;
    const vesloClient = vesloServerClient();
    if (!vesloClient) return;
    if (vesloServerStatus() !== "connected") return;
    const vesloCapabilities = resolvedVesloCapabilities();
    if (!vesloCapabilities?.config?.write) return;
    const managedProfile = managedAiAccess();
    if (!managedProfile) return;
    const providerRoutingLocalHost = activeVesloServerHostInfo();
    if (!providerRoutingLocalHost?.baseUrl) return;
    const gatewayClient = gatewayVesloServerClient();
    const providerRoutingTarget = resolveManagedAiProviderRoutingTarget({
      isDesktopRuntime: isTauriRuntime(),
      workspaceType: "local",
      activeBaseUrl: providerRoutingLocalHost.baseUrl,
      engineBaseUrl: providerRoutingLocalHost.engineUrl ?? providerRoutingLocalHost.baseUrl,
      activeToken: providerRoutingLocalHost?.clientToken ?? "",
      gatewayBaseUrl: gatewayClient?.baseUrl ?? "",
      gatewayToken: gatewayClient?.token ?? "",
    });
    if (!providerRoutingTarget?.serverClientToken) return;
    const gatewayAccessToken = managedAiGatewayAccessToken() || denGatewayAccessToken();
    if (!gatewayAccessToken) return;

    const sessionToken = `${providerRoutingTarget.serverClientToken}@${providerRoutingTarget.engineBaseUrl}`;
    const activeWorkspaceId = (vesloServerWorkspaceId() ?? "").trim();
    let cancelled = false;

    const healInactiveWorkspaces = async () => {
      let workspaceItems: Awaited<ReturnType<typeof vesloClient.listWorkspaces>>["items"];
      try {
        const response = await vesloClient.listWorkspaces();
        workspaceItems = Array.isArray(response.items) ? response.items : [];
      } catch (error) {
        if (!cancelled) reportError(error, "managed-baseurl.listWorkspaces");
        return;
      }
      for (const workspace of workspaceItems) {
        if (cancelled) return;
        if (workspace.workspaceType !== "local") continue;
        if (workspace.id === activeWorkspaceId) continue;
        if (inactiveWorkspaceBaseUrlHealedFor.get(workspace.id) === sessionToken) continue;
        try {
          const config = await vesloClient.getConfig(workspace.id);
          if (cancelled) return;
          const currentOpencodeContent = JSON.stringify(config.opencode ?? {}, null, 2);
          const desiredContent = formatManagedAiAccessConfig(currentOpencodeContent, {
            profile: managedProfile,
            serverBaseUrl: providerRoutingTarget.baseUrl,
            engineBaseUrl: providerRoutingTarget.engineBaseUrl,
            serverClientToken: providerRoutingTarget.serverClientToken,
            gatewayAccessToken,
          });
          if (managedConfigContentsMatchForServerPatch(currentOpencodeContent, desiredContent)) {
            inactiveWorkspaceBaseUrlHealedFor.set(workspace.id, sessionToken);
            continue;
          }
          await vesloClient.patchConfig(workspace.id, {
            opencode: JSON.parse(desiredContent) as Record<string, unknown>,
          });
          if (cancelled) return;
          inactiveWorkspaceBaseUrlHealedFor.set(workspace.id, sessionToken);
        } catch (error) {
          if (cancelled) continue;
          const message = error instanceof Error ? error.message : safeStringify(error);
          // Private/system workspaces returned by listWorkspaces() can refuse
          // GET/PATCH /config with "Workspace is not authorized" — mark them
          // healed for this server token so the effect doesn't re-spam once
          // per state-change cycle.
          if (/not authorized|unauthorized|401/i.test(message)) {
            inactiveWorkspaceBaseUrlHealedFor.set(workspace.id, sessionToken);
            continue;
          }
          reportError(error, `managed-baseurl.heal:${workspace.id}`);
        }
      }
    };

    void healInactiveWorkspaces();

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
    if (typeof window === "undefined") return;
    // In Tauri desktop the orchestrator port rotates on every `pnpm dev`
    // restart and the live URL always comes from `engineInfo()` IPC.
    // Persisting it to localStorage here only pollutes the cache (the read
    // path at line ~7509 already skips localStorage in Tauri) and creates
    // a stale value that a future regression could read by accident.
    if (isTauriRuntime()) return;
    try {
      window.localStorage.setItem("veslo.baseUrl", baseUrl());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "veslo.clientDirectory",
        clientDirectory()
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    // Legacy key: keep for backwards compatibility.
    try {
      window.localStorage.setItem("veslo.projectDir", workspaceProjectDir());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(ENGINE_SOURCE_PREF_KEY, engineSource());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (engineSourceExplicit()) {
        window.localStorage.setItem(ENGINE_SOURCE_EXPLICIT_PREF_KEY, "1");
      } else {
        window.localStorage.removeItem(ENGINE_SOURCE_EXPLICIT_PREF_KEY);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const value = engineCustomBinPath().trim();
      if (value) {
        window.localStorage.setItem(ENGINE_CUSTOM_BIN_PATH_PREF_KEY, value);
      } else {
        window.localStorage.removeItem(ENGINE_CUSTOM_BIN_PATH_PREF_KEY);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("veslo.engineRuntime", engineRuntime());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        MODEL_PREF_KEY,
        formatModelRef(defaultModel())
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!updatePreferencesReady()) return;
    try {
      window.localStorage.setItem(
        "veslo.updateAutoCheck",
        updateAutoCheck() ? "1" : "0"
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!updatePreferencesReady()) return;
    try {
      window.localStorage.setItem(
        "veslo.updateAutoDownload",
        updateAutoDownload() ? "1" : "0"
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        THINKING_PREF_KEY,
        JSON.stringify(showThinking())
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MAX_ENGINES_PREF_KEY, JSON.stringify(maxEngines()));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(IDLE_SUSPEND_MS_PREF_KEY, JSON.stringify(idleSuspendMs()));
    } catch {
      // ignore
    }
  });

  // Persist and apply hideTitlebar setting
  createEffect(() => {
    if (typeof window === "undefined") return;
    const hide = hideTitlebar();
    try {
      window.localStorage.setItem(HIDE_TITLEBAR_PREF_KEY, JSON.stringify(hide));
    } catch {
      // ignore
    }
    // Apply to window decorations (only in Tauri desktop environment)
    if (isTauriRuntime()) {
      setWindowDecorations(
        resolveNativeWindowDecorationsVisible({
          tauri: true,
          windows: isWindowsPlatform(),
          hideTitlebar: hide,
        }),
      ).catch(e => reportError(e, "titlebar.setDecorations"));
    }
  });

  // On macOS, keep native titlebar controls and surface app controls in overlay area.
  createEffect(() => {
    if (!isTauriRuntime() || !isMacPlatform()) return;
    const titlebarHidden = hideTitlebar();
    if (titlebarHidden) return;
    setWindowTitleBarStyle("overlay").catch((error) => {
      console.error("[app.titlebar] Failed to apply macOS overlay titlebar style", {
        runtime: "tauri",
        platform: "macOS",
        hideTitlebar: titlebarHidden,
        style: "overlay",
        error: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    });
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(AUTO_COMPACT_CONTEXT_PREF_KEY, JSON.stringify(autoCompactContext()));
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!modelVariantPreferenceReady()) return;
    try {
      const value = modelVariant();
      if (value) {
        window.localStorage.setItem(VARIANT_PREF_KEY, value);
      } else {
        window.localStorage.removeItem(VARIANT_PREF_KEY);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    const state = updateStatus();
    if (typeof window === "undefined") return;
    if (state.state === "idle" && state.lastCheckedAt) {
      try {
        window.localStorage.setItem(
          "veslo.updateLastCheckedAt",
          String(state.lastCheckedAt)
        );
      } catch {
        // ignore
      }
    }
  });

  createEffect(() => {
    if (booting()) return;
    if (!isTauriRuntime()) return;
    if (launchUpdateCheckTriggered()) return;

    const state = updateStatus();
    if (state.state === "checking" || state.state === "downloading") return;

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
      if (state.state === "checking" || state.state === "downloading") return;
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
    connectingWorkspaceId: () => workspaceStore.connectingWorkspaceId(),
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
      reloadScheduledAutomationsSource: reloadScheduledJobsSource,
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
      openNewSessionWithDirectory: pendingSessionDraftController.openNewSessionWithDirectory,
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
      archiveSession: (workspaceId: string, sessionId: string) =>
        archiveSidebarSession(workspaceId, sessionId).catch((error) => {
          reportError(error, "sessionArchives.archiveSidebar");
          setError(error instanceof Error ? error.message : safeStringify(error));
        }),
      unarchiveSession: (_workspaceId: string, sessionId: string) =>
        unarchiveSession(sessionId).catch((error) => {
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
      automationItems: automationItems(),
      automationWorkspaces: automationWorkspaces(),
      defaultAutomationWorkspaceId: activeAutomationWorkspace()?.serverWorkspaceId ?? null,
      scheduledJobs: scheduledJobs(),
      scheduledJobsSource: scheduledJobsSource(),
      scheduledJobsSourceReady: scheduledJobsSourceReady(),
      scheduledJobsStatus: scheduledJobsStatus(),
      scheduledJobsBusy: scheduledJobsBusy(),
      scheduledJobsUpdatedAt: scheduledJobsUpdatedAt(),
      refreshScheduledJobs: (options?: { force?: boolean }) =>
        refreshScheduledJobs(options).catch(e => reportError(e, "scheduled.refresh")),
      createAutomation,
      updateAutomation,
      deleteAutomation,
      runAutomation,
      soulOverview: soulOverview(),
      soulOverviewError: soulOverviewError(),
      soulOverviewBusy: soulOverviewBusy(),
      soulClient: vesloServerClient(),
      soulServerConnected: vesloServerStatus() === "connected",
      soulAuthContext: skillRegistryMaterializationAuthContext(),
      soulStatusByWorkspaceId: soulStatusByWorkspaceId(),
      activeSoulStatus: activeSoulStatus(),
      activeSoulHeartbeats: activeSoulHeartbeats(),
      soulStatusBusy: soulStatusBusy(),
      soulHeartbeatsBusy: soulHeartbeatsBusy(),
      soulError: soulError(),
      refreshSoulData: (options?: { force?: boolean }) => refreshSoulData(options).catch(e => reportError(e, "soul.refresh")),
      runSoulPrompt,
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
      autoCompactContext: autoCompactContext(),
      toggleAutoCompactContext: () => setAutoCompactContext(true),
      hideTitlebar: hideTitlebar(),
      toggleHideTitlebar: () => setHideTitlebar((v) => !v),
      maxEngines: maxEngines(),
      setMaxEngines: (n: number) => setMaxEngines(Math.max(1, Math.min(64, Math.floor(n)))),
      idleSuspendMs: idleSuspendMs(),
      setIdleSuspendMs: (ms: number) => setIdleSuspendMs(Math.max(0, Math.floor(ms))),
      modelVariantLabel: formatModelVariantLabel(modelVariant()),
      modelVariant: normalizeModelVariant(modelVariant()) ?? "none",
      setModelVariant: (value: string) => setModelVariant(value),
      updateAutoCheck: updateAutoCheck(),
      toggleUpdateAutoCheck: () => setUpdateAutoCheck((v) => !v),
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
      onUnarchiveArchivedSession: (sessionId: string) =>
        unarchiveSession(sessionId).catch((error) => {
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
    activeWorkspaceId: workspaceStore.activeWorkspaceId(),
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
    openNewSessionWithDirectory: pendingSessionDraftController.openNewSessionWithDirectory,
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
    unarchiveSession: (_workspaceId: string, sessionId: string) =>
      unarchiveSession(sessionId).catch((error) => {
        reportError(error, "sessionArchives.unarchiveSidebar");
        setError(error instanceof Error ? error.message : safeStringify(error));
      }),
    loadMoreWorkspaceSidebarSessions,
    isPrivateWorkspacePath: workspaceStore.isPrivateWorkspacePath,
    soulStatusByWorkspaceId: soulStatusByWorkspaceId(),
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
    sessionStatus: selectedSessionStatus(),
    renameSession: renameSessionTitle,
    error: error(),
  });

  async function persistFeedback(values: FeedbackFormValues) {
    if (feedbackSubmitting()) return;
    setFeedbackSubmitError(null);
    setFeedbackSubmitSuccessIssueId(null);
    setFeedbackSubmitting(true);
    try {
      const result = await submitFeedbackReport({
        title: values.title,
        description: values.description,
        context: buildFeedbackRuntimeContext(),
      });

      setFeedbackSubmitSuccessIssueId(result.youtrackIssueId);
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  function submitFeedback(values: FeedbackFormValues) {
    void persistFeedback(values).catch((error) => {
      reportError(error, "feedback.submit");
      setFeedbackSubmitError(error instanceof Error ? error.message : safeStringify(error));
    });
  }

  const syncExternalHashRoute = () => {
    if (!isTauriRuntime()) return;
    const hashPath = window.location.hash.replace(/^#/, "").trim();
    if (!hashPath.startsWith("/")) return;

    const pathname = hashPath.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
    if (pathname.startsWith("/dashboard")) {
      const [, , tabSegment] = pathname.split("/");
      const resolvedTab = resolveDashboardRouteTab(tabSegment);
      if (resolvedTab !== tab()) {
        setTabState(resolvedTab);
      }
    }

    if (location.pathname.toLowerCase() !== pathname) {
      navigate(hashPath, { replace: true });
    }
  };

  onMount(() => {
    if (!isTauriRuntime()) return;
    window.addEventListener("hashchange", syncExternalHashRoute);
  });

  onCleanup(() => {
    if (!isTauriRuntime()) return;
    window.removeEventListener("hashchange", syncExternalHashRoute);
  });

  createEffect(() => {
    const rawPath = location.pathname.trim();
    const startupRouteDecision = resolveAppStartupRouteDecision({
      rawPath,
      onboardingStep: onboardingStep(),
      isTauriRuntime: isTauriRuntime(),
      activeSessionId: activeSessionId(),
    });

    switch (startupRouteDecision.type) {
      case "navigate":
        navigate(startupRouteDecision.to, { replace: startupRouteDecision.replace });
        return;
      case "dashboard-route":
        if (startupRouteDecision.tab !== tab()) {
          setTabState(startupRouteDecision.tab);
        }
        if (startupRouteDecision.canonicalize) {
          goToDashboard(startupRouteDecision.tab, { replace: true });
        }
        return;
      case "ignore":
        return;
      case "session-route": {
        const [, , sessionSegment] = rawPath.split("/");
        const id = (sessionSegment ?? "").trim();
        const sessionIdsInStore = sessions().map((session) => session.id);
        const sessionIdsInSidebar = sidebarWorkspaceGroups().flatMap((group) =>
          group.sessions.map((session) => session.id)
        );
        const shouldFallbackFromRoute = id
          ? shouldFallbackFromSessionRoute({
            sessionsLoaded: sessionsLoaded(),
            routeSessionId: id,
            sessionIdsInStore,
            sessionIdsInSidebar,
            scopedSessionIds: scopedSessionIds(),
            selectedSessionId: selectedSessionId(),
            visibleMessageCount: visibleMessages().length,
            selectedSessionStatus: selectedSessionStatus(),
            selectedSessionLoadingEarlierMessages: selectedSessionLoadingEarlierMessages(),
          })
          : false;
        const sessionPathDecision = resolveSessionPathDecision({
          path: rawPath,
          routeSessionId: id,
          activePendingDraftKey: activePendingDraftKey(),
          selectedSessionId: selectedSessionId(),
          isPendingSession: isPendingSessionInstanceId(id),
          shouldFallbackFromRoute,
          ownNavigationSessionId: routeResumeSelectionAlreadyHandledForSession,
        });

        switch (sessionPathDecision.type) {
          case "ignore":
            return;
          case "clear-session-view":
            if (sessionPathDecision.preservePendingDraft) {
              void activePendingDraftMeta();
            }
            if (selectedSessionId()) {
              clearDisplayedSessionForBareRoute();
            }
            return;
          case "select-pending-session":
            setSelectedSessionId(sessionPathDecision.sessionId);
            return;
          case "fallback-to-session-list":
            if (sessionPathDecision.clearSelectedSession) {
              setSelectedSessionId(null);
            }
            navigate("/session", { replace: true });
            return;
          case "consume-own-navigation":
            routeResumeSelectionAlreadyHandledForSession = "";
            return;
          case "select-session":
            void selectSession(sessionPathDecision.sessionId);
            return;
        }
        return;
      }
    }
  });

  return (
    <WorkspaceRoutingProvider value={workspaceRouting}>
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
          <SessionView {...sessionProps()} onOpenFeedback={openFeedbackModal} />
        </Match>
        <Match when={true}>
          <DashboardView {...dashboardProps()} onOpenFeedback={openFeedbackModal} />
        </Match>
      </Switch>

      <DesktopContextMenu />

      <WorkspaceSwitchOverlay
        open={workspaceSwitchOpen()}
        workspace={workspaceSwitchWorkspace()}
        statusKey={workspaceSwitchStatusKey()}
      />

      <FeedbackModal
        open={feedbackModalOpen()}
        error={feedbackSubmitError()}
        successIssueId={feedbackSubmitSuccessIssueId()}
        submitting={feedbackSubmitting()}
        onClose={closeFeedbackModal}
        onSubmit={submitFeedback}
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
        onForceStopSession={(sessionID) => abortSession(sessionID)}
        onClose={() => {
          setMcpAuthModalOpen(false);
          setMcpAuthEntry(null);
          setMcpAuthNeedsReload(false);
        }}
        onComplete={async () => {
          setMcpAuthModalOpen(false);
          setMcpAuthEntry(null);
          setMcpAuthNeedsReload(false);
          await refreshMcpServers();
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
          setDeepLinkRemoteWorkspaceDefaults(null);
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
