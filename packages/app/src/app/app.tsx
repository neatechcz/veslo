import {
  Match,
  Show,
  Switch,
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
import {
  COMPACTION_THRESHOLD_RATIO,
  resolveCompactionThreshold,
  shouldAutoCompact,
} from "./lib/auto-compaction";
import {
  clearLegacySessionModelPersistence,
  parseDefaultModelFromConfig,
  formatConfigWithDefaultModel,
  resolveWorkspaceDefaultModel,
} from "./lib/model-persistence";
import { buildModelPickerOptions } from "./lib/model-picker-options";
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
import { resolveSubagentRole } from "./lib/subagent-role-resolver";
import {
  parseSharedBundleDeepLink,
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
import { createSessionFromDirectorySelection } from "./pages/session-navigation";
import {
  SIDEBAR_SESSION_PAGE_SIZE,
  deriveSidebarHasMore,
  initialSidebarSessionLimit,
  nextSidebarSessionLimit,
} from "./pages/sidebar-session-pagination";
import ModelPickerModal from "./components/model-picker-modal";
import ResetModal from "./components/reset-modal";
import WorkspaceSwitchOverlay from "./components/workspace-switch-overlay";
import VesloLogo from "./components/veslo-logo";
import CreateRemoteWorkspaceModal from "./components/create-remote-workspace-modal";
import CreateWorkspaceModal from "./components/create-workspace-modal";
import RenameWorkspaceModal from "./components/rename-workspace-modal";
import McpAuthModal from "./components/mcp-auth-modal";
import OnboardingView from "./pages/onboarding";
import DashboardView from "./pages/dashboard";
import SessionView from "./pages/session";
import ProtoWorkspacesView from "./pages/proto-workspaces";
import ProtoV1UxView from "./pages/proto-v1-ux";
import {
  deleteSessionComposerDraft,
  getSessionComposerDraft,
  setSessionComposerDraft,
  setSessionComposerPrompt,
} from "./pages/session-composer-drafts";
import { createClient, unwrap, waitForHealthy, type OpencodeAuth } from "./lib/opencode";
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
import { createSkillReloadGuard } from "./lib/skill-reload-guard";
import {
  AUTO_COMPACT_CONTEXT_PREF_KEY,
  DEFAULT_MODEL,
  HIDE_TITLEBAR_PREF_KEY,
  LANGUAGE_PREF_KEY,
  MCP_QUICK_CONNECT,
  MODEL_PREF_KEY,
  SUGGESTED_PLUGINS,
  THINKING_PREF_KEY,
  VARIANT_PREF_KEY,
} from "./constants";
import { parseMcpServersFromContent, quickConnectEntryKey, removeMcpFromConfig, validateMcpServerName } from "./mcp";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "./types";
import type {
  Client,
  DashboardTab,
  MessageWithParts,
  PlaceholderAssistantMessage,
  StartupPreference,
  EngineRuntime,
  ModelOption,
  ModelRef,
  OnboardingStep,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
  ResetVesloMode,
  SettingsTab,
  SkillCard,
  SidebarSubagentDecoration,
  SidebarSessionItem,
  TodoItem,
  View,
  WorkspaceSessionGroup,
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
  ScheduledJob,
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
  isTauriRuntime,
  modelEquals,
  normalizeDirectoryQueryPath,
  normalizeDirectoryPath,
  preferredSessionWorkspaceRoot,
  sessionDirectoryMatchesRoot,
} from "./utils";
import { createStartupGuard } from "./utils/startup-guard";
import { computeWorkspaceSwitchOverlayHoldMs } from "./utils/workspace-switch-overlay";
import {
  parseAuthCompleteDeepLink,
  exchangeHandoffCode,
  getDesktopBrowserAuthStatus,
  hydrateDenAuthFromDesktopSnapshot,
  readDenAuth,
  resolveAuthenticatedDenUserLabel,
  resolvePreferredDenUserLabel,
  writeDenAuth,
  readDenKeepSignedIn,
  writeDenKeepSignedIn,
  getDenApiBase,
  startDesktopBrowserAuth,
  readDesktopAuthExchangeProof,
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
import { createExtensionsStore } from "./context/extensions";
import { useGlobalSync } from "./context/global-sync";
import { createWorkspaceStore } from "./context/workspace";
import {
  updaterEnvironment,
  readOpencodeConfig,
  writeOpencodeConfig,
  schedulerDeleteJob,
  schedulerListJobs,
  vesloServerInfo,
  orchestratorStatus,
  opencodeRouterInfo,
  setWindowDecorations,
  setWindowTitleBarStyle,
  workspaceCopyIntoFolder,
  workspaceVesloRead,
  workspaceVesloWrite,
  opencodeDbUpdateSessionDirectory,
  type OrchestratorStatus,
  type VesloServerInfo,
  type OpenCodeRouterInfo,
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
  readVesloServerSettings,
  writeVesloServerSettings,
  clearVesloServerSettings,
  type VesloAuditEntry,
  type VesloSoulHeartbeatEntry,
  type VesloSoulStatus,
  type VesloSessionArchiveRecord,
  type VesloSessionLatestRunArtifacts,
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
import { CLOUD_ONLY_MODE, resolveVesloCloudEnvironment } from "./lib/cloud-policy";
import {
  LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY,
  buildLegacyArchiveMigration,
  buildSessionArchiveSnapshot,
  sortArchivedSessionsByRecency,
  toSessionArchiveItem,
} from "./lib/session-archive-model";
import { isRemoteUiEnabled } from "./lib/runtime-policy";
import {
  resolveEffectiveConnectedProviderIds,
} from "./utils/providers";
import {
  createProviderAuthModule,
  describeProviderError,
  assertNoClientError,
  type ProviderAuthMethod,
  type ProviderOAuthStartResult,
} from "./lib/provider-auth";

type RemoteWorkspaceDefaults = {
  vesloHostUrl?: string | null;
  vesloToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export default function App() {
  const cloudEnvironment = resolveVesloCloudEnvironment(import.meta.env as Record<string, string | undefined>);
  const envVesloWorkspaceId = cloudEnvironment.workspaceId ?? null;

  // Workspace switch tracing is noisy, so only emit in developer mode.
  // (Veslo already has a developer mode toggle in Settings.)
  const wsDebugEnabled = () => developerMode();

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
  const [vesloAuditEntries, setVesloAuditEntries] = createSignal<VesloAuditEntry[]>([]);
  const [vesloAuditStatus, setVesloAuditStatus] = createSignal<"idle" | "loading" | "error">("idle");
  const [vesloAuditError, setVesloAuditError] = createSignal<string | null>(null);
  const [devtoolsWorkspaceId, setDevtoolsWorkspaceId] = createSignal<string | null>(null);
  const [authenticatedAccountId, setAuthenticatedAccountId] = createSignal<string | null>(null);

  const vesloServerLocalFallbackBaseUrl = createMemo(() => {
    if (!isTauriRuntime()) return "";
    if (startupPreference() === "server") return "";
    return deriveLocalVesloServerUrlFromOpencodeBaseUrl(baseUrl()) ?? "";
  });

  const vesloServerBaseUrl = createMemo(() => {
    const pref = startupPreference();
    const hostInfo = vesloServerHostInfo();
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
      const hostInfo = vesloServerHostInfo();
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

  const vesloArchiveClient = createMemo(() => {
    const baseUrl =
      normalizeVesloServerUrl(vesloServerSettings().urlOverride ?? "") ??
      normalizeVesloServerUrl(cloudEnvironment.vesloUrl) ??
      "";
    const token = vesloServerSettings().token?.trim() || cloudEnvironment.token?.trim() || "";
    const accountId = authenticatedAccountId()?.trim() ?? "";
    if (!baseUrl || !token || !accountId) return null;
    return createVesloServerClient({ baseUrl, token, accountId });
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
        intent: normalizeSharedBundleImportIntent(bundleInvite.intent),
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
    const info = vesloServerHostInfo();
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
    let delayMs = 10_000;

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
            : Math.min(delayMs * 2, 60_000);
      } catch {
        delayMs = Math.min(delayMs * 2, 60_000);
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

    const run = async () => {
      try {
        const info = await vesloServerInfo();
        if (active) setVesloServerHostInfo(info);
      } catch {
        if (active) setVesloServerHostInfo(null);
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

  const [client, setClient] = createSignal<Client | null>(null);
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
  const mountTime = Date.now();
  const [lastKnownConfigSnapshot, setLastKnownConfigSnapshot] = createSignal("");
  const [developerMode, setDeveloperMode] = createSignal(false);
  const [documentVisible, setDocumentVisible] = createSignal(true);

  createEffect(() => {
    if (developerMode()) return;
    clearPerfLogs();
  });

  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(
    null
  );
  const SESSION_BY_WORKSPACE_KEY = "veslo.workspace-last-session.v1";
  const SESSION_DIRECTORY_OVERRIDE_KEY = "veslo.session-workspace-override.v1";
  const SUBAGENT_DECORATIONS_PREF_KEY = "veslo.subagent-decorations.v1";
  const readSessionByWorkspace = () => {
    if (typeof window === "undefined") return {} as Record<string, string>;
    try {
      const raw = window.localStorage.getItem(SESSION_BY_WORKSPACE_KEY);
      if (!raw) return {} as Record<string, string>;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {} as Record<string, string>;
      return parsed as Record<string, string>;
    } catch {
      return {} as Record<string, string>;
    }
  };
  const writeSessionByWorkspace = (map: Record<string, string>) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SESSION_BY_WORKSPACE_KEY, JSON.stringify(map));
    } catch {
      // ignore
    }
  };
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
  const [workspaceDefaultModelReady, setWorkspaceDefaultModelReady] = createSignal(false);
  const [legacyDefaultModel, setLegacyDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [defaultModelExplicit, setDefaultModelExplicit] = createSignal(false);
  const [sessionAgentById, setSessionAgentById] = createSignal<Record<string, string>>({});
  const [providerAuthModalOpen, setProviderAuthModalOpen] = createSignal(false);
  const [providerAuthBusy, setProviderAuthBusy] = createSignal(false);
  const [providerAuthError, setProviderAuthError] = createSignal<string | null>(null);
  const [providerAuthMethods, setProviderAuthMethods] = createSignal<Record<string, ProviderAuthMethod[]>>({});

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

  const sessionStore = createSessionStore({
    client,
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot().trim(),
    selectedSessionId,
    setSelectedSessionId,
    sessionDirectoryOverrideById,
    developerMode,
    setError,
    setSseConnected,
    onReconnectNotice: (notice) => setSessionReconnectNotice(notice),
    markReloadRequired,
    onHotReloadApplied: () => {
      onHotReloadAppliedHandler?.();
    },
    onSessionLoadComplete: () => setPendingSessionLoad(null),
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

  const hydratedVesloServerClient = createMemo<VesloServerClient | null>(() => {
    const client = vesloServerClient();
    if (!client) return null;

    const hydratedClient: VesloServerClient = {
      ...client,
      prefetchSessionTranscripts: async (workspaceId, input) => {
        const result = await client.prefetchSessionTranscripts(workspaceId, input);
        for (const item of result.items) {
          hydrateTranscriptSnapshot(item);
        }
        return result;
      },
      getSessionTranscript: async (workspaceId, sessionId, limit = 140) => {
        const snapshot = await client.getSessionTranscript(workspaceId, sessionId, limit);
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
  const activeMessages = createMemo(() => messages());
  const activeTodos = createMemo(() => todos());
  const activeArtifacts = createMemo(() => artifacts());
  const activeWorkingFiles = createMemo(() => workingFiles());
  const currentLatestRunArtifactResponse = createMemo(() => {
    const response = latestRunArtifactResponse();
    const sessionId = selectedSessionId();
    const workspaceId = vesloServerWorkspaceId();
    if (!response || !sessionId || !workspaceId) return undefined;
    if (response.sessionId !== sessionId || response.workspaceId !== workspaceId) return undefined;
    return response;
  });
  const latestRunArtifactRefreshKey = createMemo(() => {
    const client = vesloServerClient();
    const workspaceId = vesloServerWorkspaceId();
    const sessionId = selectedSessionId();
    if (!client || !workspaceId || !sessionId || vesloServerStatus() !== "connected") return "";

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

    return `${workspaceId}:${sessionId}:${lastUserMessageId}:${partCount}`;
  });
  createEffect(() => {
    const key = latestRunArtifactRefreshKey();
    if (!key) {
      setLatestRunArtifactResponse(undefined);
      return;
    }

    const client = vesloServerClient();
    const workspaceId = vesloServerWorkspaceId();
    const sessionId = selectedSessionId();
    if (!client || !workspaceId || !sessionId) {
      setLatestRunArtifactResponse(undefined);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void client
        .getSessionLatestRunArtifacts(workspaceId, sessionId)
        .then((response) => {
          if (cancelled) return;
          if (response.sessionId !== sessionId || response.workspaceId !== workspaceId) return;
          setLatestRunArtifactResponse(response);
        })
        .catch(() => {
          if (cancelled) return;
          setLatestRunArtifactResponse(undefined);
        });
    }, 120);

    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
  });

  const sessionActivity = (session: Session) =>
    session.time?.updated ?? session.time?.created ?? 0;
  const sortSessionsByActivity = (list: Session[]) =>
    list
      .slice()
      .sort((a, b) => {
        const delta = sessionActivity(b) - sessionActivity(a);
        if (delta !== 0) return delta;
        return a.id.localeCompare(b.id);
      });

  const [sessionsLoaded, setSessionsLoaded] = createSignal(false);
  const loadSessionsWithReady = async (scopeRoot?: string) => {
    await loadSessions(scopeRoot);
    setSessionsLoaded(true);
  };

  createEffect(() => {
    if (!client()) {
      setSessionsLoaded(false);
    }
  });

  const [composerDraftBySessionId, setComposerDraftBySessionId] = createSignal<Record<string, ComposerDraft>>({});
  const composerDraft = createMemo(() =>
    getSessionComposerDraft(composerDraftBySessionId(), selectedSessionId()),
  );
  const setComposerDraft = (draft: ComposerDraft) => {
    setComposerDraftBySessionId((current) => setSessionComposerDraft(current, selectedSessionId(), draft));
  };
  const setPrompt = (value: string) => {
    setComposerDraftBySessionId((current) => setSessionComposerPrompt(current, selectedSessionId(), value));
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

  const stageAttachmentsIntoSessionDirectory = async (
    draft: ComposerDraft,
    sessionID: string,
  ): Promise<StagedSessionAttachment[]> => {
    const attachmentsToStage = draft.attachments;
    if (!attachmentsToStage.length) return [];

    const client = vesloServerClient();
    const workspaceId = (resolvedDevtoolsWorkspaceId() ?? "").trim();
    if (!client || !workspaceId || vesloServerStatus() !== "connected") {
      throw new Error("Connect to Veslo server before sending attachments.");
    }

    const reservedPaths = new Set<string>();
    const stagedAttachments: StagedSessionAttachment[] = [];
    const fileSession = await client.createFileSession(workspaceId, {
      ttlSeconds: 15 * 60,
      write: true,
    });

    try {
      for (const attachment of attachmentsToStage) {
        const file = await attachmentToFile(attachment);
        const preferredPath = resolveSessionDirectoryRelativePath(sessionID, file.name);
        const relativePath = await resolveCollisionSafeAttachmentPath(client, fileSession.session.id, preferredPath, reservedPaths);
        const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
        const writeResult = await client.writeFileBatch(fileSession.session.id, [
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
    } finally {
      await client.closeFileSession(fileSession.session.id).catch(() => undefined);
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
      if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
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
      if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
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

  async function maybeResolveSkillCommand(draft: ComposerDraft): Promise<ComposerDraft> {
    if (draft.mode !== "prompt" || draft.command) return draft;

    const text = (draft.resolvedText ?? draft.text).trim();
    if (!text || text.startsWith("/")) return draft;

    const vesloClient = vesloServerClient();
    const workspaceId = resolvedDevtoolsWorkspaceId();
    if (
      vesloServerStatus() !== "connected" ||
      !vesloClient ||
      !workspaceId ||
      typeof (vesloClient as unknown as { resolveSkill?: unknown }).resolveSkill !== "function"
    ) {
      return draft;
    }

    try {
      const includeGlobal = workspaceStore.activeWorkspaceDisplay().workspaceType === "local";
      const resolution = await (vesloClient as unknown as {
        resolveSkill: (
          workspaceId: string,
          payload: { text: string; includeGlobal?: boolean },
        ) => Promise<{ match?: { name?: string | null } | null }>;
      }).resolveSkill(workspaceId, {
        text,
        includeGlobal,
      });

      const matchedName = resolution?.match?.name?.trim();
      if (!matchedName) return draft;

      const commands = await listCommands();
      const matchedCommand = commands.find(
        (entry) => entry.name === matchedName && entry.source === "skill",
      );
      if (!matchedCommand) return draft;

      return {
        ...draft,
        command: {
          name: matchedName,
          arguments: text,
        },
      };
    } catch {
      return draft;
    }
  }

  async function sendPrompt(draft?: ComposerDraft): Promise<boolean> {
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
    resolvedDraft = await maybeResolveSkillCommand(resolvedDraft);

    const initialContent = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!initialContent && !resolvedDraft.attachments.length) return false;

    const c = client();
    if (!c) return false;

    const compactShortcut = /^\/compact(?:\s+.*)?$/i.test(initialContent);
    const compactCommand = resolvedDraft.command?.name === "compact" || compactShortcut;
    const commandName = compactCommand ? "compact" : (resolvedDraft.command?.name ?? null);
    if (compactCommand && !selectedSessionId()) {
      setError("Select a session with messages before running /compact.");
      return false;
    }

    let sessionID = selectedSessionId();
    if (!sessionID) {
      await createSessionAndOpen();
      sessionID = selectedSessionId();
    }
    if (!sessionID) return false;

    const model = selectedSessionModel();
    let promptSystem: string | undefined;

    try {
      const stagedAttachments = await stageAttachmentsIntoSessionDirectory(resolvedDraft, sessionID);
      const routedDraft = routeStagedAttachmentsForModel({
        draft: resolvedDraft,
        stagedAttachments,
        model,
        providers: providers(),
      });
      if (routedDraft.error) {
        setError(routedDraft.error);
        return false;
      }
      resolvedDraft = routedDraft.draft;
      promptSystem = routedDraft.system;
    } catch (error) {
      setError(error instanceof Error ? error.message : safeStringify(error));
      return false;
    }

    const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!content && !resolvedDraft.attachments.length && !promptSystem) return false;

    setBusy(true);
    setBusyLabel("status.running");
    setBusyStartedAt(Date.now());
    setError(null);

    const perfEnabled = developerMode();
    const startedAt = perfNow();
    const visible = messages();
    const visibleParts = visible.reduce((total, message) => total + message.parts.length, 0);
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

      const agent = selectedSessionAgent();
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

      if (resolvedDraft.mode === "shell") {
        await shellInSession(c, sessionID, content);
      } else if (resolvedDraft.command || compactCommand) {
        if (compactCommand) {
          await compactCurrentSession(sessionID);
          finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
            sessionID,
            mode: resolvedDraft.mode,
            command: commandName,
          });
          return true;
        }

        const command = resolvedDraft.command;
        if (!command) {
          throw new Error("Command was not resolved.");
        }

        // Slash command: route through session.command() API
        const modelString = `${model.providerID}/${model.modelID}`;
        const files = buildCommandFileParts(resolvedDraft);

        // session.command() expects `model` as a provider/model string and only supports file parts.
        unwrap(
          await c.session.command({
            sessionID,
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

      } else {
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
      }

      finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
      });
      return true;
    } catch (e) {
      finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
      const message = e instanceof Error ? e.message : safeStringify(e);
      sessionStore.appendSessionErrorTurn(sessionID, addOpencodeCacheHint(message));
      return false;
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function abortSession(sessionID?: string) {
    const c = client();
    if (!c) return;
    const id = (sessionID ?? selectedSessionId() ?? "").trim();
    if (!id) return;
    // OpenCode exposes session.abort which interrupts the active prompt/run.
    // We intentionally don't mutate global busy state here; the SessionView
    // provides local UX (button disabled + toast) for cancellation.
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
    });
  }

  async function compactCurrentSession(sessionIdOverride?: string) {
    const c = client();
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
      await compactSessionTyped(c, sessionID, model, {
        directory: sessionDirectoryOverrideById()[sessionID] ?? (workspaceProjectDir().trim() || undefined),
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

  async function undoLastUserMessage() {
    const c = client();
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
    const c = client();
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
    const c = client();
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
    setSidebarSessionsByWorkspaceId((prev) => ({
      ...prev,
      [sidebarWorkspaceId]: (prev[sidebarWorkspaceId] ?? []).filter((s) => s.id !== trimmed),
    }));

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
        const map = readSessionByWorkspace();
        if (map[activeWorkspace] === trimmed) {
          const next = { ...map };
          delete next[activeWorkspace];
          writeSessionByWorkspace(next);
        }
      }
    }

    const nextStatus = { ...sessionStatusById() };
    if (nextStatus[trimmed]) {
      delete nextStatus[trimmed];
      setSessionStatusById(nextStatus);
    }
  }


  async function listAgents(): Promise<Agent[]> {
    const c = client();
    if (!c) return [];
    const list = unwrap(await c.app.agents());
    return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  }

  const BUILTIN_COMPACT_COMMAND = {
    id: "builtin:compact",
    name: "compact",
    description: "Summarize this session to reduce context size.",
    source: "command" as const,
  };

  async function listCommands(): Promise<{ id: string; name: string; description?: string; source?: "command" | "mcp" | "skill" }[]> {
    const c = client();
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

  // Provider auth module – delegates to lib/provider-auth.ts
  // The module is created lazily (after globalSync / workspaceStore are ready).
  let _providerAuth: ReturnType<typeof createProviderAuthModule> | null = null;
  const getProviderAuth = () => {
    if (!_providerAuth) {
      _providerAuth = createProviderAuthModule({
        getClient: client,
        getProviders: providers,
        getProviderDefaults: providerDefaults,
        getProviderAuthMethods: providerAuthMethods,
        getWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
        setProviderAuthError,
        globalSyncSetProvider: (data) => globalSync.set("provider", data as Parameters<typeof globalSync.set>[1]),
        globalSyncSetProviderMerged: (data, mergedConnected) =>
          globalSync.set("provider", { ...(data as Record<string, unknown>), connected: mergedConnected } as Parameters<typeof globalSync.set>[1]),
        unwrap,
        isTauriRuntime,
        readOpencodeConfig,
        writeOpencodeConfig,
      });
    }
    return _providerAuth;
  };

  const loadProviderAuthMethods = () => getProviderAuth().loadProviderAuthMethods();
  const startProviderAuth = (providerId?: string) => getProviderAuth().startProviderAuth(providerId);
  const completeProviderAuthOAuth = (providerId: string, methodIndex: number, code?: string) =>
    getProviderAuth().completeProviderAuthOAuth(providerId, methodIndex, code);
  const submitProviderApiKey = (providerId: string, apiKey: string) =>
    getProviderAuth().submitProviderApiKey(providerId, apiKey);
  const testProviderApiKey = (providerId: string, apiKey: string) =>
    getProviderAuth().testProviderApiKey(providerId, apiKey);
  const disconnectProvider = (providerId: string) => getProviderAuth().disconnectProvider(providerId);
  const connectLmStudioProvider = (baseUrlInput?: string) =>
    getProviderAuth().connectLmStudioProvider(baseUrlInput);

  async function openProviderAuthModal() {
    setProviderAuthBusy(true);
    setProviderAuthError(null);
    try {
      const methods = await loadProviderAuthMethods();
      setProviderAuthMethods(methods);
      setProviderAuthModalOpen(true);
    } catch (error) {
      const message = describeProviderError(error, "Failed to load providers");
      setProviderAuthError(message);
      throw error;
    } finally {
      setProviderAuthBusy(false);
    }
  }

  function closeProviderAuthModal() {
    setProviderAuthModalOpen(false);
    setProviderAuthError(null);
  }

  async function saveSessionExport(sessionID: string) {
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const session = unwrap(await c.session.get({ sessionID }));
    const messages = unwrap(await c.session.messages({ sessionID }));
    let todos: TodoItem[] = [];
    try {
      todos = unwrap(await c.session.todo({ sessionID }));
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
  const [mcpConnectingName, setMcpConnectingName] = createSignal<string | null>(null);
  const [selectedMcp, setSelectedMcp] = createSignal<string | null>(null);
  const [scheduledJobs, setScheduledJobs] = createSignal<ScheduledJob[]>([]);
  const [scheduledJobsStatus, setScheduledJobsStatus] = createSignal<string | null>(null);
  const [scheduledJobsBusy, setScheduledJobsBusy] = createSignal(false);
  const [scheduledJobsUpdatedAt, setScheduledJobsUpdatedAt] = createSignal<number | null>(null);
  const [soulStatusByWorkspaceId, setSoulStatusByWorkspaceId] = createSignal<
    Record<string, VesloSoulStatus | null>
  >({});
  const [activeSoulHeartbeats, setActiveSoulHeartbeats] = createSignal<VesloSoulHeartbeatEntry[]>([]);
  const [soulStatusBusy, setSoulStatusBusy] = createSignal(false);
  const [soulHeartbeatsBusy, setSoulHeartbeatsBusy] = createSignal(false);
  const [soulError, setSoulError] = createSignal<string | null>(null);

  // MCP OAuth modal state
  const [mcpAuthModalOpen, setMcpAuthModalOpen] = createSignal(false);
  const [mcpAuthEntry, setMcpAuthEntry] = createSignal<(typeof MCP_QUICK_CONNECT)[number] | null>(null);
  const [mcpAuthNeedsReload, setMcpAuthNeedsReload] = createSignal(false);

  const extensionsStore = createExtensionsStore({
    client,
    projectDir: () => workspaceProjectDir(),
    activeWorkspaceRoot: () => workspaceStore.activeWorkspaceRoot(),
    workspaceType: () => workspaceStore.activeWorkspaceDisplay().workspaceType,
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
    hubSkills,
    hubSkillsStatus,
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
    refreshHubSkills,
    refreshPlugins,
    addPlugin,
    removePlugin,
    importLocalSkill,
    installSkillCreator,
    installHubSkill,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    abortRefreshes,
  } = extensionsStore;

  const globalSync = useGlobalSync();
  const providers = createMemo(() => globalSync.data.provider.all ?? []);
  const providerDefaults = createMemo(() => globalSync.data.provider.default ?? {});
  const providerConnectedIds = createMemo(() =>
    resolveEffectiveConnectedProviderIds(
      providers(),
      globalSync.data.provider.connected ?? [],
    ),
  );
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
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<
    "session" | "default"
  >("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");

  const [showThinking, setShowThinking] = createSignal(false);
  const [hideTitlebar, setHideTitlebar] = createSignal(false);
  const [autoCompactContext, setAutoCompactContext] = createSignal(true);
  const [modelVariant, setModelVariant] = createSignal<string | null>(null);
  const [autoCompactingSessionId, setAutoCompactingSessionId] = createSignal<string | null>(null);

  const MODEL_VARIANT_OPTIONS = [
    { value: "none", labelKey: "session.thinking_option_none" },
    { value: "low", labelKey: "session.thinking_option_low" },
    { value: "medium", labelKey: "session.thinking_option_medium" },
    { value: "high", labelKey: "session.thinking_option_high" },
    { value: "xhigh", labelKey: "session.thinking_option_xhigh" },
  ];

  const normalizeModelVariant = (value: string | null) => {
    if (!value) return null;
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "balance" || trimmed === "balanced") return "none";
    const match = MODEL_VARIANT_OPTIONS.find((option) => option.value === trimmed);
    return match ? match.value : null;
  };

  const resolveCodexReasoningEffort = (modelID: string, variant: string | null) => {
    if (!modelID.trim().toLowerCase().includes("codex")) return undefined;
    const normalized = normalizeModelVariant(variant);
    if (!normalized || normalized === "none") return undefined;
    if (normalized === "xhigh") return "high";
    return normalized;
  };

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
    vesloServerClient,
    onEngineStable: () => {},
    engineRuntime,
    developerMode,
  });

  const activeArtifactFamilies = createMemo(() =>
    resolveArtifactFamilies({
      serverArtifacts: currentLatestRunArtifactResponse()?.items,
      preferServerArtifacts: Boolean(currentLatestRunArtifactResponse()),
      legacyArtifacts: currentLatestRunArtifactResponse() ? [] : artifacts(),
      workingFiles: currentLatestRunArtifactResponse() ? [] : workingFiles(),
      workspaceRoot: workspaceStore.activeWorkspaceRoot().trim(),
    }),
  );

  type SidebarWorkspaceSessionsStatus = WorkspaceSessionGroup["status"];
  const [sidebarSessionsByWorkspaceId, setSidebarSessionsByWorkspaceId] = createSignal<
    Record<string, SidebarSessionItem[]>
  >({});
  const [sidebarSessionStatusByWorkspaceId, setSidebarSessionStatusByWorkspaceId] = createSignal<
    Record<string, SidebarWorkspaceSessionsStatus>
  >({});
  const [sidebarSessionErrorByWorkspaceId, setSidebarSessionErrorByWorkspaceId] = createSignal<
    Record<string, string | null>
  >({});
  const [sidebarSessionLimitByWorkspaceId, setSidebarSessionLimitByWorkspaceId] = createSignal<
    Record<string, number>
  >({});
  const [sidebarSessionHasMoreByWorkspaceId, setSidebarSessionHasMoreByWorkspaceId] = createSignal<
    Record<string, boolean>
  >({});
  const [sidebarSessionLoadingMoreByWorkspaceId, setSidebarSessionLoadingMoreByWorkspaceId] = createSignal<
    Record<string, boolean>
  >({});

  const pruneSidebarSessionState = (workspaceIds: Set<string>) => {
    setSidebarSessionsByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, SidebarSessionItem[]> = {};
      for (const [id, list] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = list;
      }
      return changed ? next : prev;
    });
    setSidebarSessionStatusByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, SidebarWorkspaceSessionsStatus> = {};
      for (const [id, status] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = status;
      }
      return changed ? next : prev;
    });
    setSidebarSessionErrorByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, string | null> = {};
      for (const [id, error] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = error;
      }
      return changed ? next : prev;
    });
    setSidebarSessionLimitByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, limit] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = limit;
      }
      return changed ? next : prev;
    });
    setSidebarSessionHasMoreByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, hasMore] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = hasMore;
      }
      return changed ? next : prev;
    });
    setSidebarSessionLoadingMoreByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, loading] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = loading;
      }
      return changed ? next : prev;
    });
  };

  const resolveSidebarClientConfig = (workspaceId: string) => {
    const workspace = workspaceStore.workspaces().find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) return null;

    if (workspace.workspaceType === "local") {
      const info = workspaceStore.engine();
      const baseUrl = info?.baseUrl?.trim() ?? "";
      const directory = workspace.path?.trim() ?? "";
      const username = info?.opencodeUsername?.trim() ?? "";
      const password = info?.opencodePassword?.trim() ?? "";
      const auth: OpencodeAuth | undefined = username && password ? { username, password } : undefined;
      return {
        baseUrl,
        directory,
        auth,
      };
    }

    const baseUrl = workspace.baseUrl?.trim() ?? "";
    const directory = workspace.directory?.trim() ?? "";
    if (workspace.remoteType === "veslo") {
      // Sidebar session listing should be per-workspace and should not implicitly depend on
      // global Veslo server settings, otherwise switching between remotes can cause other
      // workspace task lists to appear/disappear.
      const token = workspace.vesloToken?.trim() ?? "";
      const auth: OpencodeAuth | undefined = token ? { token, mode: "veslo" } : undefined;
      return {
        baseUrl,
        directory,
        auth,
      };
    }
    return {
      baseUrl,
      directory,
      auth: undefined as OpencodeAuth | undefined,
    };
  };

  const sidebarRefreshSeqByWorkspaceId: Record<string, number> = {};
  const refreshSidebarWorkspaceSessions = async (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;

    const config = resolveSidebarClientConfig(id);
    if (!config) return;

    // For local workspaces, avoid thrashing UI with errors if the engine is offline.
    if (!config.baseUrl) {
      let changed = false;
      setSidebarSessionStatusByWorkspaceId((prev) => {
        if (prev[id] === "idle") return prev;
        changed = true;
        return { ...prev, [id]: "idle" };
      });
      setSidebarSessionErrorByWorkspaceId((prev) => {
        if ((prev[id] ?? null) === null) return prev;
        changed = true;
        return { ...prev, [id]: null };
      });
      setSidebarSessionHasMoreByWorkspaceId((prev) => {
        if ((prev[id] ?? false) === false) return prev;
        changed = true;
        return { ...prev, [id]: false };
      });
      if (changed) {
        wsDebug("sidebar:skip", { id, reason: "no-baseUrl" });
      }
      return;
    }

    sidebarRefreshSeqByWorkspaceId[id] = (sidebarRefreshSeqByWorkspaceId[id] ?? 0) + 1;
    const seq = sidebarRefreshSeqByWorkspaceId[id];

    setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "loading" }));
    setSidebarSessionErrorByWorkspaceId((prev) => ({ ...prev, [id]: null }));

    try {
      const start = Date.now();
      let directory = config.directory;
      let c = createClient(config.baseUrl, directory || undefined, config.auth);

      if (!directory) {
        try {
          const pathInfo = unwrap(await c.path.get());
          const discovered = normalizeDirectoryQueryPath(pathInfo.directory ?? "");
          if (discovered) {
            directory = discovered;
            c = createClient(config.baseUrl, directory, config.auth);
          }
        } catch {
          // ignore
        }
      }

      const queryDirectory = normalizeDirectoryQueryPath(directory) || undefined;
      const requestLimit = sidebarSessionLimitByWorkspaceId()[id] ?? initialSidebarSessionLimit();

      // Fetch sessions scoped to the workspace directory to avoid loading the
      // full global session list for every workspace.
      // Keep `roots` unset so the backend returns both root sessions and child/subagent sessions.
      const list = unwrap(
        await c.session.list({ directory: queryDirectory, limit: requestLimit }),
      );
      wsDebug("sidebar:list", {
        id,
        baseUrl: config.baseUrl,
        directory: directory || null,
        queryDirectory: queryDirectory ?? null,
        count: list.length,
        limit: requestLimit,
        ms: Date.now() - start,
      });
      if (sidebarRefreshSeqByWorkspaceId[id] !== seq) return;

      // Defensive client-side filter in case upstream ignores the directory query.
      const root = normalizeDirectoryPath(directory);
      const filtered = root
        ? list
          .map((session) => applySessionDirectoryOverride(session))
          .filter((session) => sessionDirectoryMatchesRoot(resolveSessionDirectory(session), root))
        : list.map((session) => applySessionDirectoryOverride(session));

      const overrideIds = root
        ? Object.entries(sessionDirectoryOverrideById())
          .filter(([, directory]) => normalizeDirectoryPath(directory) === root)
          .map(([sessionID]) => sessionID)
        : [];
      const merged = new Map(filtered.map((session) => [session.id, session] as const));
      for (const sessionID of overrideIds) {
        if (merged.has(sessionID)) continue;
        try {
          // Fetch by ID without directory filter — the session may still be
          // registered under the old directory in the engine while the local
          // override already points to the new workspace root.
          const fetched = applySessionDirectoryOverride(
            unwrap(await c.session.get({ sessionID })),
          );
          merged.set(sessionID, fetched);
        } catch {
          // ignore stale local overrides
        }
      }

      const sorted = sortSessionsByActivity(Array.from(merged.values()));
      const items: SidebarSessionItem[] = sorted.map((session) => ({
        id: session.id,
        title: session.title,
        slug: session.slug,
        parentID: session.parentID,
        time: session.time,
        directory: session.directory,
      }));

      setSidebarSessionsByWorkspaceId((prev) => ({
        ...prev,
        [id]: items,
      }));
      setSidebarSessionHasMoreByWorkspaceId((prev) => ({
        ...prev,
        [id]: deriveSidebarHasMore(list.length, requestLimit),
      }));
      setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "ready" }));
    } catch (error) {
      if (sidebarRefreshSeqByWorkspaceId[id] !== seq) return;
      const message = error instanceof Error ? error.message : safeStringify(error);
      wsDebug("sidebar:error", { id, message });
      setSidebarSessionStatusByWorkspaceId((prev) => ({ ...prev, [id]: "error" }));
      setSidebarSessionErrorByWorkspaceId((prev) => ({ ...prev, [id]: message }));
    }
  };

  const loadMoreWorkspaceSidebarSessions = async (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    if (sidebarSessionLoadingMoreByWorkspaceId()[id]) return;
    if (sidebarSessionHasMoreByWorkspaceId()[id] === false) return;

    setSidebarSessionLoadingMoreByWorkspaceId((prev) => ({ ...prev, [id]: true }));
    setSidebarSessionLimitByWorkspaceId((prev) => ({
      ...prev,
      [id]: nextSidebarSessionLimit(
        prev[id] ?? initialSidebarSessionLimit(),
        SIDEBAR_SESSION_PAGE_SIZE,
      ),
    }));

    try {
      await refreshSidebarWorkspaceSessions(id);
    } finally {
      setSidebarSessionLoadingMoreByWorkspaceId((prev) => ({ ...prev, [id]: false }));
    }
  };

  const refreshAllSidebarWorkspaceSessions = async (prioritizeWorkspaceId?: string | null) => {
    const list = workspaceStore.workspaces();
    if (!list.length) return;
    const prioritize = (prioritizeWorkspaceId ?? "").trim();
    const ordered = prioritize
      ? [...list.filter((ws) => ws.id === prioritize), ...list.filter((ws) => ws.id !== prioritize)]
      : list;
    for (const ws of ordered) {
      await refreshSidebarWorkspaceSessions(ws.id);
      // Yield so long refresh passes don't block UI / timers.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  const refreshLocalSidebarWorkspaceSessions = async (prioritizeWorkspaceId?: string | null) => {
    const list = workspaceStore.workspaces().filter((ws) => ws.workspaceType === "local");
    if (!list.length) return;
    const prioritize = (prioritizeWorkspaceId ?? "").trim();
    const ordered = prioritize
      ? [...list.filter((ws) => ws.id === prioritize), ...list.filter((ws) => ws.id !== prioritize)]
      : list;
    for (const ws of ordered) {
      await refreshSidebarWorkspaceSessions(ws.id);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  let lastSidebarEngineKey = "";
  let lastSidebarWorkspaceKey = "";
  createEffect(() => {
    const engineInfo = workspaceStore.engine();
    const engineBaseUrl = engineInfo?.baseUrl?.trim() ?? "";
    const engineUser = engineInfo?.opencodeUsername?.trim() ?? "";
    const enginePass = engineInfo?.opencodePassword?.trim() ?? "";

    const engineKey = [engineBaseUrl, engineUser, enginePass].join("::");
    const workspaceKey = workspaceStore
      .workspaces()
      .map((ws) => {
        const root = ws.workspaceType === "local" ? ws.path?.trim() ?? "" : ws.directory?.trim() ?? "";
        const base = ws.workspaceType === "local" ? "" : ws.baseUrl?.trim() ?? "";
        const remoteType = ws.workspaceType === "remote" ? (ws.remoteType ?? "") : "";
        const token = ws.remoteType === "veslo" ? (ws.vesloToken?.trim() ?? "") : "";
        return [ws.id, ws.workspaceType, remoteType, root, base, token].join("|");
      })
      .join(";");

    // Sidebar session refreshes should only be driven by the engine auth/baseUrl or the workspace
    // definitions themselves. Global Veslo server settings are intentionally excluded so that
    // connecting/activating a remote does not cause other workspace task lists to refresh (and
    // potentially disappear) due to auth fallback changes.
    if (engineKey === lastSidebarEngineKey && workspaceKey === lastSidebarWorkspaceKey) return;

    const engineChanged = engineKey !== lastSidebarEngineKey;
    const workspacesChanged = workspaceKey !== lastSidebarWorkspaceKey;

    lastSidebarEngineKey = engineKey;
    lastSidebarWorkspaceKey = workspaceKey;

    pruneSidebarSessionState(new Set(workspaceStore.workspaces().map((ws) => ws.id)));

    wsDebug("sidebar:refresh", {
      engineChanged,
      workspacesChanged,
      activeWorkspaceId: workspaceStore.activeWorkspaceId(),
      engineBaseUrl,
    });

    // Avoid refreshing remote workspace sessions when only the local engine auth/baseUrl changes.
    // Remote->local switches commonly change engineBaseUrl, and refreshing every remote workspace
    // at the same time can trigger large /session responses and UI hangs.
    if (engineChanged && !workspacesChanged) {
      void refreshLocalSidebarWorkspaceSessions(workspaceStore.activeWorkspaceId()).catch(e => reportError(e, "sidebar.refreshLocal"));
      return;
    }

    void refreshAllSidebarWorkspaceSessions(workspaceStore.activeWorkspaceId()).catch(e => reportError(e, "sidebar.refreshAll"));
  });

  createEffect(() => {
    const id = workspaceStore.activeWorkspaceId().trim();
    if (!id) return;
    const status = sidebarSessionStatusByWorkspaceId()[id] ?? "idle";
    // Only auto-load once per workspace activation.
    // If a remote is offline, repeated retries here can create an endless refresh loop.
    if (status !== "idle") return;
    refreshSidebarWorkspaceSessions(id).catch(e => reportError(e, "sidebar.refreshSessions"));
  });

  createEffect(() => {
    const allSessions = sessions(); // reactive dependency on session store
    // When switching workers, the session store can update before the activeWorkspaceId flips.
    // Use connectingWorkspaceId as the authoritative target during the switch so we don't
    // accidentally overwrite another worker's sidebar sessions.
    const wsId = (workspaceStore.connectingWorkspaceId() ?? workspaceStore.activeWorkspaceId()).trim();
    if (!wsId) return;
    const status = sidebarSessionStatusByWorkspaceId()[wsId];

    // Only sync if sidebar is already in 'ready' state (not during initial load)
    if (status === "ready") {
      const activeWorkspace = workspaceStore.workspaces().find((workspace) => workspace.id === wsId) ?? null;
      const activeWorkspaceRoot = normalizeDirectoryPath(
        activeWorkspace?.workspaceType === "local"
          ? activeWorkspace.path
          : activeWorkspace?.directory ?? activeWorkspace?.path,
      );
      const scopedSessions = activeWorkspaceRoot
        ? allSessions.filter((session) =>
            sessionDirectoryMatchesRoot(resolveSessionDirectory(session), activeWorkspaceRoot),
          )
        : allSessions;
      const sorted = sortSessionsByActivity(scopedSessions);
      const requestLimit = sidebarSessionLimitByWorkspaceId()[wsId] ?? initialSidebarSessionLimit();
      const visibleRows = sorted.slice(0, requestLimit);
      setSidebarSessionsByWorkspaceId((prev) => ({
        ...prev,
        [wsId]: visibleRows.map((s) => ({
          id: s.id,
          title: s.title,
          slug: s.slug,
          parentID: s.parentID,
          time: s.time,
          directory: s.directory,
        })),
      }));
      setSidebarSessionHasMoreByWorkspaceId((prev) => ({
        ...prev,
        [wsId]: deriveSidebarHasMore(sorted.length, requestLimit),
      }));
    }
  });

  const sidebarWorkspaceGroups = createMemo<WorkspaceSessionGroup[]>(() => {
    const workspaces = workspaceStore.workspaces();
    const activeWorkspaceId = workspaceStore.activeWorkspaceId().trim();
    const connectingWorkspaceId = workspaceStore.connectingWorkspaceId()?.trim() ?? "";
    const sessionsById = sidebarSessionsByWorkspaceId();
    const statusById = sidebarSessionStatusByWorkspaceId();
    const errorById = sidebarSessionErrorByWorkspaceId();
    const dedupedWorkspaces: typeof workspaces = [];
    const dedupeKeyToIndex = new Map<string, number>();
    for (const workspace of workspaces) {
      if (workspace.workspaceType !== "remote") {
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const hostKey =
        normalizeVesloServerUrl(workspace.vesloHostUrl?.trim() ?? "") ??
        normalizeVesloServerUrl(workspace.baseUrl?.trim() ?? "") ??
        "";
      const workspaceIdKey =
        workspace.vesloWorkspaceId?.trim() ||
        parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
        parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
        "";
      const directoryKey = normalizeDirectoryPath(workspace.directory?.trim() ?? workspace.path?.trim() ?? "");
      const identityKey = workspaceIdKey ? `id:${workspaceIdKey}` : (directoryKey ? `dir:${directoryKey}` : "");
      if (!hostKey || !identityKey) {
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const dedupeKey = `${workspace.remoteType ?? ""}|${hostKey}|${identityKey}`;
      const existingIndex = dedupeKeyToIndex.get(dedupeKey);
      if (existingIndex === undefined) {
        dedupeKeyToIndex.set(dedupeKey, dedupedWorkspaces.length);
        dedupedWorkspaces.push(workspace);
        continue;
      }
      const existingWorkspace = dedupedWorkspaces[existingIndex];
      const existingIsPriority =
        existingWorkspace.id === activeWorkspaceId || existingWorkspace.id === connectingWorkspaceId;
      const currentIsPriority =
        workspace.id === activeWorkspaceId || workspace.id === connectingWorkspaceId;
      if (currentIsPriority && !existingIsPriority) {
        dedupedWorkspaces[existingIndex] = workspace;
      }
    }
    return dedupedWorkspaces.map((workspace) => {
      const groupSessions = sessionsById[workspace.id] ?? [];
      return {
        workspace,
        sessions: groupSessions,
        status: statusById[workspace.id] ?? "idle",
        error: errorById[workspace.id] ?? null,
      };
    });
  });

  const workspaceSessionPagingById = createMemo<Record<string, { hasMore: boolean; loadingMore: boolean }>>(() => {
    const hasMoreById = sidebarSessionHasMoreByWorkspaceId();
    const loadingById = sidebarSessionLoadingMoreByWorkspaceId();
    const paging: Record<string, { hasMore: boolean; loadingMore: boolean }> = {};
    for (const workspace of workspaceStore.workspaces()) {
      paging[workspace.id] = {
        hasMore: hasMoreById[workspace.id] ?? false,
        loadingMore: loadingById[workspace.id] ?? false,
      };
    }
    return paging;
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
    const accountId = authenticatedAccountId()?.trim() ?? "";
    if (!client || !accountId) {
      setSessionArchiveRecords([]);
      setSessionArchiveReady(true);
      return;
    }

    const response = await client.listSessionArchives();
    applySessionArchiveRecords(response.items ?? []);
  };

  let lastSessionArchiveClientKey = "";
  createEffect(() => {
    const client = vesloArchiveClient();
    const accountId = authenticatedAccountId()?.trim() ?? "";
    const key = client && accountId ? `${client.baseUrl}::${client.token ?? ""}::${accountId}` : "";
    if (key === lastSessionArchiveClientKey) return;
    lastSessionArchiveClientKey = key;
    setSessionArchiveReady(false);
    void loadSessionArchives().catch((error) => {
      reportError(error, "sessionArchives.load");
      setSessionArchiveRecords([]);
      setSessionArchiveReady(true);
    });
  });

  let sessionArchiveMigrationRunning = false;
  createEffect(() => {
    const client = vesloArchiveClient();
    const accountId = authenticatedAccountId()?.trim() ?? "";
    const ready = sessionArchiveReady();
    const records = sessionArchiveRecords();
    const groups = sidebarWorkspaceGroups();

    if (!client || !accountId || !ready || sessionArchiveMigrationRunning) return;
    if (readArchiveMigrationDone(accountId)) return;

    const legacyIds = readLegacyArchivedSessionIds();
    if (legacyIds.length === 0) {
      writeArchiveMigrationDone(accountId);
      return;
    }

    if (records.length > 0) {
      clearLegacyArchivedSessionIds();
      writeArchiveMigrationDone(accountId);
      return;
    }

    const migrationRecords = buildLegacyArchiveMigration(legacyIds, groups);
    if (migrationRecords.length === 0) {
      const allGroupsSettled =
        groups.length > 0 && groups.every((group) => group.status === "ready" || group.status === "error");
      if (allGroupsSettled) {
        clearLegacyArchivedSessionIds();
        writeArchiveMigrationDone(accountId);
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
        writeArchiveMigrationDone(accountId);
      } catch (error) {
        reportError(error, "sessionArchives.migrateLegacy");
      } finally {
        sessionArchiveMigrationRunning = false;
      }
    })();
  });

  const archiveSidebarSession = async (workspaceId: string, sessionId: string) => {
    const client = vesloArchiveClient();
    const accountId = authenticatedAccountId()?.trim() ?? "";
    if (!client || !accountId) {
      setError("Cloud sign-in is required to archive sessions.");
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
      writeArchiveMigrationDone(accountId);
    });
  };

  const unarchiveSession = async (sessionId: string) => {
    const client = vesloArchiveClient();
    const accountId = authenticatedAccountId()?.trim() ?? "";
    if (!client || !accountId) {
      setError("Cloud sign-in is required to unarchive sessions.");
      return;
    }

    await withPendingArchivedSession(sessionId, async () => {
      const response = await client.deleteSessionArchive(sessionId);
      applySessionArchiveRecords(response.items ?? []);
      clearLegacyArchivedSessionIds();
      writeArchiveMigrationDone(accountId);
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

  const buildSubagentRoleClassifierPrompt = (input: {
    locale: SubagentLocale;
    sessionTitle: string;
    parentSessionTitle: string;
  }) => {
    const language = input.locale === "cs" ? "Czech" : "English";
    return [
      "Return ONLY one JSON object with keys role_key, role_label, first_name.",
      "No markdown, no explanation.",
      `Language for role_label and first_name: ${language}.`,
      "Prefer stable role keys from this set when relevant:",
      "web-research, spreadsheet-processing, document-editing, slides-processing, coding, data-analysis, general-assistant",
      "role_key must be lowercase kebab-case ASCII.",
      "",
      `Subagent session title: ${input.sessionTitle || "(empty)"}`,
      `Parent session title: ${input.parentSessionTitle || "(empty)"}`,
    ].join("\n");
  };

  const runAiSubagentRoleClassifier = async (input: {
    locale: SubagentLocale;
    prompt: string;
  }) => {
    const c = client();
    if (!c) throw new Error("Client is not connected.");

    const created = unwrap(
      await c.session.create({
        title: "[Veslo] Subagent role classifier",
      }),
    );
    const sessionID = created.id;

    try {
      const model = defaultModel();
      const response = unwrap(
        await c.session.prompt({
          sessionID,
          model: model ? { providerID: model.providerID, modelID: model.modelID } : undefined,
          parts: [{ type: "text", text: input.prompt } as TextPartInput],
        }),
      );
      const textPart = response.parts.find((part) =>
        part.type === "text" && typeof (part as { text?: unknown }).text === "string",
      ) as (Part & { text?: string }) | undefined;
      return textPart?.text?.trim() ?? "";
    } finally {
      try {
        await c.session.abort({ sessionID });
      } catch {
        // ignore
      }
      try {
        await c.session.delete({ sessionID });
      } catch {
        // ignore
      }
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
    const classificationPrompt = buildSubagentRoleClassifierPrompt({
      locale,
      sessionTitle: candidate.sessionTitle,
      parentSessionTitle: candidate.parentSessionTitle,
    });
    const deterministic = classifySubagentRoleDeterministic({
      locale,
      prompt: `${candidate.sessionTitle}\n${candidate.parentSessionTitle}`,
    });

    let resolvedRoleKey = deterministic.roleKey;
    let resolvedRoleLabel = deterministic.roleLabel;
    let resolvedFirstName = deterministic.firstName;
    try {
      const resolved = await resolveSubagentRole(
        {
          locale,
          prompt: classificationPrompt,
          fallbackPrompt: `${candidate.sessionTitle}\n${candidate.parentSessionTitle}`,
          timeoutMs: 3_000,
        },
        {
          runAiClassifier: runAiSubagentRoleClassifier,
          classifyDeterministic: ({ locale: nextLocale, prompt }) =>
            classifySubagentRoleDeterministic({
              locale: nextLocale,
              prompt,
            }),
        },
      );
      resolvedRoleKey = resolved.roleKey;
      resolvedRoleLabel = resolved.roleLabel;
      resolvedFirstName = resolved.firstName;
    } catch {
      resolvedRoleKey = deterministic.roleKey;
      resolvedRoleLabel = deterministic.roleLabel;
      resolvedFirstName = deterministic.firstName;
    }

    const roleKey = normalizeSubagentRoleKey(resolvedRoleKey) ?? deterministic.roleKey;
    const roleProfile = roleProfileFromRoleKey(roleKey, locale);
    const roleLabel =
      resolvedRoleLabel?.trim() ||
      roleProfile?.roleLabel ||
      deterministic.roleLabel;
    const aiFirstName = resolvedFirstName?.trim() || deterministic.firstName;

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

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.activeWorkspaceId();
    const sessionId = selectedSessionId();
    if (!workspaceId || !sessionId) return;
    const map = readSessionByWorkspace();
    if (map[workspaceId] === sessionId) return;
    map[workspaceId] = sessionId;
    writeSessionByWorkspace(map);
  });

  createEffect(() => {
    // Only auto-select on bare /session. If the URL already includes /session/:id,
    // let the route-driven selector own the fetch to avoid duplicate selection runs.
    if (currentView() !== "session") return;
    const normalizedPath = location.pathname.toLowerCase().replace(/\/+$/, "");
    if (normalizedPath !== "/session") return;
    if (!client()) return;
    if (!sessionsLoaded()) return;
    if (creatingSession()) return;
    if (selectedSessionId()) return;

    // Keep /session as a draft-ready empty state until the user picks a session
    // or sends a prompt. Avoid auto-selecting prior sessions on app launch.
    return;
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
          const match = items.find((entry) => normalizeDirectoryPath(entry.path) === root);
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
    const hostInfo = vesloServerHostInfo();
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

    cancelDesktopAuthStatusPolling();
    setAuthCompleteExchangeBusy(true);
    setError(null);
    exchangeHandoffCode(code, exchangeProof).then((result) => {
      setAuthCompleteExchangeBusy(false);
      if (result.ok) {
        writeDenAuth(result.state);
        clearDesktopAuthExchangeProof(exchangeProof?.sessionId);
        setError(null);
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
      } else {
        console.error("[den-auth] exchange failed:", result.error);
        if (exchangeProof) {
          clearDesktopAuthExchangeProof(exchangeProof.sessionId);
        }
        setError(`Sign in failed: ${result.error}`);
        setOnboardingStep("auth");
        setView("onboarding");
      }
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
    const pendingExchangeProof = readDesktopAuthExchangeProof();
    if (pendingExchangeProof) {
      startDesktopAuthStatusPolling(pendingExchangeProof.sessionId);
    }

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

  const resolveDenUserLabel = (auth: ReturnType<typeof readDenAuth>) => {
    return resolveAuthenticatedDenUserLabel(auth);
  };

  createEffect(() => {
    authCompleteExchangeBusy();

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
      const shouldAttach = !client() || active.workspaceType !== "remote" || active.remoteType !== "veslo";
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
      if (hostInfo?.clientToken?.trim() && startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
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
      await workspaceStore.activateWorkspace(workspaceStore.activeWorkspaceId());
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

  const UPDATE_AUTO_CHECK_EVERY_MS = 12 * 60 * 60_000;
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

      setThemeMode("system");
      setEngineSource(isTauriRuntime() ? "sidecar" : "path");
      setEngineCustomBinPath("");
      setEngineRuntime("veslo-orchestrator");
      setDefaultModel(DEFAULT_MODEL);
      setLegacyDefaultModel(DEFAULT_MODEL);
      setDefaultModelExplicit(false);
      setShowThinking(false);
      setHideTitlebar(false);
      setAutoCompactContext(true);
      setModelVariant(null);
      setUpdateAutoCheck(true);
      setUpdateAutoDownload(false);
      setUpdateStatus({ state: "idle", lastCheckedAt: null });
      setDeveloperMode(false);

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

      return { ok: true, message: "Reset app config defaults. Restart Veslo if any stale settings remain." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reset app config defaults.";
      return { ok: false, message };
    }
  };

  const getUpdateLastCheckedAt = (state: ReturnType<typeof updateStatus>) => {
    if (state.state === "checking") return null;
    return state.lastCheckedAt ?? null;
  };

  const shouldAutoCheckForUpdates = () => {
    const state = updateStatus();
    const lastCheckedAt = getUpdateLastCheckedAt(state);
    if (!lastCheckedAt) return true;
    return Date.now() - lastCheckedAt >= UPDATE_AUTO_CHECK_EVERY_MS;
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

  createEffect(() => {
    if (!pendingSkillFallbackAutoReload()) return;
    if (!reloadRequired()) {
      setPendingSkillFallbackAutoReload(false);
      return;
    }
    if (reloadBusy()) return;

    const reasons = reloadReasons();
    if (reasons.length !== 1 || reasons[0] !== "skills") {
      setPendingSkillFallbackAutoReload(false);
      return;
    }

    if (reloadTrigger()?.type !== "skill") return;
    if (!canReloadWorkspace()) return;
    if (activeReloadBlockingSessions().length > 0) return;

    setPendingSkillFallbackAutoReload(false);
    void reloadWorkspaceEngineAndResume();
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
  const resolveVesloScheduler = () => {
    const isRemoteWorkspace = workspaceStore.activeWorkspaceDisplay().workspaceType === "remote";
    if (!isRemoteWorkspace) return null;
    const client = vesloServerClient();
    const workspaceId = vesloServerWorkspaceId();
    if (vesloServerStatus() !== "connected" || !client || !workspaceId) return null;
    return { client, workspaceId };
  };

  const scheduledJobsSource = createMemo<"local" | "remote">(() => {
    return workspaceStore.activeWorkspaceDisplay().workspaceType === "remote" ? "remote" : "local";
  });

  const scheduledJobsSourceReady = createMemo(() => {
    if (scheduledJobsSource() !== "remote") return true;
    const client = vesloServerClient();
    const workspaceId = vesloServerWorkspaceId();
    return vesloServerStatus() === "connected" && Boolean(client && workspaceId);
  });

  const schedulerPluginInstalled = createMemo(() => isPluginInstalledByName("opencode-scheduler"));

  const refreshScheduledJobs = async (options?: { force?: boolean }) => {
    if (scheduledJobsBusy() && !options?.force) return;

    if (scheduledJobsSource() === "remote") {
      const scheduler = resolveVesloScheduler();
      if (!scheduler) {
        setScheduledJobs([]);
        const status =
          vesloServerStatus() === "disconnected"
            ? "Veslo server unavailable. Connect to sync scheduled tasks."
            : vesloServerStatus() === "limited"
              ? "Veslo server needs a token to load scheduled tasks."
              : "Veslo server not ready.";
        setScheduledJobsStatus(status);
        return;
      }

      setScheduledJobsBusy(true);
      setScheduledJobsStatus(null);

      try {
        const response = await scheduler.client.listScheduledJobs(scheduler.workspaceId);
        const jobs = Array.isArray(response.items) ? response.items : [];
        setScheduledJobs(jobs);
        setScheduledJobsUpdatedAt(Date.now());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setScheduledJobs([]);
        setScheduledJobsStatus(message || "Failed to load scheduled tasks.");
      } finally {
        setScheduledJobsBusy(false);
      }
      return;
    }

    if (!isTauriRuntime()) {
      setScheduledJobs([]);
      setScheduledJobsStatus(null);
      return;
    }

    if (isWindowsPlatform()) {
      setScheduledJobs([]);
      setScheduledJobsStatus(null);
      return;
    }

    if (!schedulerPluginInstalled()) {
      setScheduledJobs([]);
      setScheduledJobsStatus(null);
      return;
    }

    setScheduledJobsBusy(true);
    setScheduledJobsStatus(null);

    try {
      const root = workspaceStore.activeWorkspaceRoot().trim();
      const jobs = await schedulerListJobs(root || undefined);
      setScheduledJobs(jobs);
      setScheduledJobsUpdatedAt(Date.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setScheduledJobs([]);
      setScheduledJobsStatus(message || "Failed to load scheduled tasks.");
    } finally {
      setScheduledJobsBusy(false);
    }
  };

  const deleteScheduledJob = async (name: string) => {
    if (scheduledJobsSource() === "remote") {
      const scheduler = resolveVesloScheduler();
      if (!scheduler) {
        throw new Error("Veslo server unavailable. Connect to sync scheduled tasks.");
      }
      const response = await scheduler.client.deleteScheduledJob(scheduler.workspaceId, name);
      setScheduledJobs((current) => current.filter((entry) => entry.slug !== response.job.slug));
      return;
    }

    if (!isTauriRuntime()) {
      throw new Error("Scheduled tasks require the desktop app.");
    }
    if (isWindowsPlatform()) {
      throw new Error("Scheduler is not supported on Windows yet.");
    }
    const root = workspaceStore.activeWorkspaceRoot().trim();
    const job = await schedulerDeleteJob(name, root || undefined);
    setScheduledJobs((current) => current.filter((entry) => entry.slug !== job.slug));
    return;
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

  const refreshSoulData = async (options?: { force?: boolean }) => {
    if (soulStatusBusy() && !options?.force) return;

    const client = vesloServerClient();
    if (!client || vesloServerStatus() !== "connected") {
      setSoulStatusByWorkspaceId({});
      setActiveSoulHeartbeats([]);
      setSoulHeartbeatsBusy(false);
      setSoulError(null);
      return;
    }

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
    if (!client()) {
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
    if (client()) return;
    if (vesloServerStatus() !== "connected") return;

    const settings = vesloServerSettings();
    if (!settings.urlOverride || !settings.token) return;

    setAutoConnectAttempted(true);
    void workspaceStore.onConnectClient();
  });

  const selectedSessionModel = createMemo<ModelRef>(() => {
    return resolveGlobalRuntimeModel(defaultModel());
  });

  const selectedSessionAgent = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return null;
    return sessionAgentById()[id] ?? null;
  });

  const modelPickerCurrent = createMemo(() => selectedSessionModel());

  const modelOptions = createMemo<ModelOption[]>(() => {
    return buildModelPickerOptions({
      providers: providers(),
      providerDefaults: providerDefaults(),
      connectedProviderIds: providerConnectedIds(),
      currentDefault: defaultModel(),
      currentSelection: modelPickerCurrent(),
      labels: {
        default: t("settings.model_default", currentLocale()),
        reasoning: t("settings.model_reasoning", currentLocale()),
        disconnected: t("status.disconnected", currentLocale()),
      },
    });
  });

  const filteredModelOptions = createMemo(() => {
    const q = modelPickerQuery().trim().toLowerCase();
    const options = modelOptions();
    if (!q) return options;

    return options.filter((opt) => {
      const haystack = [
        opt.title,
        opt.description ?? "",
        opt.footer ?? "",
        `${opt.providerID}/${opt.modelID}`,
        opt.isConnected ? "connected" : "disconnected",
        opt.isFree ? "free" : "paid",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  function openDefaultModelPicker() {
    setModelPickerTarget("default");
    setModelPickerQuery("");
    setModelPickerOpen(true);
  }

  function applyModelSelection(next: ModelRef) {
    setDefaultModelExplicit(true);
    setDefaultModel(next);
    setModelPickerOpen(false);

    if (typeof window !== "undefined" && currentView() === "session") {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("veslo:focusPrompt"));
      });
    }
  }

  function openSettingsFromModelPicker() {
    setTab("settings");
    setView("dashboard");
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

  async function refreshMcpServers() {
    const filterConfiguredStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
      const configured = new Set(entries.map((entry) => entry.name));
      return Object.fromEntries(Object.entries(status).filter(([name]) => configured.has(name))) as McpStatusMap;
    };

    const projectDir = workspaceProjectDir().trim();
    const isRemoteWorkspace = workspaceStore.activeWorkspaceDisplay().workspaceType === "remote";
    const isLocalWorkspace = !isRemoteWorkspace;
    const vesloClient = vesloServerClient();
    const vesloWorkspaceId = vesloServerWorkspaceId();
    const vesloCapabilities = resolvedVesloCapabilities();
    const canUseVesloServer =
      vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.mcp?.read;

    if (isRemoteWorkspace) {
      if (!canUseVesloServer) {
        setMcpStatus("Veslo server unavailable. MCP config is read-only.");
        setMcpServers([]);
        setMcpStatuses({});
        return;
      }

      try {
        setMcpStatus(null);
        const response = await vesloClient.listMcp(vesloWorkspaceId);
        const next = response.items.map((entry) => ({
          name: entry.name,
          config: entry.config as McpServerEntry["config"],
        }));
        setMcpServers(next);
        setMcpLastUpdatedAt(Date.now());

        const activeClient = client();
        if (activeClient && projectDir) {
          try {
            const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
            setMcpStatuses(filterConfiguredStatuses(status as McpStatusMap, next));
          } catch {
            setMcpStatuses({});
          }
        } else {
          setMcpStatuses({});
        }

        if (!next.length) {
          setMcpStatus("No MCP servers configured yet.");
        }
      } catch (e) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
      }
      return;
    }

    if (isLocalWorkspace && canUseVesloServer) {
      try {
        setMcpStatus(null);
        const response = await vesloClient.listMcp(vesloWorkspaceId);
        const next = response.items.map((entry) => ({
          name: entry.name,
          config: entry.config as McpServerEntry["config"],
        }));
        setMcpServers(next);
        setMcpLastUpdatedAt(Date.now());

        const activeClient = client();
        if (activeClient && projectDir) {
          try {
            const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
            setMcpStatuses(filterConfiguredStatuses(status as McpStatusMap, next));
          } catch {
            setMcpStatuses({});
          }
        } else {
          setMcpStatuses({});
        }

        if (!next.length) {
          setMcpStatus("No MCP servers configured yet.");
        }
      } catch (e) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setMcpStatus("MCP configuration is only available for local workspaces.");
      setMcpServers([]);
      setMcpStatuses({});
      return;
    }

    if (!projectDir) {
      setMcpStatus("Pick a workspace folder to load MCP servers.");
      setMcpServers([]);
      setMcpStatuses({});
      return;
    }

    try {
      setMcpStatus(null);
      const config = await readOpencodeConfig("project", projectDir);
      if (!config.exists || !config.content) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus("No opencode.json found yet. Create one by connecting an MCP.");
        return;
      }

      const next = parseMcpServersFromContent(config.content);
      setMcpServers(next);
      setMcpLastUpdatedAt(Date.now());

      const activeClient = client();
      if (activeClient) {
        try {
          const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
          setMcpStatuses(filterConfiguredStatuses(status as McpStatusMap, next));
        } catch {
          setMcpStatuses({});
        }
      }

      if (!next.length) {
        setMcpStatus("No MCP servers configured yet.");
      }
    } catch (e) {
      setMcpServers([]);
      setMcpStatuses({});
      setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
    }
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

    let activeClient = client();
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
      finishPerf(developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "no-active-client",
      });
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
      finishPerf(developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace-after-discovery",
      });
      return;
    }

    const slug = quickConnectEntryKey(entry);

    try {
      setMcpStatus(null);
      setMcpConnectingName(entry.name);

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

      const mcpAddConfig =
        entryType === "remote"
          ? {
            type: "remote" as const,
            url: entry.url!,
            enabled: true,
            ...(entry.oauth ? { oauth: {} } : {}),
          }
          : {
            type: "local" as const,
            command: entry.command!,
            enabled: true,
          };

      const status = unwrap(
        await activeClient.mcp.add({
          directory: resolvedProjectDir,
          name: slug,
          config: mcpAddConfig,
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

    const matchingQuickConnect = MCP_QUICK_CONNECT.find((candidate) => {
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

    let activeClient = client();
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

  async function createSessionAndOpen() {
    // Block session creation while a workspace switch is in progress.
    // Without this gate, activeWorkspaceRoot() can return a stale or empty
    // value and the session ends up in the wrong directory.
    if (workspaceStore.connectingWorkspaceId()) {
      console.warn(
        "[createSessionAndOpen] Blocked: workspace switch in progress",
        { connectingWorkspaceId: workspaceStore.connectingWorkspaceId() },
      );
      setError("Please wait for the workspace switch to complete.");
      return undefined;
    }

    const c = client();
    if (!c) {
      setError("Local runtime is not ready yet.");
      return undefined;
    }

    // Guard against creating a session with an empty directory, which would
    // cause the bridge to silently fall back to the orchestrator's default
    // directory (possibly a temp folder or the wrong workspace).
    const sessionDirectory = workspaceStore.activeWorkspaceRoot().trim();
    if (!sessionDirectory) {
      console.warn(
        "[createSessionAndOpen] Blocked: activeWorkspaceRoot is empty",
      );
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
      workspace: workspaceStore.activeWorkspaceRoot().trim() || null,
    });

    // Abort any in-flight refresh operations to free up connection resources
    abortRefreshes();

    // Small delay to allow pending requests to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    setBusy(true);
    setBusyLabel("status.creating_task");
    setBusyStartedAt(Date.now());
    setError(null);
    setCreatingSession(true);

    const withTimeout = async <T,>(
      promise: Promise<T>,
      ms: number,
      label: string
    ) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          ms
        );
      });
      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    };

    try {
      // Quick health check to detect stale connection
      mark("health:start");
      try {
        await withTimeout(c.global.health(), 3_000, "health");
        mark("health:ok");
      } catch (healthErr) {
        mark("health:error", {
          error: healthErr instanceof Error ? healthErr.message : safeStringify(healthErr),
        });
        throw new Error(t("app.connection_lost", currentLocale()));
      }

      let rawResult: Awaited<ReturnType<typeof c.session.create>>;
      try {
        mark("session:create:start");
        rawResult = await c.session.create({
          directory: sessionDirectory,
        });
        mark("session:create:ok");
      } catch (createErr) {
        mark("session:create:error", {
          error: createErr instanceof Error ? createErr.message : safeStringify(createErr),
        });
        throw createErr;
      }

      const session = unwrap(rawResult);
      // Immediately select and show the new session before background list refresh.
      setBusyLabel("status.loading_session");
      mark("session:select:start", { sessionID: session.id });
      await selectSession(session.id);
      mark("session:select:ok", { sessionID: session.id });

      // Inject the new session into the reactive sessions() store so
      // the createEffect bridge (sessions → sidebar) will always include it,
      // even if the background loadSessionsWithReady hasn't returned yet.
      const currentStoreSessions = sessions();
      if (!currentStoreSessions.some((s) => s.id === session.id)) {
        setSessions([session, ...currentStoreSessions]);
      }

      const newItem: SidebarSessionItem = {
        id: session.id,
        title: session.title,
        slug: session.slug,
        parentID: session.parentID,
        time: session.time,
        directory: session.directory,
      };
      const wsId = (workspaceStore.connectingWorkspaceId() ?? workspaceStore.activeWorkspaceId()).trim();
      if (wsId) {
        const currentSessions = sidebarSessionsByWorkspaceId()[wsId] || [];
        setSidebarSessionsByWorkspaceId((prev) => ({
          ...prev,
          [wsId]: [newItem, ...currentSessions],
        }));
        setSidebarSessionStatusByWorkspaceId((prev) => ({
          ...prev,
          [wsId]: "ready",
        }));
      }

      // setSessionViewLockUntil(Date.now() + 1200);
      goToSession(session.id);

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
      return session.id;
    } catch (e) {
      finishPerf(perfEnabled, "session.create", "error", startedAt, {
        runId,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
      const message = e instanceof Error ? e.message : t("app.unknown_error", currentLocale());
      setError(addOpencodeCacheHint(message));
      return undefined;
    } finally {
      setCreatingSession(false);
      setBusy(false);
    }
  }

  const openNewSessionWithDirectory = async () => {
    if (isTauriRuntime()) {
      const scratch = await workspaceStore.createScratchWorkspace();
      if (!scratch?.id) return;
      const ready = await workspaceStore.ensureLocalWorkspaceActive(scratch.id);
      if (!ready) return;
      await createSessionAndOpen();
      return;
    }

    await createSessionAndOpen();
  };

  const openDirectorySessionFromPicker = async () => {
    return await createSessionFromDirectorySelection({
      activeWorkspaceId: workspaceStore.activeWorkspaceId(),
      getActiveWorkspaceId: () => workspaceStore.activeWorkspaceId(),
      pickDirectory: () => workspaceStore.pickWorkspaceFolder(),
      ensureWorkspaceForFolder: workspaceStore.ensureWorkspaceForFolder,
      activateWorkspace: (workspaceId) => workspaceStore.activateWorkspace(workspaceId, { promoteToFront: true }),
      createSession: () => createSessionAndOpen(),
    });
  };

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

      const sessionMap = readSessionByWorkspace();
      const nextSessionMap = { ...sessionMap, [targetWorkspace.id]: sessionID };
      if (sourceWorkspaceId) {
        delete nextSessionMap[sourceWorkspaceId];
      }
      writeSessionByWorkspace(nextSessionMap);

      // Optimistically move the session in the sidebar so the user sees
      // immediate feedback. Uses the snapshot captured before activation.
      setSidebarSessionsByWorkspaceId((prev) => {
        const sourceList = (prev[sourceWorkspaceId] ?? []).filter((s) => s.id !== sessionID);
        const movedItem: SidebarSessionItem = {
          id: sessionID,
          title: sessionSnapshot?.title ?? "",
          slug: sessionSnapshot?.slug,
          parentID: sessionSnapshot?.parentID ?? null,
          time: sessionSnapshot?.time,
          directory: targetWorkspace.path,
        };
        return {
          ...prev,
          [sourceWorkspaceId]: sourceList,
          [targetWorkspace.id]: [movedItem, ...(prev[targetWorkspace.id] ?? [])],
        };
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
      setSidebarSessionsByWorkspaceId((prev) => {
        const existing = prev[targetWorkspace.id] ?? [];
        if (existing.some((s) => s.id === sessionID)) return prev;
        const item: SidebarSessionItem = {
          id: sessionID,
          title: sessionSnapshot?.title ?? "",
          slug: sessionSnapshot?.slug,
          parentID: sessionSnapshot?.parentID ?? null,
          time: sessionSnapshot?.time,
          directory: targetWorkspace.path,
        };
        return { ...prev, [targetWorkspace.id]: [item, ...existing] };
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
      });
    })();
  }


  onMount(async () => {
    const startupGuard = createStartupGuard({
      timeoutMs: 15_000,
      onTimeout: () => {
        console.warn("[boot] app startup timed out after 15s — forcing boot complete");
        setBooting(false);
      },
    });
    onCleanup(() => startupGuard.dispose());

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

        const storedEngineSource = window.localStorage.getItem(
          "veslo.engineSource"
        );
        const storedEngineCustomBinPath = window.localStorage.getItem(
          "veslo.engineCustomBinPath"
        );
        if (storedEngineCustomBinPath) {
          setEngineCustomBinPath(storedEngineCustomBinPath);
        }
        if (
          storedEngineSource === "path" ||
          storedEngineSource === "sidecar" ||
          storedEngineSource === "custom"
        ) {
          if (storedEngineSource === "custom" && !(storedEngineCustomBinPath ?? "").trim()) {
            setEngineSource(isTauriRuntime() ? "sidecar" : "path");
          } else {
            setEngineSource(storedEngineSource);
          }
        }

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

        const storedVariant = window.localStorage.getItem(VARIANT_PREF_KEY);
        if (storedVariant && storedVariant.trim()) {
          const normalized = normalizeModelVariant(storedVariant);
          if (normalized) {
            setModelVariant(normalized);
          }
        }

        const storedUpdateAutoCheck = window.localStorage.getItem(
          "veslo.updateAutoCheck"
        );
        if (storedUpdateAutoCheck === "0" || storedUpdateAutoCheck === "1") {
          setUpdateAutoCheck(storedUpdateAutoCheck === "1");
        }

        const storedUpdateAutoDownload = window.localStorage.getItem(
          "veslo.updateAutoDownload"
        );
        if (storedUpdateAutoDownload === "0" || storedUpdateAutoDownload === "1") {
          const enabled = storedUpdateAutoDownload === "1";
          setUpdateAutoDownload(enabled);
          if (enabled) {
            setUpdateAutoCheck(true);
          }
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
        const consumeUrls = (urls: string[] | null | undefined) => {
          if (!Array.isArray(urls)) {
            return;
          }
          for (const url of urls) {
            if (queueAuthCompleteDeepLink(url) || queueRemoteConnectDeepLink(url) || queueSharedBundleDeepLink(url)) {
              break;
            }
          }
        };

        consumeUrls(await getCurrent());
        const unlisten = await onOpenUrl((urls) => {
          consumeUrls(urls);
        });
        onCleanup(() => {
          unlisten();
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
        await Promise.race([
          hydrateDenAuthFromDesktopSnapshot().catch(() => {}),
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, 1500);
          }),
        ]);
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
    if (!isTauriRuntime()) return;
    const projectDir = workspaceProjectDir().trim();
    if (!projectDir) return;
    void refreshMcpServers();
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
    const activeClient = client();
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
        setLastKnownConfigSnapshot(getConfigSnapshot(configFileContent));
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
    if (!workspaceDefaultModelReady()) return;
    if (!isTauriRuntime()) return;
    if (!defaultModelExplicit()) return;

    const workspace = workspaceStore.activeWorkspaceDisplay();
    if (workspace.workspaceType !== "local") return;

    const root = workspaceStore.activeWorkspacePath().trim();
    if (!root) return;
    const nextModel = defaultModel();
    const vesloClient = vesloServerClient();
    const vesloWorkspaceId = vesloServerWorkspaceId();
    const vesloCapabilities = resolvedVesloCapabilities();
    const canUseVesloServer =
      vesloServerStatus() === "connected" &&
      vesloClient &&
      vesloWorkspaceId &&
      vesloCapabilities?.config?.write;
    let cancelled = false;

    const writeConfig = async () => {
      try {
        if (canUseVesloServer) {
          const config = await vesloClient.getConfig(vesloWorkspaceId);
          const currentModel = typeof config.opencode?.model === "string" ? parseModelRef(config.opencode.model) : null;
          if (currentModel && modelEquals(currentModel, nextModel)) return;

          await vesloClient.patchConfig(vesloWorkspaceId, {
            opencode: { model: formatModelRef(nextModel) },
          });
          markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
          return;
        }

        const configFile = await readOpencodeConfig("project", root);
        const existingModel = parseDefaultModelFromConfig(configFile.content);
        if (existingModel && modelEquals(existingModel, nextModel)) return;

        const content = formatConfigWithDefaultModel(configFile.content, nextModel);
        const result = await writeOpencodeConfig("project", root, content);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
        }
        setLastKnownConfigSnapshot(getConfigSnapshot(content));
        markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
      }
    };

    void writeConfig();

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
      window.localStorage.setItem("veslo.engineSource", engineSource());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const value = engineCustomBinPath().trim();
      if (value) {
        window.localStorage.setItem("veslo.engineCustomBinPath", value);
      } else {
        window.localStorage.removeItem("veslo.engineCustomBinPath");
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
      setWindowDecorations(!hide).catch(e => reportError(e, "titlebar.setDecorations"));
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
      if (!shouldAutoCheckForUpdates()) return;
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

    downloadUpdate().catch(e => reportError(e, "updates.download"));
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
    if (!client() || !headerConnectedVersion()) return t("status.disconnected", currentLocale());
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

  const workspaceSwitchWorkspace = createMemo(() => {
    const switchingId = workspaceStore.connectingWorkspaceId();
    if (switchingId) {
      return workspaceStore.workspaces().find((ws) => ws.id === switchingId) ?? activeWorkspaceDisplay();
    }
    return activeWorkspaceDisplay();
  });

  // Avoid flashing the full-screen switch overlay for fast workspace switches.
  // Only show it if a switch is still in progress after a short delay and keep
  // it visible briefly once shown to avoid blinky transitions.
  const WORKSPACE_SWITCH_OVERLAY_DELAY_MS = 250;
  const WORKSPACE_SWITCH_OVERLAY_MIN_VISIBLE_MS = 350;
  const [workspaceSwitchDelayElapsed, setWorkspaceSwitchDelayElapsed] = createSignal(false);
  const [workspaceSwitchVisibleSinceMs, setWorkspaceSwitchVisibleSinceMs] = createSignal<number | null>(null);
  const [workspaceSwitchHoldOpen, setWorkspaceSwitchHoldOpen] = createSignal(false);

  // Session loading overlay — shown immediately on session click, hidden after messages load.
  const [pendingSessionLoad, setPendingSessionLoad] = createSignal<{
    sessionTitle: string;
    workspaceName: string;
  } | null>(null);

  createEffect(() => {
    if (typeof window === "undefined") return;
    const switchingId = workspaceStore.connectingWorkspaceId();
    if (!switchingId) {
      setWorkspaceSwitchDelayElapsed(false);
      return;
    }

    setWorkspaceSwitchDelayElapsed(false);
    const timer = window.setTimeout(() => setWorkspaceSwitchDelayElapsed(true), WORKSPACE_SWITCH_OVERLAY_DELAY_MS);
    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const connecting = Boolean(workspaceStore.connectingWorkspaceId());
    const shouldShowForSwitch = connecting && workspaceSwitchDelayElapsed();

    // Read visibleSinceMs without tracking — otherwise setting it to null
    // re-triggers this effect, which cancels the hold-open timer via onCleanup
    // before it can fire, leaving holdOpen stuck at true forever.
    const visibleSinceMs = untrack(workspaceSwitchVisibleSinceMs);

    if (shouldShowForSwitch) {
      setWorkspaceSwitchHoldOpen(false);
      if (visibleSinceMs === null) {
        setWorkspaceSwitchVisibleSinceMs(Date.now());
      }
      return;
    }

    if (visibleSinceMs === null) return;
    setWorkspaceSwitchVisibleSinceMs(null);

    const holdMs = computeWorkspaceSwitchOverlayHoldMs({
      visibleSinceMs,
      nowMs: Date.now(),
      minVisibleMs: WORKSPACE_SWITCH_OVERLAY_MIN_VISIBLE_MS,
    });
    if (holdMs <= 0) {
      setWorkspaceSwitchHoldOpen(false);
      return;
    }

    setWorkspaceSwitchHoldOpen(true);
    const timer = window.setTimeout(() => {
      setWorkspaceSwitchHoldOpen(false);
    }, holdMs);
    onCleanup(() => window.clearTimeout(timer));
  });

  const workspaceSwitchOpen = createMemo(() => {
    if (booting()) return true;
    if (workspaceStore.connectingWorkspaceId()) return workspaceSwitchDelayElapsed();
    if (workspaceSwitchHoldOpen()) return true;
    if (!busy() || !busyLabel()) return false;
    const label = busyLabel();
    return (
      label === "status.starting_engine" ||
      label === "status.restarting_engine"
    );
  });

  const workspaceSwitchStatusKey = createMemo(() => {
    const label = busyLabel();
    if (label === "status.connecting") return "workspace.switching_status_connecting";
    if (label === "status.starting_engine" || label === "status.restarting_engine") {
      return "workspace.switching_status_preparing";
    }
    if (label === "status.loading_session") return "workspace.switching_status_loading";
    if (workspaceStore.connectingWorkspaceId()) return "workspace.switching_status_loading";
    if (booting()) return "workspace.switching_status_preparing";
    return "workspace.switching_status_preparing";
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
    onSignInWithBrowser: async () => {
      setError(null);
      let url = `${getDenApiBase()}/?desktopOnboarding=1`;
      const startResult = await startDesktopBrowserAuth("signin");
      if (startResult.ok) {
        url = startResult.authorizeUrl;
        startDesktopAuthStatusPolling(startResult.sessionId);
      } else {
        console.warn("[den-auth] /start failed, falling back to legacy onboarding URL:", startResult.error);
      }
      if (isTauriRuntime()) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },
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
      providers: providers(),
      providerConnectedIds: providerConnectedIds(),
      providerAuthBusy: providerAuthBusy(),
      providerAuthModalOpen: providerAuthModalOpen(),
      providerAuthError: providerAuthError(),
      providerAuthMethods: providerAuthMethods(),
      openProviderAuthModal,
      disconnectProvider,
      connectLmStudioProvider,
      closeProviderAuthModal,
      startProviderAuth,
      completeProviderAuthOAuth,
      submitProviderApiKey,
      testProviderApiKey,
      view: currentView(),
      setView,
      startupPreference: startupPreference(),
      baseUrl: baseUrl(),
      clientConnected: Boolean(client()),
      authenticatedUser: authenticatedUser(),
      busy: busy(),
      busyHint: busyHint(),
      busyLabel: busyLabel(),
      newTaskDisabled: newTaskDisabled(),
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
      activateWorkspace: workspaceStore.activateWorkspace,
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
        void openDirectorySessionFromPicker();
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
      openRenameWorkspace,
      editWorkspaceConnection: openWorkspaceConnectionSettings,
      forgetWorkspace: workspaceStore.forgetWorkspace,
      stopSandbox: workspaceStore.stopSandbox,
      scheduledJobs: scheduledJobs(),
      scheduledJobsSource: scheduledJobsSource(),
      scheduledJobsSourceReady: scheduledJobsSourceReady(),
      schedulerPluginInstalled: schedulerPluginInstalled(),
      scheduledJobsStatus: scheduledJobsStatus(),
      scheduledJobsBusy: scheduledJobsBusy(),
      scheduledJobsUpdatedAt: scheduledJobsUpdatedAt(),
      refreshScheduledJobs: (options?: { force?: boolean }) =>
        refreshScheduledJobs(options).catch(e => reportError(e, "scheduled.refresh")),
      deleteScheduledJob,
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
      refreshHubSkills: (options?: { force?: boolean }) => refreshHubSkills(options).catch(e => reportError(e, "skills.refreshHub")),
      refreshPlugins: (scopeOverride?: PluginScope) =>
        refreshPlugins(scopeOverride).catch(e => reportError(e, "plugins.refresh")),
      skills: skills(),
      skillsStatus: skillsStatus(),
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
      suggestedPlugins: SUGGESTED_PLUGINS,
      addPlugin,
      removePlugin,
      createSessionAndOpen,
      setPrompt,
      selectSession: selectSession,
      defaultModelLabel: formatModelLabel(defaultModel(), providers()),
      defaultModelRef: formatModelRef(defaultModel()),
      openDefaultModelPicker,
      showThinking: showThinking(),
      toggleShowThinking: () => setShowThinking((v) => !v),
      autoCompactContext: autoCompactContext(),
      toggleAutoCompactContext: () => setAutoCompactContext(true),
      hideTitlebar: hideTitlebar(),
      toggleHideTitlebar: () => setHideTitlebar((v) => !v),
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
      installUpdateAndRestart,
      anyActiveRuns: anyActiveRuns(),
      engineSource: engineSource(),
      setEngineSource,
      engineCustomBinPath: engineCustomBinPath(),
      setEngineCustomBinPath,
      engineRuntime: engineRuntime(),
      setEngineRuntime,
      isWindows: isWindowsPlatform(),
      toggleDeveloperMode: () => setDeveloperMode((v) => !v),
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
      sandboxCreateProgress: workspaceStore.sandboxCreateProgress(),
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
      quickConnect: MCP_QUICK_CONNECT,
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
    const activeClient = client();
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
    setView,
    tab: tab(),
    setTab,
    setSettingsTab,
    activeWorkspaceDisplay: activeWorkspaceDisplay(),
    activeWorkspaceRoot: preferredSessionWorkspaceRoot(
      resolveSessionDirectory(selectedSession() ?? { id: "", directory: "" }),
      workspaceStore.activeWorkspaceRoot().trim(),
    ),
    workspaces: workspaceStore.workspaces(),
    activeWorkspaceId: workspaceStore.activeWorkspaceId(),
    connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
    workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
    activateWorkspace: workspaceStore.activateWorkspace,
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
      void openDirectorySessionFromPicker();
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
    clientConnected: Boolean(client()),
    authenticatedUser: authenticatedUser(),
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
    anyActiveRuns: anyActiveRuns(),
    installUpdateAndRestart,
    activePlugins: sidebarPluginList(),
    activePluginStatus: sidebarPluginStatus(),
    mcpServers: mcpServers(),
    mcpStatuses: mcpStatuses(),
    mcpStatus: mcpStatus(),
    skills: skills(),
    skillsStatus: skillsStatus(),
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
    abortSession: abortSession,
    sessionRevertMessageId: selectedSession()?.revert?.messageID ?? null,
    undoLastUserMessage: undoLastUserMessage,
    redoLastUserMessage: redoLastUserMessage,
    compactSession: compactCurrentSession,
    lastPromptSent: lastPromptSent(),
    retryLastPrompt: retryLastPrompt,
    newTaskDisabled: newTaskDisabled(),
    workspaceSessionGroups: sidebarWorkspaceGroups(),
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
    pendingSessionLoad: pendingSessionLoad(),
    setPendingSessionLoad,
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
    expandedSidebarSections: expandedSidebarSections(),
    setExpandedSidebarSections: setExpandedSidebarSections,
    artifacts: activeArtifacts(),
    artifactFamilies: activeArtifactFamilies(),
    workingFiles: activeWorkingFiles(),
    authorizedDirs: activeAuthorizedDirs(),
    busy: busy(),
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
    startProviderAuth: startProviderAuth,
    completeProviderAuthOAuth: completeProviderAuthOAuth,
    submitProviderApiKey: submitProviderApiKey,
    testProviderApiKey: testProviderApiKey,
    connectLmStudioProvider: connectLmStudioProvider,
    openProviderAuthModal: openProviderAuthModal,
    closeProviderAuthModal: closeProviderAuthModal,
    providerAuthModalOpen: providerAuthModalOpen(),
    providerAuthBusy: providerAuthBusy(),
    providerAuthError: providerAuthError(),
    providerAuthMethods: providerAuthMethods(),
    providers: providers(),
    providerConnectedIds: providerConnectedIds(),
    listAgents: listAgents,
    listCommands: listCommands,
    selectedSessionAgent: selectedSessionAgent(),
    setSessionAgent: setSessionAgent,
    saveSession: saveSessionExport,
    sessionStatusById: activeSessionStatusById(),
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

  const dashboardTabs = new Set<DashboardTab>([
    "scheduled",
    "soul",
    "skills",
    "plugins",
    "mcp",
    "config",
    "settings",
  ]);

  const resolveDashboardTab = (value?: string | null) => {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (dashboardTabs.has(normalized as DashboardTab)) {
      return normalized as DashboardTab;
    }
    return "scheduled";
  };

  const initialRoute = () => {
    if (typeof window === "undefined") return "/session";
    return "/session";
  };

  createEffect(() => {
    const rawPath = location.pathname.trim();
    const path = rawPath.toLowerCase();

    if ((onboardingStep() === "language" || onboardingStep() === "auth") && !path.startsWith("/onboarding")) {
      navigate("/onboarding", { replace: true });
      return;
    }

    if (path === "" || path === "/") {
      navigate(initialRoute(), { replace: true });
      return;
    }

    if (path.startsWith("/dashboard")) {
      const [, , tabSegment] = path.split("/");
      const resolvedTab = resolveDashboardTab(tabSegment);

      if (resolvedTab !== tab()) {
        setTabState(resolvedTab);
      }
      if (!tabSegment || tabSegment !== resolvedTab) {
        goToDashboard(resolvedTab, { replace: true });
      }
      return;
    }

    if (path.startsWith("/session")) {
      const [, , sessionSegment] = rawPath.split("/");
      const id = (sessionSegment ?? "").trim();

      if (!id) {
        if (selectedSessionId()) {
          setSelectedSessionId(null);
          setMessages([]);
          setTodos([]);
        }
        return;
      }

      // If the URL points at a session that no longer exists (e.g. after deletion),
      // route back to /session so the app can fall back safely.
      if (sessionsLoaded() && !sessions().some((session) => session.id === id)) {
        if (selectedSessionId() === id) {
          setSelectedSessionId(null);
        }
        navigate("/session", { replace: true });
        return;
      }

      if (selectedSessionId() !== id) {
        void selectSession(id);
      }
      return;
    }

    if (path.startsWith("/proto-v1-ux")) {
      if (isTauriRuntime()) {
        navigate("/dashboard/scheduled", { replace: true });
      }
      return;
    }

    if (path.startsWith("/proto")) {
      if (isTauriRuntime()) {
        navigate("/dashboard/scheduled", { replace: true });
        return;
      }

      const [, , protoSegment] = rawPath.split("/");
      if (!protoSegment) {
        navigate("/proto/workspaces", { replace: true });
      }
      return;
    }

    if (path.startsWith("/onboarding")) {
      if (onboardingStep() === "language" || onboardingStep() === "auth") {
        return;
      }
      navigate("/session", { replace: true });
      return;
    }

    const fallback = activeSessionId();
    if (fallback) {
      goToSession(fallback, { replace: true });
      return;
    }
    navigate("/session", { replace: true });
  });

  return (
    <>
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
          <SessionView {...sessionProps()} />
        </Match>
        <Match when={true}>
          <DashboardView {...dashboardProps()} />
        </Match>
      </Switch>

      <WorkspaceSwitchOverlay
        open={workspaceSwitchOpen()}
        workspace={workspaceSwitchWorkspace()}
        statusKey={workspaceSwitchStatusKey()}
      />

      <ModelPickerModal
        open={modelPickerOpen()}
        options={modelOptions()}
        filteredOptions={filteredModelOptions()}
        query={modelPickerQuery()}
        setQuery={setModelPickerQuery}
        target={modelPickerTarget()}
        current={modelPickerCurrent()}
        onSelect={applyModelSelection}
        onOpenSettings={openSettingsFromModelPicker}
        onClose={() => setModelPickerOpen(false)}
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
        client={client()}
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
          workspaceStore.clearSandboxCreateProgress?.();
        }}
        onPickFolder={workspaceStore.pickWorkspaceFolder}
        onConfirm={(preset, folder) =>
          workspaceStore.createWorkspaceFlow(preset, folder)
        }
        onConfirmWorker={
          isTauriRuntime()
            ? async (preset, folder) => {
                const ok = await workspaceStore.createSandboxFlow(preset, folder);
                if (!ok) return;
              }
            : undefined
        }
        workerDisabled={(() => {
          if (!isTauriRuntime()) return true;
          if (workspaceStore.sandboxDoctorBusy?.()) return true;
          const doctor = workspaceStore.sandboxDoctorResult?.();
          if (!doctor) return false;
          return !doctor?.ready;
        })()}
        workerDisabledReason={(() => {
          if (!isTauriRuntime()) return t("app.error.tauri_required", currentLocale());
          if (workspaceStore.sandboxDoctorBusy?.()) {
            return t("dashboard.sandbox_checking_docker", currentLocale());
          }
          const doctor = workspaceStore.sandboxDoctorResult?.();
          if (!doctor || doctor.ready) return null;
          const message = doctor?.error?.trim();
          return message || t("dashboard.sandbox_get_ready_desc", currentLocale());
        })()}
        workerCtaLabel={t("dashboard.sandbox_get_ready_action", currentLocale())}
        workerCtaDescription={t("dashboard.sandbox_get_ready_desc", currentLocale())}
        onWorkerCta={async () => {
          const url = "https://www.docker.com/products/docker-desktop/";
          if (isTauriRuntime()) {
            const { openUrl } = await import("@tauri-apps/plugin-opener");
            await openUrl(url);
          } else {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        }}
        workerRetryLabel={t("common.retry", currentLocale())}
        workerDebugLines={(() => {
          const doctor = workspaceStore.sandboxDoctorResult?.();
          const lines: string[] = [];
          if (!doctor?.debug) return lines;
          const selected = doctor.debug.selectedBin?.trim();
          if (selected) lines.push(`selected: ${selected}`);
          if (doctor.debug.candidates?.length) {
            lines.push(`candidates: ${doctor.debug.candidates.join(", ")}`);
          }
          if (doctor.debug.versionCommand) {
            const cmd = doctor.debug.versionCommand;
            lines.push(`docker --version exit=${cmd.status}`);
            if (cmd.stderr?.trim()) lines.push(`docker --version stderr: ${cmd.stderr.trim()}`);
          }
          if (doctor.debug.infoCommand) {
            const cmd = doctor.debug.infoCommand;
            lines.push(`docker info exit=${cmd.status}`);
            if (cmd.stderr?.trim()) lines.push(`docker info stderr: ${cmd.stderr.trim()}`);
          }
          return lines;
        })()}
        onWorkerRetry={() => {
          void workspaceStore.refreshSandboxDoctor?.();
        }}
        workerSubmitting={workspaceStore.sandboxPreflightBusy?.() ?? false}
        submitting={(() => {
          const phase = workspaceStore.sandboxCreatePhase?.() ?? "idle";
          if (phase === "provisioning" || phase === "finalizing") return true;
          return busy() && busyLabel() === "status.creating_workspace";
        })()}
        submittingProgress={workspaceStore.sandboxCreateProgress?.() ?? null}
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
                setEditRemoteWorkspaceError(error() || "Connection failed. Check the URL and token.");
                setError(null);
              }
            } catch (e) {
              const message = e instanceof Error ? e.message : "Connection failed";
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
    </>
  );
}
