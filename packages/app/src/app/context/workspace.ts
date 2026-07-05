import { batch, createEffect, createMemo, createSignal } from "solid-js";
import type {
  Client,
  StartupPreference,
  OnboardingStep,
  WorkspaceDisplay,
  WorkspaceVesloConfig,
  WorkspacePreset,
  EngineRuntime,
} from "../types";
import {
  addOpencodeCacheHint,
  clearStartupPreference,
  isTauriRuntime,
  normalizeDirectoryQueryPath,
  readStartupPreference,
  safeStringify,
  writeStartupPreference,
} from "../utils";
import { LANGUAGE_PREF_KEY, ONBOARDING_COMPLETE_STORAGE_KEY } from "../constants";
import { reportError } from "../lib/error-reporter";
import { readDenAuth, clearDenAuth, validateDenAuth } from "../lib/den-auth";
import {
  normalizeVesloServerUrl,
  VesloServerError,
  type VesloServerClient,
  type VesloServerSettings,
} from "../lib/veslo-server";
import {
  engineInfo,
  engineStart,
  engineStop,
  orchestratorInstanceDispose,
  orchestratorWorkspaceActivate,
  workspaceBootstrap,
  workspaceForget,
  workspaceSetActive,
  workspaceVesloRead,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { waitForHealthy, createClient, unwrap, type OpencodeAuth } from "../lib/opencode";
import type { WorkspaceRouting } from "./workspace-routing";
import type { OpencodeConnectStatus, ProviderListItem } from "../types";
import { t, currentLocale, isLanguage } from "../../i18n";
import { withTimeoutOrThrow } from "../utils/promise-timeout";
import { createLocalRuntimeLifecycle } from "../utils/local-runtime-lifecycle";
import { CLOUD_ONLY_MODE } from "../lib/cloud-policy";
import { createWorkspaceActivateGuard } from "./workspace-activate-guard";
import { createOnboardingLanguageGate } from "./onboarding-language-gate";
import { createConfigStore } from "../stores/config-store";
import { createEngineStore } from "../stores/engine-store";
import { createRemoteStore } from "../stores/remote-store";
import { shouldAutoBootstrapRemoteServer } from "../utils/startup-server-bootstrap";
import { currentLocale as __vesloIndirectLocale, t as __vesloIndirectT } from "../../i18n";
import type {
  WorkspaceActivationOptions,
} from "./workspace-types";
import {
  createWorkspaceDebugEvents,
  recordWorkspaceBusyTrace,
  workspaceDebugStack,
  wsLog,
} from "./workspace-debug";
import { createWorkspaceBusyState } from "./workspace-busy-state";
import { createWorkspaceConnectionState } from "./workspace-connection-state";
import { createWorkspaceConnectionController } from "./workspace-connection-controller";
import { createWorkspaceSkillMaterializationGate } from "./workspace-skill-materialization";
import { createWorkspaceServerRegistry } from "./workspace-server-registry";
import { createWorkspaceRuntimeController } from "./workspace-runtime-controller";
import { createWorkspaceLocalWorkspaces } from "./workspace-local-workspaces";
import {
  createWorkspaceActivationController,
  isPassiveLocalBrowseActivationOrigin,
  type WorkspaceActivationRunContext,
  type WorkspaceSwitchOverlayTarget,
} from "./workspace-activation-controller";
import { createWorkspaceRemoteActivation } from "./workspace-activation-remote";
import { createWorkspaceLocalActivation } from "./workspace-activation-local";
import {
  createInitialWorkspaceLifecycleState,
  reduceWorkspaceLifecycleState,
  type WorkspaceLifecycleEvent,
} from "./workspace-lifecycle-state";

export type { MigrationRepairResult } from "../stores/config-store";
export type {
  ConnectToServer,
  WorkspaceActivationOptions,
  WorkspaceConnectContext,
  WorkspaceConnectOptions,
} from "./workspace-types";
export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

type DisplayedSessionResetReason =
  | "remote_to_local_workspace_changed"
  | "connect_workspace_scope_changed"
  | "local_browse_workspace_changed"
  | "open_empty_session";

type DisplayedSessionResetScope = {
  workspaceId?: string | null;
  workspaceType?: WorkspaceInfo["workspaceType"] | null;
  previousDirectory?: string | null;
  nextDirectory?: string | null;
  activeWorkspaceRoot?: string | null;
  clearPendingPermissions?: boolean;
};

const _wsLog = wsLog;

function isSkillRegistryMaterializationError(error: unknown): boolean {
  if (error instanceof VesloServerError) {
    if (error.code.trim().startsWith("skill_registry_")) return true;
    return error.message.includes("Skill registry") || error.message.includes("skill registry");
  }
  const message = error instanceof Error ? error.message : safeStringify(error);
  return message.includes("Skill registry") || message.includes("skill registry");
}

export function createWorkspaceStore(options: {
  startupPreference: () => StartupPreference | null;
  setStartupPreference: (value: StartupPreference | null) => void;
  onboardingStep: () => OnboardingStep;
  setOnboardingStep: (step: OnboardingStep) => void;
  rememberStartupChoice: () => boolean;
  setRememberStartupChoice: (value: boolean) => void;
  baseUrl: () => string;
  setBaseUrl: (value: string) => void;
  clientDirectory: () => string;
  setClientDirectory: (value: string) => void;
  client: () => Client | null;
  setClient: (value: Client | null) => void;
  // VSLO-171 F3Ú4 — workspace routing service (single-active adapter today).
  // Use `options.routing.active()` or `options.routing.client(workspaceId)`
  // instead of `options.client()`.
  routing: WorkspaceRouting;
  setConnectedVersion: (value: string | null) => void;
  setSseConnected: (value: boolean) => void;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  loadSessions: (scopeRoot?: string) => Promise<void>;
  refreshPendingPermissions: () => Promise<void>;
  selectedSessionId: () => string | null;
  selectSession: (id: string) => Promise<void>;
  setSelectedSessionId: (value: string | null) => void;
  setMessages: (value: any[]) => void;
  setTodos: (value: any[]) => void;
  setPendingPermissions: (value: any[]) => void;
  setSessionStatusById: (value: Record<string, string>) => void;
  defaultModel: () => any;
  modelVariant: () => string | null;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  refreshPlugins: () => Promise<void>;
  engineSource: () => "path" | "sidecar" | "custom";
  engineCustomBinPath?: () => string;
  // VSLO-171 F3Ú9: pool tuning forwarded into engine-store / spawn args.
  maxEngines?: () => number | null;
  idleSuspendMs?: () => number | null;
  setEngineSource: (value: "path" | "sidecar" | "custom") => void;
  setView: (value: any) => void;
  setTab: (value: any) => void;
  isWindowsPlatform: () => boolean;
  vesloServerSettings: () => VesloServerSettings;
  updateVesloServerSettings: (next: VesloServerSettings) => void;
  preferServerByDefault?: () => boolean;
  vesloServerClient?: () => VesloServerClient | null;
  vesloServerHostInfo?: () => {
    baseUrl?: string | null;
    engineUrl?: string | null;
    clientToken?: string | null;
  } | null;
  ensureLocalVesloServerRunning?: () => Promise<boolean>;
  setOpencodeConnectStatus?: (status: OpencodeConnectStatus | null) => void;
  onEngineStable?: () => void;
  engineRuntime?: () => EngineRuntime;
  developerMode: () => boolean;
  activeSendTraceId?: () => string | null;
  setEngineReady?: (value: boolean) => void;
  isWorkspaceRuntimeReady?: (workspaceId: string) => boolean;
  populateSidebarFromDb?: (workspaceId: string, directory: string) => Promise<void>;
  hydrateLatestSessionFromDb?: (workspaceId: string, directory: string) => Promise<void>;
  requestWorkspaceFolderAccess?: (input: {
    workspaceId: string;
    workspacePath: string;
    requestedPath: string;
    reason: string;
  }) => void;
}) {
  const cloudOnlyMessage = (code: string, detail: string) => `${code}: ${detail}`;
  const blockLocalAction = (code: string, detail: string) => {
    const message = cloudOnlyMessage(code, detail);
    options.setError(message);
    wsDebug("cloud-only:block", { code, detail });
    return false;
  };

  const wsDebugEnabled = () => options.developerMode();
  const { workspaceDebugEvents, clearWorkspaceDebugEvents, wsDebug } = createWorkspaceDebugEvents(wsDebugEnabled);

  const wsActivateGuard = createWorkspaceActivateGuard();

  // VSLO-171 — flip to true once workspaceBootstrap() has populated workspaces()
  // (or skipped on non-Tauri). Callers that need the full workspace set (engine
  // start, veslo-server hot-register reconciliation) should wait on this.
  const [workspacesHydrated, setWorkspacesHydrated] = createSignal(false);

  // Late-bound reference for the remote store — populated after createRemoteStore().
  const remoteStoreRef: {
    resolveVesloHost: (...args: any[]) => Promise<any>;
    createRemoteWorkspaceFlow: (...args: any[]) => Promise<boolean>;
  } = {
    resolveVesloHost: () => { throw new Error("remoteStore not initialized"); },
    createRemoteWorkspaceFlow: () => { throw new Error("remoteStore not initialized"); },
  };

  const WORKSPACE_IO_TIMEOUT_MS = 8_000;
  const WORKSPACE_SET_ACTIVE_TIMEOUT_MS = 8_000;
  const START_HOST_TIMEOUT_MS = 45_000;
  const WORKSPACE_ACTIVATE_TIMEOUT_MS = 30_000;
  const BOOT_TRACE_SINK_STORAGE_KEY = "veslo:boot-trace-sink";
  // VSLO-86 -- orchestrator_workspace_activate waits for the daemon's
  // /workspaces/:id/activate path. That route eagerly spawns the per-workspace
  // OpenCode engine and its default health window is 60s on cold dev starts
  // (Bun + SQLite + sandbox init). Keep this timeout above that backend window;
  // otherwise the UI falls back to startHost while the original activation is
  // still alive, producing competing daemons and stale base URLs.
  const ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS = 75_000;
  const DB_MIGRATE_UNSUPPORTED_PATTERNS = [
    /unknown(?:\s+sub)?command\s+['"`]?db['"`]?/i,
    /unrecognized(?:\s+sub)?command\s+['"`]?db['"`]?/i,
    /no such command[:\s]+db/i,
    /found argument ['"`]db['"`] which wasn't expected/i,
  ] as const;

  const formatExecOutput = (result: { stdout: string; stderr: string }) => {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    return [stderr, stdout].filter(Boolean).join("\n\n");
  };

  const isDbMigrateUnsupported = (output: string) => {
    const normalized = output.trim();
    if (!normalized) return false;
    return DB_MIGRATE_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(normalized));
  };

  const messageFromUnknownError = (error: unknown): string =>
    error instanceof Error ? error.message : safeStringify(error);

  const makeRunId = () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };
  const [projectDir, setProjectDir] = createSignal("");
  const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string>("");
  const [privateWorkspaceRoot, setPrivateWorkspaceRoot] = createSignal("");

  const syncActiveWorkspaceId = (id?: string) => {
    setActiveWorkspaceId(id?.trim() ?? "");
  };

  const [authorizedDirs, setAuthorizedDirs] = createSignal<string[]>([]);

  // Cross-workspace busy tracker: which workspaces have a running session.
  // Survives workspace switch (sessionStatus is reset on switch) so we can
  // warn the user before sendPrompt kills another workspace's engine.
  const { workspaceBusy, markWorkspaceBusy, clearWorkspaceBusy, clearWorkspaceBusyAllExcept } =
    createWorkspaceBusyState(recordWorkspaceBusyTrace);

  // VSLO-171 F3Ú8: isAnyOtherWorkspaceBusy() byla smazána — multi mode
  // garantuje paralelní engine pool, single-active fallback ztratí task
  // tiše (žádný dialog). workspaceBusy mapa zůstává pro sidebar dot.

  const [workspaceConfig, setWorkspaceConfig] = createSignal<WorkspaceVesloConfig | null>(null);
  const [workspaceConfigLoaded, setWorkspaceConfigLoaded] = createSignal(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = createSignal(false);
  const [createRemoteWorkspaceOpen, setCreateRemoteWorkspaceOpen] = createSignal(false);
  const [connectingWorkspaceId, setConnectingWorkspaceId] = createSignal<string | null>(null);
  const [workspaceSwitchOverlaySuppressionToken, setWorkspaceSwitchOverlaySuppressionToken] =
    createSignal<string | null>(null);
  const [workspaceSwitchOverlayTarget, setWorkspaceSwitchOverlayTarget] =
    createSignal<WorkspaceSwitchOverlayTarget | null>(null);
  const workspaceSwitchOverlaySuppressed = createMemo(() =>
    Boolean(workspaceSwitchOverlaySuppressionToken()?.trim()),
  );
  const workspaceSwitchOverlayWorkspaceId = createMemo(() =>
    workspaceSwitchOverlayTarget()?.workspaceId ?? null,
  );
  const {
    workspaceConnectionStateById,
    setWorkspaceConnectionStateById,
    updateWorkspaceConnectionState,
    clearWorkspaceConnectionState,
  } = createWorkspaceConnectionState(workspaces);
  const [workspaceLifecycleState, setWorkspaceLifecycleState] =
    createSignal(createInitialWorkspaceLifecycleState());
  const dispatchWorkspaceLifecycle = (event: WorkspaceLifecycleEvent) => {
    setWorkspaceLifecycleState((state) => reduceWorkspaceLifecycleState(state, event));
  };

  const activeWorkspaceInfo = createMemo(() => workspaces().find((w) => w.id === activeWorkspaceId()) ?? null);
  const activeWorkspaceDisplay = createMemo<WorkspaceDisplay>(() => {
    const ws = activeWorkspaceInfo();
    if (!ws) {
      return {
        id: "",
        name: "Worker",
        path: "",
        preset: "starter",
        workspaceType: "local",
        remoteType: "opencode",
        baseUrl: null,
        directory: null,
        displayName: null,
        vesloHostUrl: null,
        vesloWorkspaceId: null,
        vesloWorkspaceName: null,
      };
    }
    const displayName =
      ws.displayName?.trim() ||
      ws.vesloWorkspaceName?.trim() ||
      ws.name ||
      ws.vesloHostUrl ||
      ws.baseUrl ||
      ws.path ||
      "Worker";
    return { ...ws, name: displayName };
  });
  const normalizeRemoteType = (value?: WorkspaceInfo["remoteType"] | null) =>
    value === "veslo" ? "veslo" : "opencode";
  const isVesloRemote = (workspace: WorkspaceInfo | null) =>
    Boolean(workspace && workspace.workspaceType === "remote" && normalizeRemoteType(workspace.remoteType) === "veslo");
  const activeWorkspacePath = createMemo(() => {
    const ws = activeWorkspaceInfo();
    if (!ws) return "";
    if (ws.workspaceType === "remote") return ws.directory?.trim() ?? "";
    return ws.path ?? "";
  });
  const activeWorkspaceRoot = createMemo(() => activeWorkspacePath().trim());

  const normalizeWorkspaceScopePath = (
    value?: string | null,
    workspaceType?: WorkspaceInfo["workspaceType"] | null,
  ) => {
    const normalized = normalizeDirectoryQueryPath(value ?? "");
    if (!normalized) return "";
    return workspaceType === "local" && options.isWindowsPlatform()
      ? normalized.toLowerCase()
      : normalized;
  };

  const workspaceScopeChanged = (
    previous?: string | null,
    next?: string | null,
    workspaceType?: WorkspaceInfo["workspaceType"] | null,
  ) => normalizeWorkspaceScopePath(previous, workspaceType) !== normalizeWorkspaceScopePath(next, workspaceType);

  let lastProjectDirActiveRootMismatchKey = "";
  createEffect(() => {
    const active = activeWorkspaceInfo();
    if (!active || active.workspaceType !== "local") return;
    const activeRoot = activeWorkspaceRoot().trim();
    const runtimeProjectDir = projectDir().trim();
    if (!activeRoot || !runtimeProjectDir) return;
    const activeRootScope = normalizeWorkspaceScopePath(activeRoot, "local");
    const projectDirScope = normalizeWorkspaceScopePath(runtimeProjectDir, "local");
    if (!activeRootScope || !projectDirScope || activeRootScope === projectDirScope) {
      lastProjectDirActiveRootMismatchKey = "";
      return;
    }
    const key = [
      active.id,
      activeRootScope,
      projectDirScope,
      engineStore.engine()?.projectDir?.trim() ?? "",
    ].join("\0");
    if (key === lastProjectDirActiveRootMismatchKey) return;
    lastProjectDirActiveRootMismatchKey = key;
    wsDebug("workspace:projectDir-activeRoot-mismatch", {
      activeWorkspaceId: active.id,
      activeWorkspaceRoot: activeRoot,
      activeWorkspaceRootScope: activeRootScope,
      projectDir: runtimeProjectDir,
      projectDirScope,
      engineProjectDir: engineStore.engine()?.projectDir?.trim() || null,
      engineRunning: Boolean(engineStore.engine()?.running),
    });
  });

  const clearDisplayedSessionState = (
    reason: DisplayedSessionResetReason,
    scope: DisplayedSessionResetScope = {},
  ) => {
    const workspaceId = scope.workspaceId ?? activeWorkspaceId().trim();
    const activeRoot = scope.activeWorkspaceRoot ?? activeWorkspaceRoot().trim();
    const activeSendTraceId = options.activeSendTraceId?.()?.trim() ?? "";
    wsDebug("ui-reset:displayed-session", {
      reason,
      workspaceId: workspaceId || null,
      activeSendTraceId: activeSendTraceId || null,
      workspaceType: scope.workspaceType ?? activeWorkspaceInfo()?.workspaceType ?? null,
      selectedSessionId: options.selectedSessionId(),
      previousDirectory: scope.previousDirectory ?? null,
      nextDirectory: scope.nextDirectory ?? null,
      previousDirectoryNormalized: normalizeWorkspaceScopePath(
        scope.previousDirectory,
        scope.workspaceType ?? activeWorkspaceInfo()?.workspaceType ?? null,
      ),
      nextDirectoryNormalized: normalizeWorkspaceScopePath(
        scope.nextDirectory,
        scope.workspaceType ?? activeWorkspaceInfo()?.workspaceType ?? null,
      ),
      activeWorkspaceRoot: activeRoot || null,
      activeWorkspaceRootNormalized: normalizeWorkspaceScopePath(
        activeRoot,
        scope.workspaceType ?? activeWorkspaceInfo()?.workspaceType ?? null,
      ),
      clearPendingPermissions: scope.clearPendingPermissions ?? false,
    });

    batch(() => {
      options.setSelectedSessionId(null);
      options.setMessages([]);
      options.setTodos([]);
      if (scope.clearPendingPermissions) {
        options.setPendingPermissions([]);
      }
      options.setSessionStatusById({});
    });
  };

  const resolveEngineRuntime = () => options.engineRuntime?.() ?? "veslo-orchestrator";

  const resolveWorkspacePaths = () => {
    const active = activeWorkspacePath().trim();
    const locals = workspaces()
      .filter((ws) => ws.workspaceType === "local")
      .map((ws) => ws.path)
      .filter((path): path is string => Boolean(path && path.trim()))
      .map((path) => path.trim());
    const resolved: string[] = [];
    if (active) resolved.push(active);
    for (const path of locals) {
      if (!resolved.includes(path)) resolved.push(path);
    }
    return resolved;
  };

  async function activateOrchestratorWorkspace(input: {
    workspacePath: string;
    workspaceId?: string | null;
    name?: string | null;
  }) {
    return await withTimeoutOrThrow(
      orchestratorWorkspaceActivate(input),
      {
        timeoutMs: ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS,
        label: "orchestrator workspace activation",
      },
    );
  }

  const serverRegistry = createWorkspaceServerRegistry({
    getWorkspaces: workspaces,
    vesloServerClient: options.vesloServerClient,
    vesloServerHostInfo: options.vesloServerHostInfo,
    wsDebug,
  });
  const activateVesloHostWorkspace = serverRegistry.activateVesloHostWorkspace;
  const addLocalWorkspaceOnServer = serverRegistry.addLocalWorkspaceOnServer;
  const reconcileVesloServerWorkspaces = serverRegistry.reconcileVesloServerWorkspaces;

  async function testWorkspaceConnection(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = workspaces().find((item) => item.id === id) ?? null;
    if (!workspace) return false;

    updateWorkspaceConnectionState(id, { status: "connecting", message: null });

    if (workspace.workspaceType !== "remote") {
      if (CLOUD_ONLY_MODE) {
        updateWorkspaceConnectionState(id, {
          status: "error",
          message: cloudOnlyMessage("cloud_only_local_workspace_filtered", "Local workers are disabled."),
        });
        return false;
      }
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      return true;
    }

    const remoteType = normalizeRemoteType(workspace.remoteType);

    if (remoteType === "veslo") {
      const hostUrl =
        workspace.vesloHostUrl?.trim() || workspace.baseUrl?.trim() || workspace.path?.trim() || "";
      if (!hostUrl) {
        updateWorkspaceConnectionState(id, {
          status: "error",
          message: __vesloIndirectT("ui.indirect.veslo_server_url_is_required_63g0jb", __vesloIndirectLocale()),
        });
        return false;
      }

      const token = workspace.vesloToken?.trim() || options.vesloServerSettings().token || undefined;
      try {
        const resolved = await remoteStoreRef.resolveVesloHost({
          hostUrl,
          token,
          workspaceId: workspace.vesloWorkspaceId ?? null,
        });
        if (resolved.kind !== "veslo") {
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: __vesloIndirectT("ui.indirect.veslo_server_unavailable_check_the_url_and_tok_pthxtb", __vesloIndirectLocale()),
          });
          return false;
        }
        updateWorkspaceConnectionState(id, { status: "connected", message: null });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : safeStringify(error);
        updateWorkspaceConnectionState(id, { status: "error", message });
        return false;
      }
    }

    const baseUrl = workspace.baseUrl?.trim() || "";
    if (!baseUrl) {
      updateWorkspaceConnectionState(id, {
        status: "error",
        message: __vesloIndirectT("ui.indirect.remote_base_url_is_required_1ig1w2", __vesloIndirectLocale()),
      });
      return false;
    }

    try {
      const client = createClient(baseUrl, workspace.directory?.trim() || undefined);
      await waitForHealthy(client, { timeoutMs: 8_000 });
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      updateWorkspaceConnectionState(id, { status: "error", message });
      return false;
    }
  }

  const skillMaterializationGate = createWorkspaceSkillMaterializationGate({
    workspaceBusy,
    ensureLocalVesloServerRunning: options.ensureLocalVesloServerRunning,
    vesloServerClient: options.vesloServerClient,
    refreshSkills: options.refreshSkills,
    setError: options.setError,
    updateWorkspaceConnectionState,
    wsDebug,
  });
  const syncWorkspaceSkillMaterializationBeforeRuntime =
    skillMaterializationGate.syncWorkspaceSkillMaterializationBeforeRuntime;

  const runWorkspaceActivation = async ({
    id,
    next,
    myVersion,
    isSuperseded,
    activateStart,
    activationOptions,
  }: WorkspaceActivationRunContext) => {
    const isRemote = next.workspaceType === "remote";
    const remoteType = isRemote ? normalizeRemoteType(next.remoteType) : "opencode";
    const baseUrl = isRemote ? next.baseUrl?.trim() ?? "" : "";
    dispatchWorkspaceLifecycle({
      type: "activation-started",
      workspaceId: id,
      version: myVersion,
      origin: activationOptions.origin ?? "unknown",
      workspaceType: next.workspaceType,
    });

    try {
      let ok = false;
      if (isRemote) {
        const remoteActivation = createWorkspaceRemoteActivation({
          setStartupPreference: options.setStartupPreference,
          vesloServerSettings: options.vesloServerSettings,
          soulAuthContext: () => {
            const denAuth = readDenAuth();
            return {
              denApiBase: denAuth?.denApiBase?.trim() || undefined,
              denToken: denAuth?.token?.trim() || undefined,
              denOrgId: denAuth?.orgId?.trim() || undefined,
              denUserId: denAuth?.user?.id?.trim() || undefined,
            };
          },
          updateVesloServerSettings: options.updateVesloServerSettings,
          resolveVesloHost: remoteStoreRef.resolveVesloHost,
          connectToServer,
          setWorkspaces,
          syncActiveWorkspaceId,
          setProjectDir,
          setWorkspaceConfig,
          setWorkspaceConfigLoaded,
          setAuthorizedDirs,
          updateWorkspaceConnectionState,
          setError: options.setError,
          isSuperseded,
          activationOptions,
          activateStart,
          workspaceSetActiveTimeoutMs: WORKSPACE_SET_ACTIVE_TIMEOUT_MS,
          withTimeoutOrThrow,
          t,
          currentLocale,
          indirectT: __vesloIndirectT,
          indirectLocale: __vesloIndirectLocale,
          safeStringify,
          addOpencodeCacheHint,
          wsDebug,
        });
        ok = await remoteActivation.activateRemoteWorkspace(id, next, remoteType, baseUrl);
      } else {
        const localActivation = createWorkspaceLocalActivation({
          routingActive: () => options.routing.active(),
          startupPreference: options.startupPreference,
          setStartupPreference: options.setStartupPreference,
          projectDir,
          activeWorkspaceRoot,
          setProjectDir,
          authorizedDirs,
          setAuthorizedDirs,
          setWorkspaces,
          syncActiveWorkspaceId,
          normalizeWorkspaceScopePath,
          workspaceScopeChanged,
          engine: engineStore.engine,
          resolveEngineRuntime,
          localRuntimeLifecycle,
          startHost: engineStore.startHost,
          syncWorkspaceSkillMaterializationBeforeRuntime,
          clearDisplayedSessionState,
          updateWorkspaceConnectionState,
          setWorkspaceConfig,
          setWorkspaceConfigLoaded,
          setEngineReady: options.setEngineReady,
          isWorkspaceRuntimeReady: options.isWorkspaceRuntimeReady,
          populateSidebarFromDb: options.populateSidebarFromDb,
          hydrateLatestSessionFromDb: options.hydrateLatestSessionFromDb,
          activateVesloHostWorkspace,
          setError: options.setError,
          setBusy: options.setBusy,
          setBusyLabel: options.setBusyLabel,
          setBusyStartedAt: options.setBusyStartedAt,
          refreshSkills: options.refreshSkills,
          refreshPlugins: options.refreshPlugins,
          reportError,
          isSuperseded,
          activationOptions,
          activateStart,
          workspaceIoTimeoutMs: WORKSPACE_IO_TIMEOUT_MS,
          workspaceSetActiveTimeoutMs: WORKSPACE_SET_ACTIVE_TIMEOUT_MS,
          startHostTimeoutMs: START_HOST_TIMEOUT_MS,
          withTimeoutOrThrow,
          indirectT: __vesloIndirectT,
          indirectLocale: __vesloIndirectLocale,
          safeStringify,
          addOpencodeCacheHint,
          wsDebug,
          wsLog: _wsLog,
        });
        ok = await localActivation.activateLocalWorkspace(id, next);
      }

      dispatchWorkspaceLifecycle(
        ok
          ? {
              type: "connected",
              workspaceId: id,
              version: myVersion,
              runtime: isRemote ? undefined : resolveEngineRuntime(),
              reason: activationOptions.origin ?? "activation",
            }
          : {
              type: "failed",
              workspaceId: id,
              version: myVersion,
              message: "Workspace activation failed",
            },
      );
      return ok;
    } catch (error) {
      dispatchWorkspaceLifecycle({
        type: "failed",
        workspaceId: id,
        version: myVersion,
        message: error instanceof Error ? error.message : safeStringify(error),
      });
      throw error;
    }
  };

  let browseWorkspaceVersion = 0;
  async function browseWorkspace(
    workspaceId: string | undefined,
    activationOptions: WorkspaceActivationOptions,
  ) {
    const id = workspaceId?.trim() ?? "";
    if (!id) return false;
    if (!isPassiveLocalBrowseActivationOrigin(activationOptions.origin)) return false;

    const next = workspaces().find((w) => w.id === id) ?? null;
    if (!next) return false;
    if (next.workspaceType !== "local") return false;
    if (CLOUD_ONLY_MODE) {
      updateWorkspaceConnectionState(id, {
        status: "error",
        message: cloudOnlyMessage("cloud_only_local_workspace_filtered", "Local workers are disabled."),
      });
      return blockLocalAction("cloud_only_local_workspace_filtered", "Local workers are disabled.");
    }

    const nextRoot = next.path?.trim() ?? "";
    if (!nextRoot) return false;

    const version = ++browseWorkspaceVersion;
    const isStaleBrowse = () => version !== browseWorkspaceVersion;
    const previousProjectDir = projectDir();
    const previousActiveWorkspaceRoot = activeWorkspaceRoot().trim();
    const previousWorkspacePath = previousActiveWorkspaceRoot || previousProjectDir;
    const workspaceChanged = workspaceScopeChanged(previousWorkspacePath, nextRoot, "local");
    const targetRuntimeReady = Boolean(options.isWorkspaceRuntimeReady?.(id));

    wsDebug("browse:local:start", {
      id,
      origin: activationOptions.origin,
      nextRoot,
      previousWorkspacePath: previousWorkspacePath || null,
      workspaceChanged,
      targetRuntimeReady,
    });

    options.setStartupPreference("local");
    batch(() => {
      syncActiveWorkspaceId(id);
      setProjectDir(nextRoot);
    });
    options.setEngineReady?.(targetRuntimeReady);

    if (isTauriRuntime()) {
      setWorkspaceConfigLoaded(false);
      try {
        const cfg = await withTimeoutOrThrow(
          workspaceVesloRead({ workspacePath: nextRoot }),
          { timeoutMs: WORKSPACE_IO_TIMEOUT_MS, label: "workspace_veslo_read" },
        );
        if (isStaleBrowse()) return true;
        setWorkspaceConfig(cfg);
        setWorkspaceConfigLoaded(true);
        const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
        setAuthorizedDirs(roots.length ? roots : [nextRoot]);
      } catch (e) {
        if (isStaleBrowse()) return true;
        wsDebug("browse:local:workspace-config-failed", {
          id,
          error: e instanceof Error ? e.message : safeStringify(e),
        });
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([nextRoot]);
      }

      try {
        const ws = await withTimeoutOrThrow(
          workspaceSetActive(id, { promoteToFront: activationOptions.promoteToFront ?? false }),
          { timeoutMs: WORKSPACE_SET_ACTIVE_TIMEOUT_MS, label: "workspace_set_active" },
        );
        if (isStaleBrowse()) return true;
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
      } catch (e) {
        wsDebug("browse:local:set-active-failed", {
          id,
          error: e instanceof Error ? e.message : safeStringify(e),
        });
      }
    } else if (!authorizedDirs().includes(nextRoot)) {
      const merged = authorizedDirs().length ? authorizedDirs().slice() : [];
      if (!merged.includes(nextRoot)) merged.push(nextRoot);
      setAuthorizedDirs(merged);
    }

    if (options.populateSidebarFromDb) {
      try {
        await options.populateSidebarFromDb(id, nextRoot);
      } catch (e) {
        wsDebug("browse:local:populate-sidebar-failed", {
          id,
          error: e instanceof Error ? e.message : safeStringify(e),
        });
      }
    }

    if (isStaleBrowse()) return true;
    updateWorkspaceConnectionState(id, { status: "connected", message: null });
    dispatchWorkspaceLifecycle({
      type: "browse-ready",
      workspaceId: id,
      root: nextRoot,
    });
    wsDebug("browse:local:done", {
      id,
      origin: activationOptions.origin,
      targetRuntimeReady,
    });
    return true;
  }

  const connectionController = createWorkspaceConnectionController({
    routing: options.routing,
    activeWorkspaceId,
    activeWorkspaceRoot,
    activeWorkspaceType: () => activeWorkspaceInfo()?.workspaceType ?? null,
    baseUrl: options.baseUrl,
    client: options.client,
    clientDirectory: options.clientDirectory,
    selectedSessionId: options.selectedSessionId,
    normalizeWorkspaceScopePath,
    setClient: options.setClient,
    setConnectedVersion: options.setConnectedVersion,
    setBaseUrl: options.setBaseUrl,
    setClientDirectory: options.setClientDirectory,
    setError: options.setError,
    setBusy: options.setBusy,
    setBusyLabel: options.setBusyLabel,
    setBusyStartedAt: options.setBusyStartedAt,
    setSseConnected: options.setSseConnected,
    setTab: options.setTab,
    setView: options.setView,
    setOpencodeConnectStatus: options.setOpencodeConnectStatus,
    loadSessions: options.loadSessions,
    refreshPendingPermissions: options.refreshPendingPermissions,
    onEngineStable: options.onEngineStable,
    wsDebug,
  });
  const connectToServer = connectionController.connectToServer;
  const activationController = createWorkspaceActivationController({
    workspaces,
    activeWorkspaceId,
    projectDir,
    startupPreference: options.startupPreference,
    hasActiveRoute: () => Boolean(options.routing.active()),
    setConnectingWorkspaceId,
    setWorkspaceSwitchOverlaySuppressionToken,
    setWorkspaceSwitchOverlayTarget,
    updateWorkspaceConnectionState,
    wsActivateGuard,
    runActivationBody: runWorkspaceActivation,
    blockLocalAction,
    cloudOnlyMessage,
    setError: options.setError,
    setBusy: options.setBusy,
    setBusyLabel: options.setBusyLabel,
    setBusyStartedAt: options.setBusyStartedAt,
    safeStringify,
    addOpencodeCacheHint,
    workspaceDebugStack,
    wsDebug,
    wsLog: _wsLog,
    activateTimeoutMs: WORKSPACE_ACTIVATE_TIMEOUT_MS,
  });
  const activateWorkspace = activationController.activateWorkspace;

  function markOnboardingComplete() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(ONBOARDING_COMPLETE_STORAGE_KEY, "1");
    } catch {
      // ignore
    }
  }

  const hasPersistedLanguagePreference = () => {
    if (typeof window === "undefined") return true;
    try {
      return isLanguage(window.localStorage.getItem(LANGUAGE_PREF_KEY));
    } catch {
      return false;
    }
  };

  const languageGate = createOnboardingLanguageGate(hasPersistedLanguagePreference);

  const resolveWelcomeOnboardingStep = (): OnboardingStep =>
    hasPersistedLanguagePreference() ? "welcome" : "language";

  const engineStore = createEngineStore({
    routing: options.routing,
    activeWorkspacePath: () => activeWorkspacePath(),
    activeWorkspaceRoot: () => activeWorkspaceRoot(),
    activeWorkspaceInfo: () => activeWorkspaceInfo(),
    activeWorkspaceId: () => activeWorkspaceId(),
    activeWorkspaceDisplay: () => activeWorkspaceDisplay(),
    projectDir,
    setProjectDir,
    authorizedDirs,
    setAuthorizedDirs,
    engineSource: options.engineSource,
    engineCustomBinPath: options.engineCustomBinPath,
    maxEngines: options.maxEngines,
    idleSuspendMs: options.idleSuspendMs,
    isWindowsPlatform: options.isWindowsPlatform,
    setError: options.setError,
    setBusy: options.setBusy,
    setBusyLabel: options.setBusyLabel,
    setBusyStartedAt: options.setBusyStartedAt,
    setBaseUrl: options.setBaseUrl,
    setClient: options.setClient,
    setConnectedVersion: options.setConnectedVersion,
    setSelectedSessionId: options.setSelectedSessionId,
    setMessages: options.setMessages,
    setTodos: options.setTodos,
    setPendingPermissions: options.setPendingPermissions,
    setSessionStatusById: options.setSessionStatusById,
    setSseConnected: options.setSseConnected,
    setStartupPreference: options.setStartupPreference,
    setOnboardingStep: options.setOnboardingStep,
    setView: options.setView,
    client: options.client,
    onEngineStable: options.onEngineStable,
    connectToServer,
    resolveEngineRuntime,
    resolveWorkspacePaths,
    activateOrchestratorWorkspace,
    activateVesloHostWorkspace,
    blockLocalAction,
    markOnboardingComplete,
    resolveWelcomeOnboardingStep,
    setMigrationRepairResult: (value: any) => configStoreRef.setMigrationRepairResult(value),
  });

  // Use a ref object so the engine store can call configStore methods that
  // are only available after configStore is created (avoids temporal dead zone).
  const configStoreRef: { setMigrationRepairResult: (value: any) => void } = {
    setMigrationRepairResult: () => {},
  };

  const localWorkspaces = createWorkspaceLocalWorkspaces({
    workspaces,
    setWorkspaces,
    activeWorkspaceId,
    activeWorkspaceRoot,
    activeWorkspaceInfo,
    privateWorkspaceRoot,
    setPrivateWorkspaceRoot,
    syncActiveWorkspaceId,
    routing: options.routing,
    activateWorkspace,
    startHost: engineStore.startHost,
    openSessionState: {
      loadSessions: options.loadSessions,
      setView: options.setView,
      setTab: options.setTab,
    },
    clearDisplayedSessionState,
    updateWorkspaceConnectionState,
    clearWorkspaceConnectionState,
    setProjectDir,
    setCreateWorkspaceOpen,
    setError: options.setError,
    setBusy: options.setBusy,
    setBusyLabel: options.setBusyLabel,
    setBusyStartedAt: options.setBusyStartedAt,
    markOnboardingComplete,
    makeRunId,
    blockLocalAction,
  });
  const openEmptySession = localWorkspaces.openEmptySession;
  const activateFreshLocalWorkspace = localWorkspaces.activateFreshLocalWorkspace;
  const createWorkspaceFlow = localWorkspaces.createWorkspaceFlow;
  const createScratchWorkspace = localWorkspaces.createScratchWorkspace;
  const ensureLocalWorkspaceActive = localWorkspaces.ensureLocalWorkspaceActive;
  const ensureWorkspaceForFolder = localWorkspaces.ensureWorkspaceForFolder;
  const forgetWorkspace = localWorkspaces.forgetWorkspace;
  const pickWorkspaceFolder = localWorkspaces.pickWorkspaceFolder;
  const updateWorkspaceDisplayName = localWorkspaces.updateWorkspaceDisplayName;
  const normalizeRoots = localWorkspaces.normalizeRoots;
  const resolveWorkspacePath = localWorkspaces.resolveWorkspacePath;
  const isPrivateWorkspacePath = localWorkspaces.isPrivateWorkspacePath;

  if (isTauriRuntime()) {
    void localWorkspaces.buildPrivateWorkspaceRoot().catch(e => reportError(e, "workspace.buildPrivateRoot"));
  }

  const configStore = createConfigStore({
    getActiveWorkspacePath: () => activeWorkspacePath(),
    getActiveWorkspaceInfo: activeWorkspaceInfo,
    getWorkspaces: workspaces,
    setWorkspaces,
    getWorkspaceConfig: workspaceConfig,
    setWorkspaceConfig,
    getAuthorizedDirs: authorizedDirs,
    setAuthorizedDirs,
    getEngine: engineStore.engine,
    setEngine: engineStore.setEngine,
    syncActiveWorkspaceId,
    setCreateWorkspaceOpen,
    setCreateRemoteWorkspaceOpen,
    markOnboardingComplete,
    activateFreshLocalWorkspace,
    startHost: engineStore.startHost,
    engineSource: options.engineSource,
    engineCustomBinPath: options.engineCustomBinPath,
    engineStop,
    setError: options.setError,
    setBusy: options.setBusy,
    setBusyLabel: options.setBusyLabel,
    setBusyStartedAt: options.setBusyStartedAt,
    setStartupPreference: options.setStartupPreference,
    setOnboardingStep: options.setOnboardingStep,
    blockLocalAction,
    normalizeRoots,
    resolveWorkspacePath,
    formatExecOutput,
    isDbMigrateUnsupported,
    cloudOnlyMessage,
  });

  // Wire up the lazy reference now that configStore is available.
  configStoreRef.setMigrationRepairResult = configStore.setMigrationRepairResult;

  const remoteStore = createRemoteStore({
    getWorkspaces: workspaces,
    setWorkspaces,
    getActiveWorkspaceId: () => activeWorkspaceId(),
    getActiveWorkspaceInfo: () => activeWorkspaceInfo(),
    getActiveWorkspaceRoot: () => activeWorkspaceRoot(),
    getActiveWorkspacePath: () => activeWorkspacePath(),
    getProjectDir: projectDir,
    setProjectDir,
    syncActiveWorkspaceId,
    updateWorkspaceConnectionState,
    getConnectingWorkspaceId: connectingWorkspaceId,
    setConnectingWorkspaceId,
    setWorkspaceConfig,
    setWorkspaceConfigLoaded,
    setAuthorizedDirs,
    setCreateWorkspaceOpen,
    setCreateRemoteWorkspaceOpen,
    getVesloServerSettings: options.vesloServerSettings,
    updateVesloServerSettings: options.updateVesloServerSettings,
    getClientDirectory: options.clientDirectory,
    connectToServer,
    activateWorkspace,
    testWorkspaceConnection,
    openEmptySession,
    setError: options.setError,
    setBusy: options.setBusy,
    setBusyLabel: options.setBusyLabel,
    setBusyStartedAt: options.setBusyStartedAt,
    setStartupPreference: options.setStartupPreference,
    setClient: options.setClient,
    setConnectedVersion: options.setConnectedVersion,
    setSseConnected: options.setSseConnected,
    wsActivateGuard,
    markOnboardingComplete,
    blockLocalAction,
    resolveWorkspacePath,
    wsDebug,
    makeRunId,
  });

  // Wire up the late-bound remote store reference.
  remoteStoreRef.resolveVesloHost = remoteStore.resolveVesloHost;
  remoteStoreRef.createRemoteWorkspaceFlow = remoteStore.createRemoteWorkspaceFlow;

  /** Race a promise against a timeout; resolves to undefined on timeout. */
  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<undefined>((resolve) => {
      timeoutHandle = setTimeout(() => {
        bootTrace(`TIMEOUT: ${label} after ${ms}ms`);
        resolve(undefined);
      }, ms);
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    });
  }

  function bootTraceSinkUrl() {
    if (typeof window === "undefined") return "";
    try {
      const raw = window.localStorage.getItem(BOOT_TRACE_SINK_STORAGE_KEY)?.trim() ?? "";
      if (!raw) return "";
      const url = new URL(raw);
      const protocol = url.protocol.toLowerCase();
      const host = url.hostname.toLowerCase();
      if (protocol !== "http:" && protocol !== "https:") return "";
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return "";
      return url.toString();
    } catch {
      return "";
    }
  }

  /** Send boot trace to console and an explicitly configured local debug sink. */
  function bootTrace(...args: unknown[]) {
    const msg = args.map(a => typeof a === "string" ? a : String(a)).join(" ");
    const line = `[${Date.now()}] ${msg}`;
    console.log("[boot]", msg);
    if (!wsDebugEnabled() || !isTauriRuntime()) return;
    const sinkUrl = bootTraceSinkUrl();
    if (!sinkUrl) return;
    try { fetch(sinkUrl, { method: "POST", body: line, mode: "no-cors" }).catch(() => {}); } catch { /* ignore */ }
  }

  function publishLocalWorkspaceConfigFallback(workspacePath: string, loaded: boolean) {
    setWorkspaceConfig(null);
    setWorkspaceConfigLoaded(loaded);
    setAuthorizedDirs(workspacePath ? [workspacePath] : []);
  }

  function hydrateLocalWorkspaceConfigInBackground(input: {
    workspaceId: string;
    workspacePath: string;
    reason: string;
  }) {
    const workspaceId = input.workspaceId.trim();
    const workspacePath = input.workspacePath.trim();
    if (!workspacePath) return;

    const stillCurrent = () => {
      const active = activeWorkspaceInfo();
      if (!active || active.workspaceType !== "local") return false;
      if (workspaceId && active.id !== workspaceId) return false;
      return (
        normalizeWorkspaceScopePath(active.path, "local") ===
        normalizeWorkspaceScopePath(workspacePath, "local")
      );
    };

    bootTrace("workspaceVesloRead -> background", input.reason);
    void withTimeout(
      workspaceVesloRead({ workspacePath }),
      10_000,
      `workspaceVesloRead:${input.reason}`,
    )
      .then((cfg) => {
        if (!stillCurrent()) return;
        if (cfg) {
          setWorkspaceConfig(cfg);
          setWorkspaceConfigLoaded(true);
          const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
          setAuthorizedDirs(roots.length ? roots : [workspacePath]);
          bootTrace("workspaceVesloRead (bg) DONE", input.reason);
          return;
        }
        publishLocalWorkspaceConfigFallback(workspacePath, true);
        bootTrace("workspaceVesloRead (bg) empty/timeout", input.reason);
      })
      .catch((error) => {
        if (!stillCurrent()) return;
        publishLocalWorkspaceConfigFallback(workspacePath, true);
        _wsLog("[workspace:bootstrap] workspaceVesloRead background failed", {
          workspaceId,
          workspacePath,
          reason: input.reason,
          error: error instanceof Error ? error.message : safeStringify(error),
        });
      });
  }

  function populateSidebarFromDbInBackground(input: {
    workspaceId: string;
    workspacePath: string;
    reason: string;
  }) {
    if (!options.populateSidebarFromDb) return;
    const workspaceId = input.workspaceId.trim();
    const workspacePath = input.workspacePath.trim();
    if (!workspacePath) return;

    _wsLog("[workspace:bootstrap] lazy boot — sidebar from DB", { workspacePath });
    bootTrace("lazy boot — populateSidebarFromDb background...", input.reason);
    void options.populateSidebarFromDb(workspaceId, workspacePath)
      .catch((e) => {
        _wsLog("[workspace:bootstrap] populateSidebarFromDb failed", e);
      })
      .finally(() => {
        _wsLog("[workspace:bootstrap] lazy boot — skip latest transcript hydration", {
          workspaceId: workspaceId || null,
        });
      });
  }

  const scheduledEngineWarmupKeys = new Set<string>();

  function warmActiveLocalWorkspaceEngineInBackground(input: {
    workspaceId: string;
    workspacePath: string;
    reason: string;
  }) {
    if (!isTauriRuntime() || CLOUD_ONLY_MODE) return;
    const workspaceId = input.workspaceId.trim();
    const workspacePath = input.workspacePath.trim();
    if (!workspaceId || !workspacePath) return;

    const stillCurrent = () => {
      const active = activeWorkspaceInfo();
      if (!active || active.workspaceType !== "local") return false;
      if (active.id !== workspaceId) return false;
      return (
        normalizeWorkspaceScopePath(active.path, "local") ===
        normalizeWorkspaceScopePath(workspacePath, "local")
      );
    };

    const warmupScopePath = normalizeWorkspaceScopePath(workspacePath, "local") || workspacePath;
    const warmupKey = `${workspaceId}::${warmupScopePath}`;
    if (scheduledEngineWarmupKeys.has(warmupKey)) return;
    scheduledEngineWarmupKeys.add(warmupKey);

    const startWarmup = () => {
      bootTrace("ensureEngineForWorkspace background warmup...", input.reason);
      void ensureEngineForWorkspace(workspaceId, {
        reason: "boot-warmup",
        loadSessions: false,
      })
        .then((ok) => {
          if (!ok) scheduledEngineWarmupKeys.delete(warmupKey);
          if (!stillCurrent()) return;
          bootTrace("ensureEngineForWorkspace background warmup done", ok ? "ok" : "failed");
        })
        .catch((error) => {
          scheduledEngineWarmupKeys.delete(warmupKey);
          if (!stillCurrent()) return;
          _wsLog("[workspace:bootstrap] engine warmup failed", {
            workspaceId,
            workspacePath,
            reason: input.reason,
            error: error instanceof Error ? error.message : safeStringify(error),
          });
        });
    };
    startWarmup();
  }

  async function bootstrapConfiguredRemoteServer(input: {
    hostUrl: string;
    token?: string | null;
    directory?: string | null;
  }) {
    const hostUrl = normalizeVesloServerUrl(input.hostUrl ?? "") ?? "";
    const token = input.token?.trim() ?? "";
    const directory = input.directory?.trim() ?? "";
    const activeRemoteWorkspace =
      activeWorkspaceInfo()?.workspaceType === "remote" ? activeWorkspaceInfo() : null;
    const matchedRemoteWorkspace = hostUrl
      ? workspaces().find((workspace) => {
          if (workspace.workspaceType !== "remote") return false;
          const workspaceHost = normalizeVesloServerUrl(
            workspace.vesloHostUrl ?? workspace.baseUrl ?? workspace.path ?? "",
          );
          return Boolean(workspaceHost && workspaceHost === hostUrl);
        }) ?? null
      : null;
    const preferredRemoteWorkspace = matchedRemoteWorkspace ?? activeRemoteWorkspace;

    if (preferredRemoteWorkspace?.workspaceType === "remote") {
      options.setOnboardingStep("connecting");
      const ok = await activateWorkspace(preferredRemoteWorkspace.id, { origin: "workspace:connect-preferred-remote" });
      if (ok) return true;

      if (isTauriRuntime()) {
        try {
          const ws = await workspaceForget(preferredRemoteWorkspace.id);
          setWorkspaces(ws.workspaces);
          syncActiveWorkspaceId(ws.activeId);
          clearWorkspaceConnectionState(preferredRemoteWorkspace.id);
        } catch {
          // ignore
        }
      }
    }

    if (!hostUrl) return false;

    options.setOnboardingStep("connecting");
    return await remoteStoreRef.createRemoteWorkspaceFlow({
      vesloHostUrl: hostUrl,
      vesloToken: token || null,
      directory: directory || null,
      displayName: null,
    });
  }

  async function bootstrapOnboarding() {
    bootTrace("bootstrapOnboarding START");
    const startupPref = options.startupPreference() ?? readStartupPreference();
    const onboardingComplete = (() => {
      try {
        return window.localStorage.getItem(ONBOARDING_COMPLETE_STORAGE_KEY) === "1";
      } catch {
        return false;
      }
    })();
    bootTrace("startupPref=" + startupPref + " onboardingComplete=" + onboardingComplete + " isTauri=" + isTauriRuntime());

    if (isTauriRuntime()) {
      try {
        bootTrace("workspaceBootstrap...");
        const ws = await withTimeout(workspaceBootstrap(), 10_000, "workspaceBootstrap");
        if (ws) {
          bootTrace("workspaceBootstrap DONE, " + ws.workspaces.length + " workspaces");
          const nextWorkspaces = ws.workspaces;
          setWorkspaces(nextWorkspaces);
          const nextActiveId =
            nextWorkspaces.find((item) => item.id === ws.activeId)?.id ??
            nextWorkspaces[0]?.id ??
            "";
          syncActiveWorkspaceId(nextActiveId);
        }
      } catch {
        bootTrace("workspaceBootstrap FAILED (ignored)");
      } finally {
        setWorkspacesHydrated(true);
        // Stale connection states (e.g. "error") from a previous orchestrator
        // run survive soft UI restarts because the signal lives in module
        // memory and is not persisted. Clear on every boot.
        setWorkspaceConnectionStateById({});
      }
      // Reconcile veslo-server's workspace registry with the local store. The
      // server is spawned with --workspace arguments captured at engine_start
      // time, which can race with workspaceBootstrap. Hot-register any locals
      // the server doesn't know about so workspace switches don't 404.
      void reconcileVesloServerWorkspaces();
    } else {
      setWorkspacesHydrated(true);
      setWorkspaceConnectionStateById({});
    }

    bootTrace("refreshEngine + refreshEngineDoctor → background");
    void Promise.allSettled([
      withTimeout(engineStore.refreshEngine(), 10_000, "refreshEngine").catch(() => {}),
      withTimeout(engineStore.refreshEngineDoctor(), 10_000, "refreshEngineDoctor").catch(() => {}),
    ]);

    if (isTauriRuntime()) {
      const active = workspaces().find((w) => w.id === activeWorkspaceId()) ?? null;
      if (active) {
        if (active.workspaceType === "remote") {
          setProjectDir(active.directory?.trim() ?? "");
          setWorkspaceConfig(null);
          setWorkspaceConfigLoaded(true);
          setAuthorizedDirs([]);
          if (active.baseUrl) {
            options.setBaseUrl(active.baseUrl);
          }
        } else {
          setProjectDir(active.path);
          publishLocalWorkspaceConfigFallback(active.path, false);
          hydrateLocalWorkspaceConfigInBackground({
            workspaceId: active.id,
            workspacePath: active.path,
            reason: "bootstrap",
          });

        }
      }
    }

    const info = engineStore.engine();
    if (info?.baseUrl) {
      options.setBaseUrl(info.baseUrl);
    }

    const shouldPromptLanguage = languageGate.shouldPrompt();
    bootTrace(
      "language check...",
      "hasPersistedLanguage=",
      hasPersistedLanguagePreference(),
      "shouldPromptLanguage=",
      shouldPromptLanguage,
    );
    if (shouldPromptLanguage) {
      bootTrace("→ setOnboardingStep('language') and RETURN");
      options.setOnboardingStep("language");
      return;
    }

    if (options.onboardingStep() === "language") {
      bootTrace("persisted language found - clearing stale language gate");
      options.setOnboardingStep(resolveWelcomeOnboardingStep());
    }

    const activeWorkspace = activeWorkspaceInfo();

    // Full login gate: every startup flow requires a valid DEN session.
    const denAuth = readDenAuth();
    bootTrace("denAuth required, present=", Boolean(denAuth));
    if (!denAuth) {
      bootTrace("→ setOnboardingStep('auth') and RETURN");
      options.setOnboardingStep("auth");
      return;
    }
    if (options.onboardingStep() === "auth") {
      bootTrace("cached DEN auth found - clearing stale auth gate");
      options.setOnboardingStep(resolveWelcomeOnboardingStep());
    }

    // Fire-and-forget validation: app proceeds with cached token immediately.
    // If the token turns out to be invalid (401/403), the handler clears it
    // and pushes the user to the auth screen reactively.
    bootTrace("validateDenAuth → background");
    void validateDenAuth(denAuth)
      .then((authResult) => {
        bootTrace("validateDenAuth (bg) result=", authResult);
        if (authResult === "invalid") {
          clearDenAuth();
          options.setOnboardingStep("auth");
        }
      })
      .catch(() => {
        // Network error / unreachable — keep cached token, no UI change.
      });

    if (CLOUD_ONLY_MODE) {
      options.setStartupPreference("server");
      const settings = options.vesloServerSettings();
      const cloudHostUrl = normalizeVesloServerUrl(settings.urlOverride ?? "") ?? "";
      const cloudToken = settings.token?.trim() ?? "";
      const cloudDirectory = options.clientDirectory().trim() ? options.clientDirectory().trim() : null;
      const ok = await bootstrapConfiguredRemoteServer({
        hostUrl: cloudHostUrl,
        token: cloudToken || null,
        directory: cloudDirectory,
      });
      if (ok) return;

      options.setOnboardingStep("server");
      return;
    }

    bootTrace("activeWorkspace type=", activeWorkspace?.workspaceType, "CLOUD_ONLY=", CLOUD_ONLY_MODE);
    if (activeWorkspace?.workspaceType === "remote") {
      // Lazy boot: keep the workspace pre-selected in the sidebar but do NOT
      // auto-activate. The user clicks the workspace to connect on demand.
      bootTrace("remote workspace → pre-selected, no auto-activate");
      options.setStartupPreference("server");
      options.setEngineReady?.(false);
      markOnboardingComplete();
      return;
    }

    if (startupPref) {
      options.setStartupPreference(startupPref);
    }

    const settings = options.vesloServerSettings();
    const configuredServerUrl = normalizeVesloServerUrl(settings.urlOverride ?? "") ?? "";
    const shouldAutoBootstrapServer = shouldAutoBootstrapRemoteServer({
      cloudOnlyMode: CLOUD_ONLY_MODE,
      startupPreference: startupPref,
      hasConfiguredServerUrl: Boolean(configuredServerUrl),
      preferServerByDefault: options.preferServerByDefault?.() ?? false,
    });

    if (shouldAutoBootstrapServer) {
      const ok = await bootstrapConfiguredRemoteServer({
        hostUrl: configuredServerUrl,
        token: settings.token ?? null,
        directory: options.clientDirectory().trim() ? options.clientDirectory().trim() : null,
      });
      if (ok) return;
      options.setOnboardingStep("server");
      return;
    }

    if (startupPref === "server") {
      bootTrace("→ setOnboardingStep('server') and RETURN");
      options.setOnboardingStep("server");
      return;
    }

    bootTrace("activeWorkspacePath=", activeWorkspacePath().trim() || "(empty)");
    if (activeWorkspacePath().trim()) {
      const workspacePath = activeWorkspacePath().trim();
      options.setStartupPreference("local");

      // Lazy boot: render the workspace shell immediately. Engine warmup and
      // sidebar rows run in the background and share the send-time runtime path.
      if (isTauriRuntime() && options.populateSidebarFromDb) {
        options.setEngineReady?.(false);
        _wsLog("[workspace:bootstrap] lazy boot — skip Veslo host activation", {
          workspaceId: activeWorkspace?.id ?? null,
        });
        markOnboardingComplete();
        options.setOnboardingStep(resolveWelcomeOnboardingStep());
        warmActiveLocalWorkspaceEngineInBackground({
          workspaceId: activeWorkspace?.id ?? "",
          workspacePath,
          reason: "bootstrap",
        });
        populateSidebarFromDbInBackground({
          workspaceId: activeWorkspace?.id ?? "",
          workspacePath,
          reason: "bootstrap",
        });
        return;
      }

      // Non-Tauri fallback: still no auto-engine-start. Land on the local
      // onboarding step so the user can choose to connect.
      options.setOnboardingStep("local");
      return;
    }

    if (startupPref === "local") {
      options.setOnboardingStep("local");
      return;
    }

    options.setOnboardingStep(resolveWelcomeOnboardingStep());
  }

  function onSelectStartup(nextPref: StartupPreference) {
    if (CLOUD_ONLY_MODE && nextPref === "local") {
      options.setStartupPreference("server");
      options.setOnboardingStep("server");
      blockLocalAction("cloud_only_host_mode_removed", "Local host mode has been removed.");
      return;
    }

    if (options.rememberStartupChoice()) {
      writeStartupPreference(nextPref);
    }
    options.setStartupPreference(nextPref);
    options.setOnboardingStep(nextPref === "local" ? "local" : "server");
  }

  function onBackToWelcome() {
    options.setStartupPreference(null);
    options.setOnboardingStep(resolveWelcomeOnboardingStep());
  }

  async function onStartHost() {
    if (CLOUD_ONLY_MODE) {
      options.setStartupPreference("server");
      options.setOnboardingStep("server");
      blockLocalAction("cloud_only_host_mode_removed", "Local host mode has been removed.");
      return;
    }

    options.setStartupPreference("local");
    options.setOnboardingStep("connecting");
    const ok = await engineStore.startHost({ workspacePath: activeWorkspacePath().trim() });
    if (!ok) {
      options.setOnboardingStep("local");
    }
  }

  async function onAttachHost() {
    if (CLOUD_ONLY_MODE) {
      options.setStartupPreference("server");
      options.setOnboardingStep("server");
      blockLocalAction("cloud_only_host_mode_removed", "Local host mode has been removed.");
      return;
    }

    options.setStartupPreference("local");
    options.setOnboardingStep("connecting");
    const ok = await connectToServer(
      engineStore.engine()?.baseUrl ?? "",
      (activeWorkspacePath().trim() || engineStore.engine()?.projectDir || undefined),
      {
        workspaceId:
          activeWorkspaceInfo()?.workspaceType === "local"
            ? activeWorkspaceInfo()?.id
            : undefined,
        workspaceType: "local",
        targetRoot: activeWorkspacePath().trim() || undefined,
        reason: "attach-local",
      },
      engineStore.engineAuth() ?? undefined,
    );
    if (!ok) {
      options.setStartupPreference(null);
      options.setOnboardingStep(resolveWelcomeOnboardingStep());
    }
  }

  async function onConnectClient() {
    options.setStartupPreference("server");
    options.setOnboardingStep("connecting");
    const settings = options.vesloServerSettings();
    const ok = await remoteStoreRef.createRemoteWorkspaceFlow({
      vesloHostUrl: settings.urlOverride ?? null,
      vesloToken: settings.token ?? null,
      directory: options.clientDirectory().trim() ? options.clientDirectory().trim() : null,
      displayName: null,
    });
    if (!ok) {
      options.setOnboardingStep("server");
      return;
    }
    // Avoid leaving onboarding on the transient "connecting" step after a successful attach.
    options.setOnboardingStep("server");
  }

  async function onConfirmLanguage() {
    languageGate.markConfirmed();
    await bootstrapOnboarding();
  }

  function onRememberStartupToggle() {
    if (typeof window === "undefined") return;
    const next = !options.rememberStartupChoice();
    options.setRememberStartupChoice(next);
    try {
      if (next) {
        const current = options.startupPreference();
        if (CLOUD_ONLY_MODE) {
          writeStartupPreference("server");
        } else if (current === "local" || current === "server") {
          writeStartupPreference(current);
        }
      } else {
        clearStartupPreference();
      }
    } catch {
      // ignore
    }
  }

  let runtimeControllerRef: ReturnType<typeof createWorkspaceRuntimeController> | null = null;
  const connectToEngineQuiet = (
    baseUrl: string,
    directory: string,
    auth?: OpencodeAuth,
    context?: {
      workspaceId?: string;
      workspaceType?: WorkspaceInfo["workspaceType"];
      targetRoot?: string;
      reason?: string;
    },
  ) => {
    if (!runtimeControllerRef) throw new Error("workspace runtime controller not initialized");
    return runtimeControllerRef.connectToEngineQuiet(baseUrl, directory, auth, context);
  };

  const localRuntimeLifecycle = createLocalRuntimeLifecycle({
    engineSource: options.engineSource,
    engineCustomBinPath: options.engineCustomBinPath,
    maxEngines: options.maxEngines,
    idleSuspendMs: options.idleSuspendMs,
    resolveEngineRuntime,
    resolveWorkspacePaths,
    setEngine: engineStore.setEngine,
    setEngineAuth: engineStore.setEngineAuth,
    startEngine: engineStart,
    stopEngine: engineStop,
    readEngineInfo: engineInfo,
    activateOrchestratorWorkspace,
    activateVesloHostWorkspace,
    connectToServer,
    connectQuiet: connectToEngineQuiet,
  });

  const runtimeController = createWorkspaceRuntimeController({
    activeWorkspaceId,
    workspaces,
    workspacesHydrated,
    routing: options.routing,
    resolveEngineRuntime,
    localRuntimeLifecycle,
    connectToServer,
    loadSessions: options.loadSessions,
    setClient: options.setClient,
    setConnectedVersion: options.setConnectedVersion,
    setBaseUrl: options.setBaseUrl,
    setClientDirectory: options.setClientDirectory,
    setEngineReady: options.setEngineReady,
    setError: options.setError,
    updateWorkspaceConnectionState,
    onEngineStable: options.onEngineStable,
    clearWorkspaceBusyAllExcept,
    ensureLocalRuntimeReadyForWorkspaceStart: engineStore.ensureLocalRuntimeReadyForWorkspaceStart,
    syncWorkspaceSkillMaterializationBeforeRuntime,
    probeWorkspaceApiReady: async ({ workspaceId, workspacePath, reason }) => {
      const entry = options.routing.entry(workspaceId);
      const client = entry?.client ?? options.routing.client(workspaceId);
      if (!client) return false;
      const directory = normalizeDirectoryQueryPath(entry?.directory || workspacePath) || undefined;
      _wsLog("[workspace:ensureEngine] probing OpenCode workspace API", {
        workspaceId,
        directory: directory ?? null,
        reason,
      });
      // Read-only and bounded by the runtime controller. Do not use
      // session.create here: this probe only separates process health from
      // workspace/session API readiness.
      const list = unwrap(await client.session.list({ directory, limit: 1 }));
      return Array.isArray(list);
    },
    createClient,
    waitForHealthy,
    safeStringify,
    wsLog: _wsLog,
    dispatchLifecycle: dispatchWorkspaceLifecycle,
    requestWorkspaceFolderAccess: options.requestWorkspaceFolderAccess,
  });
  runtimeControllerRef = runtimeController;

  const ensureEngineForWorkspace = runtimeController.ensureEngineForWorkspace;
  const refreshActiveClient = runtimeController.refreshActiveClient;
  return {
    engine: engineStore.engine,
    engineDoctorResult: engineStore.engineDoctorResult,
    engineDoctorCheckedAt: engineStore.engineDoctorCheckedAt,
    engineInstallLogs: engineStore.engineInstallLogs,
    projectDir,
    workspaces,
    activeWorkspaceId,
    authorizedDirs,
    newAuthorizedDir: configStore.newAuthorizedDir,
    workspaceConfig,
    workspaceConfigLoaded,
    createWorkspaceOpen,
    createRemoteWorkspaceOpen,
    connectingWorkspaceId,
    workspaceSwitchOverlaySuppressed,
    workspaceSwitchOverlayWorkspaceId,
    workspaceConnectionStateById,
    workspaceLifecycleState,
    exportingWorkspaceConfig: configStore.exportingWorkspaceConfig,
    importingWorkspaceConfig: configStore.importingWorkspaceConfig,
    migrationRepairBusy: configStore.migrationRepairBusy,
    migrationRepairResult: configStore.migrationRepairResult,
    activeWorkspaceDisplay,
    activeWorkspacePath,
    activeWorkspaceRoot,
    setCreateWorkspaceOpen,
    setCreateRemoteWorkspaceOpen,
    setProjectDir,
    setAuthorizedDirs,
    setNewAuthorizedDir: configStore.setNewAuthorizedDir,
    setWorkspaceConfig,
    setWorkspaceConfigLoaded,
    setWorkspaces,
    syncActiveWorkspaceId: syncActiveWorkspaceId,
    refreshEngine: engineStore.refreshEngine,
    refreshEngineDoctor: engineStore.refreshEngineDoctor,
    activateWorkspace,
    browseWorkspace,
    ensureEngineForWorkspace,
    refreshActiveClient,
    workspacesHydrated,
    reconcileVesloServerWorkspaces,
    addLocalWorkspaceOnServer,
    testWorkspaceConnection,
    connectToServer,
    createWorkspaceFlow,
    createScratchWorkspace,
    createRemoteWorkspaceFlow: remoteStore.createRemoteWorkspaceFlow,
    updateRemoteWorkspaceFlow: remoteStore.updateRemoteWorkspaceFlow,
    updateWorkspaceDisplayName,
    ensureLocalWorkspaceActive,
    ensureWorkspaceForFolder,
    forgetWorkspace,
    recoverWorkspace: remoteStore.recoverWorkspace,
    pickWorkspaceFolder,
    exportWorkspaceConfig: configStore.exportWorkspaceConfig,
    importWorkspaceConfig: configStore.importWorkspaceConfig,
    canRepairOpencodeMigration: configStore.canRepairOpencodeMigration,
    repairOpencodeMigration: configStore.repairOpencodeMigration,
    startHost: engineStore.startHost,
    stopHost: engineStore.stopHost,
    reloadWorkspaceEngine: engineStore.reloadWorkspaceEngine,
    bootstrapOnboarding,
    onSelectStartup,
    onBackToWelcome,
    onStartHost,
    onRepairOpencodeMigration: configStore.onRepairOpencodeMigration,
    onAttachHost,
    onConnectClient,
    onConfirmLanguage,
    onRememberStartupToggle,
    onInstallEngine: engineStore.onInstallEngine,
    addAuthorizedDir: configStore.addAuthorizedDir,
    addAuthorizedDirFromPicker: configStore.addAuthorizedDirFromPicker,
    removeAuthorizedDir: configStore.removeAuthorizedDir,
    removeAuthorizedDirAtIndex: configStore.removeAuthorizedDirAtIndex,
    persistReloadSettings: configStore.persistReloadSettings,
    setEngineInstallLogs: engineStore.setEngineInstallLogs,
    workspaceDebugEvents,
    clearWorkspaceDebugEvents,
    isPrivateWorkspacePath,
    workspaceBusy,
    markWorkspaceBusy,
    clearWorkspaceBusy,
  };
}
