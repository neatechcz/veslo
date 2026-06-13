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
  isPrivateWorkspacePathForRoot,
  normalizeDirectoryQueryPath,
  normalizeDirectoryPath,
  readStartupPreference,
  safeStringify,
  writeStartupPreference,
} from "../utils";
import { LANGUAGE_PREF_KEY, ONBOARDING_COMPLETE_STORAGE_KEY } from "../constants";
import { reportError } from "../lib/error-reporter";
import { readDenAuth, clearDenAuth, validateDenAuth } from "../lib/den-auth";
import {
  buildVesloWorkspaceBaseUrl,
  createVesloServerClient,
  normalizeVesloServerUrl,
  type VesloServerClient,
  type VesloServerSettings,
  type VesloWorkspaceInfo,
} from "../lib/veslo-server";
import { homeDir } from "@tauri-apps/api/path";
import {
  engineInfo,
  engineStart,
  engineStop,
  orchestratorInstanceDispose,
  orchestratorWorkspaceActivate,
  pickDirectory,
  workspaceBootstrap,
  workspaceCreate,
  workspaceForget,
  workspacePrivateRoot,
  workspaceVesloRead,
  workspaceSetActive,
  workspaceUpdateDisplayName,
  workspaceUpdateRemote,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { waitForHealthy, createClient, type OpencodeAuth } from "../lib/opencode";
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
  setEngineReady?: (value: boolean) => void;
  populateSidebarFromDb?: (workspaceId: string, directory: string) => Promise<void>;
  hydrateLatestSessionFromDb?: (workspaceId: string, directory: string) => Promise<void>;
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

  const makeRunId = () => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };
  const [projectDir, setProjectDir] = createSignal("");
  const [workspaces, setWorkspaces] = createSignal<WorkspaceInfo[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string>("starter");
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
  const {
    workspaceConnectionStateById,
    setWorkspaceConnectionStateById,
    updateWorkspaceConnectionState,
    clearWorkspaceConnectionState,
  } = createWorkspaceConnectionState(workspaces);

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

  const clearDisplayedSessionState = (
    reason: DisplayedSessionResetReason,
    scope: DisplayedSessionResetScope = {},
  ) => {
    const workspaceId = scope.workspaceId ?? activeWorkspaceId().trim();
    const activeRoot = scope.activeWorkspaceRoot ?? activeWorkspaceRoot().trim();
    wsDebug("ui-reset:displayed-session", {
      reason,
      workspaceId: workspaceId || null,
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

  const buildPrivateWorkspaceRoot = async () => {
    const cached = privateWorkspaceRoot().trim();
    if (cached) return cached;
    if (!isTauriRuntime()) return "";
    const next = (await workspacePrivateRoot()).replace(/[\\/]+$/, "");
    setPrivateWorkspaceRoot(next);
    return next;
  };

  if (isTauriRuntime()) {
    void buildPrivateWorkspaceRoot().catch(e => reportError(e, "workspace.buildPrivateRoot"));
  }

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

  async function activateOrchestratorWorkspace(input: { workspacePath: string; name?: string | null }) {
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

  async function activateWorkspace(
    workspaceId: string | undefined,
    activationOptions: WorkspaceActivationOptions,
  ) {
    const id = workspaceId?.trim() ?? "";
    if (!id) return false;

    const next = workspaces().find((w) => w.id === id) ?? null;
    if (!next) return false;
    const isRemote = next.workspaceType === "remote";
    if (CLOUD_ONLY_MODE && !isRemote) {
      updateWorkspaceConnectionState(id, {
        status: "error",
        message: cloudOnlyMessage("cloud_only_local_workspace_filtered", "Local workers are disabled."),
      });
      return blockLocalAction("cloud_only_local_workspace_filtered", "Local workers are disabled.");
    }

    const myVersion = wsActivateGuard.enter(id);
    const isSuperseded = () => wsActivateGuard.isSuperseded(myVersion);

    console.log("[workspace] activate", {
      id: next.id,
      type: next.workspaceType,
      origin: activationOptions.origin,
    });
    const activateStart = Date.now();
    wsDebug("activate:start", {
      id: next.id,
      type: next.workspaceType,
      remoteType: next.remoteType ?? null,
      prevActiveId: activeWorkspaceId(),
      prevProjectDir: projectDir(),
      startupPref: options.startupPreference(),
      hasClient: Boolean(options.routing.active()),
      origin: activationOptions.origin,
      stack: workspaceDebugStack(),
    });

    const remoteType = isRemote ? normalizeRemoteType(next.remoteType) : "opencode";
    const baseUrl = isRemote ? next.baseUrl?.trim() ?? "" : "";

    setConnectingWorkspaceId(id);
    updateWorkspaceConnectionState(id, { status: "connecting", message: null });

    let activateTimeoutId: ReturnType<typeof setTimeout> | null = null;
    if (typeof window !== "undefined") {
      activateTimeoutId = setTimeout(() => {
        if (wsActivateGuard.isSuperseded(myVersion)) return;
        const message = `Timed out switching worker after ${Math.round(WORKSPACE_ACTIVATE_TIMEOUT_MS / 1000)}s.`;
        wsDebug("activate:timeout", { id, timeoutMs: WORKSPACE_ACTIVATE_TIMEOUT_MS });
        options.setError(message);
        updateWorkspaceConnectionState(id, { status: "error", message });
        wsActivateGuard.exit(myVersion, setConnectingWorkspaceId);
        options.setBusy(false);
        options.setBusyLabel(null);
        options.setBusyStartedAt(null);
      }, WORKSPACE_ACTIVATE_TIMEOUT_MS);
    }

    // Allow the UI to paint the "switching" state before we kick off work that can
    // trigger expensive reactive updates (e.g. sidebar session refreshes).
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }

    if (isSuperseded()) {
      wsDebug("activate:superseded:early", { id });
      return false;
    }

    try {
      if (isRemote) {
        options.setStartupPreference("server");

        if (remoteType === "veslo") {
          const hostUrl = next.vesloHostUrl?.trim() ?? "";
          if (!hostUrl) {
            options.setError(__vesloIndirectT("ui.indirect.veslo_server_url_is_required_63g0jb", __vesloIndirectLocale()));
            updateWorkspaceConnectionState(id, {
              status: "error",
              message: __vesloIndirectT("ui.indirect.veslo_server_url_is_required_63g0jb", __vesloIndirectLocale()),
            });
            return false;
          }

          const workspaceToken = next.vesloToken?.trim() ?? "";
          const fallbackToken = options.vesloServerSettings().token ?? "";
          const token = workspaceToken || fallbackToken;

          const currentSettings = options.vesloServerSettings();
          if (
            currentSettings.urlOverride?.trim() !== hostUrl ||
            (token && currentSettings.token?.trim() !== token)
          ) {
            options.updateVesloServerSettings({
              ...currentSettings,
              urlOverride: hostUrl,
              token: token || currentSettings.token,
            });
          }

          let resolvedBaseUrl = baseUrl;
          let resolvedDirectory = next.directory?.trim() ?? "";
          let workspaceInfo: VesloWorkspaceInfo | null = null;
          let resolvedAuth: OpencodeAuth | undefined = undefined;

          try {
            const resolved = await remoteStoreRef.resolveVesloHost({
              hostUrl,
              token,
              workspaceId: next.vesloWorkspaceId ?? null,
              directoryHint: next.directory ?? null,
            });
            if (resolved.kind !== "veslo") {
              options.setError(__vesloIndirectT("ui.indirect.veslo_server_unavailable_check_the_url_and_tok_pthxtb", __vesloIndirectLocale()));
              updateWorkspaceConnectionState(id, {
                status: "error",
                message: __vesloIndirectT("ui.indirect.veslo_server_unavailable_check_the_url_and_tok_pthxtb", __vesloIndirectLocale()),
              });
              return false;
            }

            resolvedBaseUrl = resolved.opencodeBaseUrl;
            resolvedDirectory = resolved.directory;
            workspaceInfo = resolved.workspace;
            resolvedAuth = resolved.auth;
          } catch (error) {
            const message = error instanceof Error ? error.message : safeStringify(error);
            options.setError(addOpencodeCacheHint(message));
            updateWorkspaceConnectionState(id, { status: "error", message });
            return false;
          }

          if (isSuperseded()) {
            wsDebug("activate:superseded:after-veslo-resolve", { id });
            return false;
          }

          if (!resolvedBaseUrl) {
            options.setError(t("app.error.remote_base_url_required", currentLocale()));
            updateWorkspaceConnectionState(id, {
              status: "error",
              message: __vesloIndirectT("ui.indirect.remote_base_url_is_required_1ig1w2", __vesloIndirectLocale()),
            });
            return false;
          }

          const ok = await connectToServer(
            resolvedBaseUrl,
            resolvedDirectory || undefined,
            {
              workspaceId: next.id,
              workspaceType: next.workspaceType,
              targetRoot: resolvedDirectory ?? "",
              reason: "workspace-switch-veslo",
            },
            resolvedAuth,
            { navigate: false },
          );

          if (isSuperseded()) {
            wsDebug("activate:superseded:after-veslo-connect", { id });
            return false;
          }

          if (!ok) {
            updateWorkspaceConnectionState(id, {
              status: "error",
              message: __vesloIndirectT("ui.indirect.failed_to_connect_to_worker_bjt8ig", __vesloIndirectLocale()),
            });
            return false;
          }

          if (workspaceInfo?.id) {
            try {
              const scopedHostUrl =
                buildVesloWorkspaceBaseUrl(hostUrl, workspaceInfo.id) ?? hostUrl;
              const provisionClient = createVesloServerClient({
                baseUrl: scopedHostUrl,
                token: token || undefined,
              });
              const provision = await provisionClient.provisionWorkspaceSystem(workspaceInfo.id);
              wsDebug("activate:veslo:provision", {
                id: workspaceInfo.id,
                status: provision.status,
                version: provision.version,
                written: provision.written,
                unchanged: provision.unchanged,
              });
            } catch (error) {
              wsDebug("activate:veslo:provision:failed", {
                id: workspaceInfo.id,
                message: error instanceof Error ? error.message : safeStringify(error),
              });
            }
          }

          if (isTauriRuntime()) {
            try {
              const ws = await workspaceUpdateRemote({
                workspaceId: next.id,
                remoteType: "veslo",
                baseUrl: resolvedBaseUrl,
                directory: resolvedDirectory || null,
                vesloHostUrl: hostUrl,
                vesloToken: token ? token : null,
                vesloWorkspaceId: workspaceInfo?.id ?? next.vesloWorkspaceId ?? null,
                vesloWorkspaceName: workspaceInfo?.name ?? next.vesloWorkspaceName ?? null,
              });
              setWorkspaces(ws.workspaces);
              syncActiveWorkspaceId(ws.activeId);
            } catch {
              // ignore
            }
          } else {
            // In web mode, we still need to persist the resolved Veslo connection
            // details onto the workspace entry so that the sidebar can list sessions
            // for multiple remotes at once (without relying on global server settings).
            const resolvedToken = token.trim();
            setWorkspaces((prev) =>
              prev.map((ws) => {
                if (ws.id !== next.id) return ws;
                return {
                  ...ws,
                  remoteType: "veslo",
                  baseUrl: resolvedBaseUrl.replace(/\/+$/, ""),
                  directory: resolvedDirectory || null,
                  vesloHostUrl: hostUrl,
                  vesloToken: resolvedToken || null,
                  vesloWorkspaceId: workspaceInfo?.id ?? ws.vesloWorkspaceId ?? null,
                  vesloWorkspaceName: workspaceInfo?.name ?? ws.vesloWorkspaceName ?? null,
                };
              }),
            );
          }

          syncActiveWorkspaceId(id);
          setProjectDir(resolvedDirectory || "");
          setWorkspaceConfig(null);
          setWorkspaceConfigLoaded(true);
          setAuthorizedDirs([]);

          if (isTauriRuntime()) {
            try {
              const ws = await withTimeoutOrThrow(
                workspaceSetActive(id, { promoteToFront: activationOptions?.promoteToFront ?? false }),
                { timeoutMs: WORKSPACE_SET_ACTIVE_TIMEOUT_MS, label: "workspace_set_active" },
              );
              setWorkspaces(ws.workspaces);
              syncActiveWorkspaceId(ws.activeId);
            } catch {
              // ignore
            }
          }

          updateWorkspaceConnectionState(id, { status: "connected", message: null });
          return true;
        }

        if (!baseUrl) {
          options.setError(t("app.error.remote_base_url_required", currentLocale()));
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: __vesloIndirectT("ui.indirect.remote_base_url_is_required_1ig1w2", __vesloIndirectLocale()),
          });
          return false;
        }

        const ok = await connectToServer(
          baseUrl,
          next.directory?.trim() || undefined,
          {
            workspaceId: next.id,
            workspaceType: next.workspaceType,
            targetRoot: next.directory?.trim() ?? "",
            reason: "workspace-switch-direct",
          },
          undefined,
          { navigate: false },
        );

        if (isSuperseded()) {
          wsDebug("activate:superseded:after-direct-connect", { id });
          return false;
        }

        if (!ok) {
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: __vesloIndirectT("ui.indirect.failed_to_connect_to_worker_bjt8ig", __vesloIndirectLocale()),
          });
          return false;
        }

        syncActiveWorkspaceId(id);
        setProjectDir(next.directory?.trim() ?? "");
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([]);

        if (isTauriRuntime()) {
          try {
            const ws = await withTimeoutOrThrow(
              workspaceSetActive(id, { promoteToFront: activationOptions?.promoteToFront ?? false }),
              { timeoutMs: WORKSPACE_SET_ACTIVE_TIMEOUT_MS, label: "workspace_set_active" },
            );
            setWorkspaces(ws.workspaces);
            syncActiveWorkspaceId(ws.activeId);
          } catch {
            // ignore
          }
        }

        updateWorkspaceConnectionState(id, { status: "connected", message: null });
        wsDebug("activate:remote:done", { id, ms: Date.now() - activateStart });
        return true;
      }

    const wasLocalConnection = options.startupPreference() === "local" && options.routing.active();
    options.setStartupPreference("local");
    const nextRoot = isRemote ? next.directory?.trim() ?? "" : next.path;
    const oldWorkspacePath = projectDir();
    const oldWorkspaceScope = normalizeWorkspaceScopePath(oldWorkspacePath, "local");
    const nextWorkspaceScope = normalizeWorkspaceScopePath(nextRoot, "local");
    // Compare against the actual engine directory as a safety net.
    // projectDir() reflects the intended workspace; actualEngineDir is
    // what the engine is actually running on.
    const actualEngineDir = engineStore.engine()?.projectDir?.trim() ?? "";
    const actualEngineScope = normalizeWorkspaceScopePath(actualEngineDir, "local");
    const workspaceChanged =
      workspaceScopeChanged(oldWorkspacePath, nextRoot, "local") ||
      (actualEngineScope !== "" && actualEngineScope !== nextWorkspaceScope);

    wsDebug("activate:local:prep", {
      id,
      nextRoot,
      nextWorkspaceScope,
      workspaceChanged,
      wasLocalConnection: Boolean(wasLocalConnection),
      prevProjectDir: oldWorkspacePath,
      prevWorkspaceScope: oldWorkspaceScope,
      actualEngineDir,
      actualEngineScope,
    });
    _wsLog("[workspace:activate] STEP 1 — syncActiveWorkspaceId + setProjectDir", { id, nextRoot, workspaceChanged, wasLocalConnection, actualEngineDir });

    syncActiveWorkspaceId(id);
    setProjectDir(nextRoot);

    // For local→local workspace switches in Tauri, signal that the engine is not ready
    // for the new workspace BEFORE any await. This prevents reactive effects (idle-loader,
    // SSE sync) from trying to contact the engine API during the async setup phase.
    if (!isRemote && wasLocalConnection && workspaceChanged && isTauriRuntime() && options.populateSidebarFromDb) {
      options.setEngineReady?.(false);
    }

    if (isTauriRuntime()) {
      if (isRemote) {
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([]);
      } else {
        setWorkspaceConfigLoaded(false);
        _wsLog("[workspace:activate] STEP 2 — workspaceVesloRead...", { path: next.path });
        try {
          const cfg = await withTimeoutOrThrow(
            workspaceVesloRead({ workspacePath: next.path }),
            { timeoutMs: WORKSPACE_IO_TIMEOUT_MS, label: "workspace_veslo_read" },
          );
          _wsLog("[workspace:activate] STEP 2 — workspaceVesloRead DONE");
          setWorkspaceConfig(cfg);
          setWorkspaceConfigLoaded(true);

          const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
          if (roots.length) {
            setAuthorizedDirs(roots);
          } else {
            setAuthorizedDirs([next.path]);
          }
        } catch (e) {
          _wsLog("[workspace:activate] STEP 2 — workspaceVesloRead FAILED", e instanceof Error ? e.message : String(e));
          setWorkspaceConfig(null);
          setWorkspaceConfigLoaded(true);
          setAuthorizedDirs([next.path]);
        }
      }

      _wsLog("[workspace:activate] STEP 3 — workspaceSetActive...", { id });
      try {
        const ws = await withTimeoutOrThrow(
          workspaceSetActive(id, { promoteToFront: activationOptions?.promoteToFront ?? false }),
          { timeoutMs: WORKSPACE_SET_ACTIVE_TIMEOUT_MS, label: "workspace_set_active" },
        );
        setWorkspaces(ws.workspaces);
        syncActiveWorkspaceId(ws.activeId);
        _wsLog("[workspace:activate] STEP 3 — workspaceSetActive DONE");
      } catch (e) {
        _wsLog("[workspace:activate] STEP 3 — workspaceSetActive FAILED", e instanceof Error ? e.message : String(e));
      }
    } else if (!isRemote) {
      if (!authorizedDirs().includes(next.path)) {
        const merged = authorizedDirs().length ? authorizedDirs().slice() : [];
        if (!merged.includes(next.path)) merged.push(next.path);
        setAuthorizedDirs(merged);
      }
    } else {
      setAuthorizedDirs([]);
    }

    // If we were previously connected to a remote engine, switching back to a local workspace
    // requires starting (or reconnecting) the local host engine.
    //
    // Without this, we end up keeping the remote client while `startupPreference` flips to
    // "local", and subsequent session/file actions behave inconsistently.
    _wsLog("[workspace:activate] STEP 4 — branch decision", {
      isRemote,
      hasClient: Boolean(options.routing.active()),
      wasLocalConnection,
      workspaceChanged,
    });

    if (!isRemote && options.routing.active() && !wasLocalConnection) {
      if (isSuperseded()) {
        wsDebug("activate:superseded:before-remote-to-local", { id });
        return false;
      }
      _wsLog("[workspace:activate] STEP 4a — remote→local reconnect path");
      wsDebug("activate:remote->local:reconnect", {
        id,
        nextPath: next.path,
        engine: engineStore.engine()?.baseUrl ?? null,
        engineRunning: Boolean(engineStore.engine()?.running),
      });
      if (workspaceChanged) {
        clearDisplayedSessionState("remote_to_local_workspace_changed", {
          workspaceId: id,
          workspaceType: "local",
          previousDirectory: oldWorkspacePath,
          nextDirectory: nextRoot,
          activeWorkspaceRoot: nextRoot,
          clearPendingPermissions: true,
        });
      } else {
        wsDebug("ui-reset:displayed-session:skip", {
          reason: "remote_to_local_same_workspace_scope",
          workspaceId: id,
          previousDirectory: oldWorkspacePath,
          nextDirectory: nextRoot,
          previousDirectoryNormalized: oldWorkspaceScope,
          nextDirectoryNormalized: nextWorkspaceScope,
        });
      }

      // If a local host engine is already running (common when bouncing between remote/local),
      // reuse it instead of restarting to keep switching snappy.
      let connectedToLocalHost = false;
      const existingEngine = engineStore.engine();
      const runtime = existingEngine?.runtime ?? resolveEngineRuntime();
      const canReuseHost =
        isTauriRuntime() &&
        Boolean(existingEngine?.running && existingEngine.baseUrl);

      wsDebug("activate:remote->local:hostReuse", {
        canReuseHost,
        runtime,
        existingEngineBaseUrl: existingEngine?.baseUrl ?? null,
        existingEngineProjectDir: existingEngine?.projectDir ?? null,
      });

      if (canReuseHost && runtime === "veslo-orchestrator") {
        try {
          const reuseStart = Date.now();
          _wsLog("[workspace:activate] STEP 4a.1 — localRuntimeLifecycle.reattachOrchestratorWorkspace...", {
            path: next.path,
          });
          connectedToLocalHost = await localRuntimeLifecycle.reattachOrchestratorWorkspace({
            workspacePath: next.path,
            workspaceId: next.id,
            workspaceName: next.displayName?.trim() || next.name?.trim() || null,
            reason: "workspace-attach-local",
            navigate: false,
          });
          wsDebug("activate:remote->local:reuseHost:done", {
            ok: connectedToLocalHost,
            ms: Date.now() - reuseStart,
          });
        } catch {
          connectedToLocalHost = false;
          wsDebug("activate:remote->local:reuseHost:error");
        }
      }

      if (!connectedToLocalHost) {
        _wsLog("[workspace:activate] STEP 4a.5 — startHost (no reuse)...", { path: next.path });
        const startHostAt = Date.now();
        const ok = await withTimeoutOrThrow(
          engineStore.startHost({ workspacePath: next.path, navigate: false }),
          { timeoutMs: START_HOST_TIMEOUT_MS, label: "startHost" },
        );
        _wsLog("[workspace:activate] STEP 4a.5 — startHost DONE", { ok, ms: Date.now() - startHostAt });
        wsDebug("activate:remote->local:startHost:done", { ok, ms: Date.now() - startHostAt });
        if (!ok) {
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: __vesloIndirectT("ui.indirect.failed_to_start_local_engine_1uglec", __vesloIndirectLocale()),
          });
          return false;
        }
      }
    }

    // BROWSING MODE: Load sessions/messages directly from SQLite so the user
    // can browse history without waiting for engine startup.  Entered when
    // switching between local workspaces (wasLocalConnection truthy) OR on
    // cold boot when no engine is running yet (client is null and startup
    // preference has already been set to "local" by this function), OR when
    // the user clicks the already-active workspace but no engine is running
    // for it yet (post-restart lazy-boot state — without this branch the
    // engine never spawns until a proxy request triggers pool.ensure, which
    // then races the UI's 10s session-list timeout).
    const enginePresentForActiveWorkspace = Boolean(
      engineStore.engine()?.baseUrl?.trim() &&
        normalizeWorkspaceScopePath(engineStore.engine()?.projectDir?.trim() ?? "", "local") ===
          normalizeWorkspaceScopePath(next.path, "local"),
    );
    const needsEngineWarmup = !isRemote && !workspaceChanged && !enginePresentForActiveWorkspace;
    const canBrowseOffline =
      !isRemote && (workspaceChanged || needsEngineWarmup) && isTauriRuntime() && options.populateSidebarFromDb;
    const isColdBoot = !options.routing.active() && options.startupPreference() === "local";
    if (canBrowseOffline && (wasLocalConnection || isColdBoot || needsEngineWarmup)) {
      _wsLog("[workspace:activate] STEP 5-BROWSE — browsing mode, loading from SQLite", { id, path: next.path });
      wsDebug("activate:local->local:browsingMode", { id, nextPath: next.path });

      // Don't clear session state or client connection here.
      // Session state (selectedSessionId, messages, todos) is keyed by
      // session ID so data from different workspaces doesn't collide.
      // The client + server connection is kept alive so the status dot
      // stays green — engineReady(false) below prevents API calls for
      // the wrong workspace, and ensureEngineForWorkspace reconnects
      // to the correct workspace on demand.

      // VSLO-86 — flip engineReady BEFORE the DB hydration calls. selectSession
      // (invoked indirectly by hydrateLatestSessionFromDb) reads this signal
      // to decide whether to hit the SDK or the offline transcript; leaving it
      // at the stale `true` from the previous active workspace forces an SDK
      // session.messages call and pulls a fresh sandbox-exec engine into
      // existence even though the user is just browsing history.
      options.setEngineReady?.(false);

      try {
        await options.populateSidebarFromDb!(id, next.path);
      } catch (e) {
        _wsLog("[workspace:activate] STEP 5-BROWSE — populateSidebarFromDb failed", e);
      }

      try {
        if (options.hydrateLatestSessionFromDb) {
          await options.hydrateLatestSessionFromDb(id, next.path);
        }
      } catch (e) {
        _wsLog("[workspace:activate] STEP 5-BROWSE — hydrateLatestSessionFromDb failed", e);
      }

      updateWorkspaceConnectionState(id, { status: "connected", message: null });

      // VSLO-86 — DO NOT eager-spawn the engine here. The user is just
      // browsing history; spawning sandbox-exec + opencode serve takes
      // 30-60s of cold-start and locks the UI behind an "Otevírám
      // konverzaci…" spinner before they've even decided to send anything.
      // sendPrompt (app.tsx) already calls ensureEngineForWorkspace + the
      // AI-access bootstrap before sending, so the engine spawns on the
      // first real interaction (~10-15s) instead of on every sidebar click.

      wsDebug("activate:local->local:browsingMode:done", { id, ms: Date.now() - activateStart });
      return true;
    }

    // When running locally, restart the engine when workspace changes (fallback for non-Tauri)
    let engineRestartFailed = false;
    if (!isRemote && wasLocalConnection && workspaceChanged) {
      if (isSuperseded()) {
        wsDebug("activate:superseded:before-engine-restart", { id });
        return false;
      }
      _wsLog("[workspace:activate] STEP 5 — local→local engine restart", { id, path: next.path });
      wsDebug("activate:local->local:restartEngine", { id, nextPath: next.path });
      options.setError(null);
      options.setBusy(true);
      options.setBusyLabel("status.restarting_engine");
      options.setBusyStartedAt(Date.now());

      try {
        const skillsReady = await syncWorkspaceSkillMaterializationBeforeRuntime(next, {
          reason: "workspace-restart",
        });
        if (!skillsReady) {
          engineRestartFailed = true;
          return false;
        }
        const runtime = resolveEngineRuntime();
        _wsLog("[workspace:activate] STEP 5 — runtime =", runtime);
        _wsLog("[workspace:activate] STEP 5.1 — localRuntimeLifecycle.restartWorkspaceRuntime...", {
          path: next.path,
          runtime,
        });
        const ok = await localRuntimeLifecycle.restartWorkspaceRuntime({
          workspacePath: next.path,
          workspaceId: next.id,
          workspaceName: next.displayName?.trim() || next.name?.trim() || null,
          reason: runtime === "veslo-orchestrator" ? "workspace-orchestrator-switch" : "workspace-restart",
          navigate: false,
        });
        if (!ok) {
          engineRestartFailed = true;
          options.setError("Failed to reconnect after worker switch");
        }
      } catch (e) {
        engineRestartFailed = true;
        const message = e instanceof Error ? e.message : safeStringify(e);
        options.setError(addOpencodeCacheHint(message));
      } finally {
        options.setBusy(false);
        options.setBusyLabel(null);
        options.setBusyStartedAt(null);
      }
    }

      if (engineRestartFailed) {
        _wsLog("[workspace:activate] STEP 6 — engineRestartFailed!", { id, ms: Date.now() - activateStart });
        updateWorkspaceConnectionState(id, {
          status: "error",
          message: __vesloIndirectT("ui.indirect.failed_to_switch_worker_ayyxrj", __vesloIndirectLocale()),
        });
        wsDebug("activate:local:engineRestartFailed", { id, ms: Date.now() - activateStart });
        return false;
      }

      _wsLog("[workspace:activate] STEP 6 — SUCCESS, refreshing skills/plugins", { id, ms: Date.now() - activateStart });
      options.refreshSkills({ force: true }).catch(e => reportError(e, "workspace.refreshSkills"));
      options.refreshPlugins().catch(e => reportError(e, "workspace.refreshPlugins"));
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      wsDebug("activate:local:done", { id, ms: Date.now() - activateStart });
      return true;
    } finally {
      if (activateTimeoutId !== null) {
        clearTimeout(activateTimeoutId);
      }
      _wsLog("[workspace:activate] FINALLY — clearing connectingWorkspaceId", { id, ms: Date.now() - activateStart });
      wsActivateGuard.exit(myVersion, setConnectingWorkspaceId);
      wsDebug("activate:finally", { id, ms: Date.now() - activateStart });
    }
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

  const openEmptySession = async (scopeRoot?: string) => {
    const root = (scopeRoot ?? activeWorkspaceRoot().trim()).trim();
    if (options.routing.active()) {
      try {
        await options.loadSessions(root || undefined);
      } catch {
        // If session loading fails, still fall back to an empty session draft view.
      }
    }
    clearDisplayedSessionState("open_empty_session", {
      workspaceId: activeWorkspaceId().trim(),
      workspaceType: activeWorkspaceInfo()?.workspaceType ?? null,
      nextDirectory: root || null,
      activeWorkspaceRoot: root || activeWorkspaceRoot().trim(),
      clearPendingPermissions: true,
    });
    options.setView("session");
  };

  const activateFreshLocalWorkspace = async (workspaceId: string | null, workspacePath: string) => {
    if (!workspaceId) {
      await openEmptySession(workspacePath);
      return true;
    }
    const hasClient = Boolean(options.routing.client(workspaceId));
    const ok = hasClient
      ? await activateWorkspace(workspaceId, { origin: "workspace:activate-fresh-local" })
      : await engineStore.startHost({ workspacePath, navigate: false });
    if (!ok) return false;
    await openEmptySession(activeWorkspaceRoot().trim() || workspacePath);
    return true;
  };

  async function createLocalWorkspace(
    preset: WorkspacePreset,
    folder: string | null,
    flowOptions?: {
      markOnboardingComplete?: boolean;
      navigateToDashboard?: boolean;
      closeModal?: boolean;
      workspaceName?: string | null;
    },
  ) {
    if (CLOUD_ONLY_MODE) {
      blockLocalAction("cloud_only_local_disabled", "Local workspace creation is disabled.");
      return null;
    }

    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return null;
    }

    if (!folder) {
      options.setError(t("app.error.choose_folder", currentLocale()));
      return null;
    }

    options.setBusy(true);
    options.setBusyLabel("status.creating_workspace");
    options.setBusyStartedAt(Date.now());
    options.setError(null);

    try {
      const resolvedFolder = await resolveWorkspacePath(folder);
      if (!resolvedFolder) {
        options.setError(t("app.error.choose_folder", currentLocale()));
        return null;
      }

      const explicitName = flowOptions?.workspaceName?.trim() ?? "";
      const name =
        explicitName ||
        resolvedFolder.replace(/\\/g, "/").split("/").filter(Boolean).pop() ||
        "Workspace";
      const ws = await workspaceCreate({ folderPath: resolvedFolder, name, preset });
      setWorkspaces(ws.workspaces);
      syncActiveWorkspaceId(ws.activeId);
      if (ws.activeId) {
        updateWorkspaceConnectionState(ws.activeId, { status: "connected", message: null });
      }

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;

      if (flowOptions?.closeModal !== false) {
        setCreateWorkspaceOpen(false);
      }
      if (flowOptions?.navigateToDashboard !== false) {
        options.setTab("scheduled");
        options.setView("dashboard");
      }
      if (flowOptions?.markOnboardingComplete !== false) {
        markOnboardingComplete();
      }
      return active;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return null;
    } finally {
      options.setBusy(false);
      options.setBusyLabel(null);
      options.setBusyStartedAt(null);
    }
  }

  async function createWorkspaceFlow(preset: WorkspacePreset, folder: string | null) {
    const created = await createLocalWorkspace(preset, folder, {
      markOnboardingComplete: true,
      navigateToDashboard: false,
      closeModal: true,
    });
    if (!created) return;
    const opened = await activateFreshLocalWorkspace(created.id ?? null, created.path);
    if (!opened) return;
  }

  async function createScratchWorkspace() {
    if (CLOUD_ONLY_MODE) {
      blockLocalAction("cloud_only_local_disabled", "Local workspace creation is disabled.");
      return null;
    }
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return null;
    }

    const root = await buildPrivateWorkspaceRoot();
    if (!root) {
      options.setError("Failed to resolve private workspace root.");
      return null;
    }

    const name = "Private workspace";
    const runId = makeRunId().replace(/[^a-z0-9-]+/gi, "").slice(0, 24) || `${Date.now()}`;
    const folder = `${root}/${Date.now()}-${runId}`;
    return await createLocalWorkspace("starter", folder, {
      markOnboardingComplete: true,
      navigateToDashboard: false,
      closeModal: false,
      workspaceName: name,
    });
  }

  const findLocalWorkspaceByPath = (folder: string) => {
    const normalized = normalizeDirectoryPath(folder);
    if (!normalized) return null;
    return workspaces().find(
      (workspace) =>
        workspace.workspaceType === "local" &&
        normalizeDirectoryPath(workspace.path?.trim() ?? "") === normalized,
    ) ?? null;
  };

  async function ensureWorkspaceForFolder(folder: string) {
    const resolvedFolder = await resolveWorkspacePath(folder);
    if (!resolvedFolder) {
      options.setError(t("app.error.choose_folder", currentLocale()));
      return null;
    }

    const existing = findLocalWorkspaceByPath(resolvedFolder);
    if (existing) {
      setWorkspaces((prev) => {
        const rest = prev.filter((workspace) => workspace.id !== existing.id);
        return [existing, ...rest];
      });
      return existing;
    }

    return await createLocalWorkspace("starter", resolvedFolder, {
      markOnboardingComplete: true,
      navigateToDashboard: false,
      closeModal: false,
    });
  }

  const isPrivateWorkspacePath = (folder: string | null | undefined) => {
    return isPrivateWorkspacePathForRoot(folder, privateWorkspaceRoot());
  };

  async function ensureLocalWorkspaceActive(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    const activated = await activateWorkspace(id, { origin: "workspace:ensure-local-active" });
    if (activated === false) return false;
    if (options.routing.client(id)) return true;

    const workspace = workspaces().find((entry) => entry.id === id) ?? null;
    if (!workspace || workspace.workspaceType !== "local") {
      options.setError("Local workspace is not available.");
      return false;
    }

    const started = await engineStore.startHost({ workspacePath: workspace.path, navigate: false });
    if (!started) return false;
    return Boolean(options.routing.client(id));
  }

  async function forgetWorkspace(
    workspaceId: string,
    forgetOptions?: { deleteLocalData?: boolean },
  ): Promise<boolean> {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return false;
    }

    const id = workspaceId.trim();
    if (!id) return false;

    console.log("[workspace] forget", { id });

    try {
      const previousActive = activeWorkspaceId();
      const mode = forgetOptions?.deleteLocalData ? "delete_local_data" : "detach_only";
      const ws = await workspaceForget(id, mode);
      setWorkspaces(ws.workspaces);
      clearWorkspaceConnectionState(id);
      syncActiveWorkspaceId(ws.activeId);

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
      if (active) {
        setProjectDir(active.workspaceType === "remote" ? active.directory?.trim() ?? "" : active.path);
      }

      if (ws.activeId && ws.activeId !== previousActive) {
        const activated = await activateWorkspace(ws.activeId, { origin: "workspace:forget-next-active" });
        if (!activated) return false;
      }
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return false;
    }
  }

  async function pickWorkspaceFolder(defaultPath?: string | null) {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return null;
    }

    try {
      const preferredPath = defaultPath?.trim() ?? "";
      const selection = await pickDirectory({
        title: t("onboarding.choose_workspace_folder", currentLocale()),
        defaultPath: preferredPath || undefined,
      });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;

      return folder ?? null;
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
      return null;
    }
  }

  async function updateWorkspaceDisplayName(workspaceId: string, displayName: string | null) {
    const id = workspaceId.trim();
    if (!id) return false;
    const workspace = workspaces().find((item) => item.id === id) ?? null;
    if (!workspace) return false;

    const nextDisplayName = displayName?.trim() || null;
    options.setError(null);

    if (isTauriRuntime()) {
      try {
        const ws = await workspaceUpdateDisplayName({ workspaceId: id, displayName: nextDisplayName });
        setWorkspaces(ws.workspaces);
        if (ws.activeId) {
          updateWorkspaceConnectionState(ws.activeId, { status: "connected", message: null });
        }
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : safeStringify(e);
        options.setError(addOpencodeCacheHint(message));
        return false;
      }
    }

    setWorkspaces((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              displayName: nextDisplayName,
              name: nextDisplayName ?? entry.name,
            }
          : entry
      )
    );
    return true;
  }

  function normalizeRoots(list: string[]) {
    const out: string[] = [];
    for (const entry of list) {
      const trimmed = entry.trim().replace(/\/+$/, "");
      if (!trimmed) continue;
      if (!out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  }

  async function resolveWorkspacePath(input: string) {
    const trimmed = input.trim();
    if (!trimmed) return "";
    if (!isTauriRuntime()) return trimmed;

    if (trimmed === "~") {
      try {
        return (await homeDir()).replace(/[\\/]+$/, "");
      } catch {
        return trimmed;
      }
    }

    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      try {
        const home = (await homeDir()).replace(/[\\/]+$/, "");
        return `${home}${trimmed.slice(1)}`;
      } catch {
        return trimmed;
      }
    }

    return trimmed;
  }

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

  /** Send boot trace to local debug server + console */
  function bootTrace(...args: unknown[]) {
    const msg = args.map(a => typeof a === "string" ? a : String(a)).join(" ");
    const line = `[${Date.now()}] ${msg}`;
    console.log("[boot]", msg);
    if (!wsDebugEnabled() || !isTauriRuntime()) return;
    // Intentionally silent: localhost debug telemetry — failure is expected when no debug server is running
    try { fetch("http://127.0.0.1:9876", { method: "POST", body: line, mode: "no-cors" }).catch(() => {}); } catch { /* ignore */ }
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
          try {
            const cfg = await withTimeout(workspaceVesloRead({ workspacePath: active.path }), 10_000, "workspaceVesloRead");
            if (cfg) {
              setWorkspaceConfig(cfg);
              setWorkspaceConfigLoaded(true);
              const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
              setAuthorizedDirs(roots.length ? roots : [active.path]);
            } else {
              setWorkspaceConfig(null);
              setWorkspaceConfigLoaded(true);
              setAuthorizedDirs([active.path]);
            }
          } catch {
            setWorkspaceConfig(null);
            setWorkspaceConfigLoaded(true);
            setAuthorizedDirs([active.path]);
          }

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

      // Lazy boot: do NOT connect to or start the engine here. Pre-load the
      // sidebar from SQLite so the workspace is browsable immediately. The
      // engine spins up on demand when the user clicks a workspace / sends
      // a message (activateWorkspace → ensureEngineForWorkspace).
      if (isTauriRuntime() && options.populateSidebarFromDb) {
        _wsLog("[workspace:bootstrap] lazy boot — sidebar from DB", { workspacePath });
        bootTrace("lazy boot — populateSidebarFromDb...");
        options.setEngineReady?.(false);
        try {
          await options.populateSidebarFromDb(activeWorkspace?.id ?? "", workspacePath);
        } catch (e) {
          _wsLog("[workspace:bootstrap] populateSidebarFromDb failed", e);
        }
        try {
          if (options.hydrateLatestSessionFromDb && activeWorkspace) {
            await options.hydrateLatestSessionFromDb(activeWorkspace.id, workspacePath);
          }
        } catch (e) {
          _wsLog("[workspace:bootstrap] hydrateLatestSessionFromDb failed", e);
        }
        markOnboardingComplete();
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
  const connectToEngineQuiet = (baseUrl: string, directory: string, auth?: OpencodeAuth) => {
    if (!runtimeControllerRef) throw new Error("workspace runtime controller not initialized");
    return runtimeControllerRef.connectToEngineQuiet(baseUrl, directory, auth);
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
    syncWorkspaceSkillMaterializationBeforeRuntime,
    createClient,
    waitForHealthy,
    safeStringify,
    wsLog: _wsLog,
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
    workspaceConnectionStateById,
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
