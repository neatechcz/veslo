import { createEffect, createMemo, createSignal } from "solid-js";
import type {
  Client,
  StartupPreference,
  OnboardingStep,
  WorkspaceDisplay,
  WorkspaceVesloConfig,
  WorkspacePreset,
  WorkspaceConnectionState,
  EngineRuntime,
} from "../types";
import {
  addOpencodeCacheHint,
  clearStartupPreference,
  isTauriRuntime,
  normalizeDirectoryPath,
  readStartupPreference,
  safeStringify,
  writeStartupPreference,
} from "../utils";
import { LANGUAGE_PREF_KEY } from "../constants";
import { reportError } from "../lib/error-reporter";
import { unwrap } from "../lib/opencode";
import { readDenAuth, clearDenAuth, validateDenAuth } from "../lib/den-auth";
import {
  buildVesloWorkspaceBaseUrl,
  createVesloServerClient,
  normalizeVesloServerUrl,
  type VesloServerClient,
  type VesloServerSettings,
  type VesloWorkspaceInfo,
} from "../lib/veslo-server";
import { appDataDir, homeDir } from "@tauri-apps/api/path";
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
  workspaceVesloRead,
  workspaceSetActive,
  workspaceUpdateDisplayName,
  workspaceUpdateRemote,
  type EngineInfo,
  type WorkspaceInfo,
} from "../lib/tauri";
import { waitForHealthy, createClient, type OpencodeAuth } from "../lib/opencode";
import type { OpencodeConnectStatus, ProviderListItem } from "../types";
import { t, currentLocale, isLanguage } from "../../i18n";
import { mapConfigProvidersToList } from "../utils/providers";
import { withTimeoutOrThrow } from "../utils/promise-timeout";
import {
  activateVesloHostWorkspaceWithTimeout,
  runWorkspaceEngineRestartWithTimeouts,
} from "../utils/workspace-switch-timeouts";
import { CLOUD_ONLY_MODE } from "../lib/cloud-policy";
import { createWorkspaceActivateGuard } from "./workspace-activate-guard";
import { createConfigStore } from "../stores/config-store";
import { createEngineStore } from "../stores/engine-store";
import { createRemoteStore } from "../stores/remote-store";

export type { MigrationRepairResult } from "../stores/config-store";
export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

export type WorkspaceDebugEvent = {
  at: number;
  label: string;
  payload?: unknown;
};

export type SandboxCreateProgressStepStatus = "pending" | "active" | "done" | "error";

export type SandboxCreateProgressStep = {
  key: "docker" | "workspace" | "sandbox" | "health" | "connect";
  label: string;
  status: SandboxCreateProgressStepStatus;
  detail?: string | null;
};

export type SandboxCreateProgressState = {
  runId: string;
  startedAt: number;
  stage: string;
  steps: SandboxCreateProgressStep[];
  logs: string[];
  error: string | null;
};

export type SandboxCreatePhase = "idle" | "preflight" | "provisioning" | "finalizing";


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
  setEngineSource: (value: "path" | "sidecar" | "custom") => void;
  setView: (value: any) => void;
  setTab: (value: any) => void;
  isWindowsPlatform: () => boolean;
  vesloServerSettings: () => VesloServerSettings;
  updateVesloServerSettings: (next: VesloServerSettings) => void;
  vesloServerClient?: () => VesloServerClient | null;
  setOpencodeConnectStatus?: (status: OpencodeConnectStatus | null) => void;
  onEngineStable?: () => void;
  engineRuntime?: () => EngineRuntime;
  developerMode: () => boolean;
}) {
  const cloudOnlyMessage = (code: string, detail: string) => `${code}: ${detail}`;
  const blockLocalAction = (code: string, detail: string) => {
    const message = cloudOnlyMessage(code, detail);
    options.setError(message);
    wsDebug("cloud-only:block", { code, detail });
    return false;
  };

  const wsDebugEnabled = () => options.developerMode();

  const WORKSPACE_DEBUG_EVENT_LIMIT = 200;
  const [workspaceDebugEvents, setWorkspaceDebugEvents] = createSignal<WorkspaceDebugEvent[]>([]);
  const clearWorkspaceDebugEvents = () => setWorkspaceDebugEvents([]);
  const pushWorkspaceDebugEvent = (label: string, payload?: unknown) => {
    if (!wsDebugEnabled()) return;
    const entry: WorkspaceDebugEvent = { at: Date.now(), label, payload };
    setWorkspaceDebugEvents((prev) => {
      if (!prev.length) return [entry];
      const sliceStart = Math.max(0, prev.length - WORKSPACE_DEBUG_EVENT_LIMIT + 1);
      const next = prev.slice(sliceStart);
      next.push(entry);
      return next;
    });
  };

  const wsDebug = (label: string, payload?: unknown) => {
    if (!wsDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
      pushWorkspaceDebugEvent(label, payload);
    } catch {
      // ignore
    }
  };

  const wsActivateGuard = createWorkspaceActivateGuard();
  const connectInFlightByKey = new Map<string, Promise<boolean>>();

  // Late-bound reference for the remote store — populated after createRemoteStore().
  const remoteStoreRef: {
    resolveVesloHost: (...args: any[]) => Promise<any>;
    createRemoteWorkspaceFlow: (...args: any[]) => Promise<boolean>;
    clearSandboxCreateProgress: () => void;
  } = {
    resolveVesloHost: () => { throw new Error("remoteStore not initialized"); },
    createRemoteWorkspaceFlow: () => { throw new Error("remoteStore not initialized"); },
    clearSandboxCreateProgress: () => {},
  };

  const DEFAULT_CONNECT_HEALTH_TIMEOUT_MS = 12_000;
  const LOCAL_BOOT_CONNECT_HEALTH_TIMEOUT_MS = 180_000;
  const CONNECT_PROVIDER_LIST_TIMEOUT_MS = 12_000;
  const CONNECT_LOAD_SESSIONS_TIMEOUT_MS = 20_000;
  const CONNECT_PENDING_PERMISSIONS_TIMEOUT_MS = 8_000;
  const WORKSPACE_IO_TIMEOUT_MS = 8_000;
  const WORKSPACE_SET_ACTIVE_TIMEOUT_MS = 8_000;
  const ENGINE_INFO_TIMEOUT_MS = 12_000;
  const START_HOST_TIMEOUT_MS = 45_000;
  const WORKSPACE_ACTIVATE_TIMEOUT_MS = 30_000;
  const ORCHESTRATOR_WORKSPACE_ACTIVATE_TIMEOUT_MS = 15_000;
  const LONG_BOOT_CONNECT_REASONS = new Set([
    "host-start",
    "workspace-orchestrator-switch",
    "workspace-restart",
  ]);
  const DB_MIGRATE_UNSUPPORTED_PATTERNS = [
    /unknown(?:\s+sub)?command\s+['"`]?db['"`]?/i,
    /unrecognized(?:\s+sub)?command\s+['"`]?db['"`]?/i,
    /no such command[:\s]+db/i,
    /found argument ['"`]db['"`] which wasn't expected/i,
  ] as const;

  const connectRequestKey = (
    nextBaseUrl: string,
    directory?: string,
    context?: {
      workspaceId?: string;
      workspaceType?: WorkspaceInfo["workspaceType"];
      targetRoot?: string;
      reason?: string;
    },
    auth?: OpencodeAuth,
    connectOptions?: { quiet?: boolean; navigate?: boolean },
  ) =>
    [
      nextBaseUrl.trim(),
      (directory ?? "").trim(),
      context?.workspaceId?.trim() ?? "",
      context?.workspaceType ?? "",
      context?.targetRoot?.trim() ?? "",
      context?.reason ?? "",
      auth?.mode ?? (auth ? "basic" : "none"),
      String(connectOptions?.quiet ?? false),
      String(connectOptions?.navigate ?? true),
    ].join("::");

  const resolveConnectHealthTimeoutMs = (reason?: string) => {
    const normalizedReason = reason?.trim() ?? "";
    if (LONG_BOOT_CONNECT_REASONS.has(normalizedReason)) {
      return LOCAL_BOOT_CONNECT_HEALTH_TIMEOUT_MS;
    }
    return DEFAULT_CONNECT_HEALTH_TIMEOUT_MS;
  };

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

  const syncActiveWorkspaceId = (id: string) => {
    setActiveWorkspaceId(id);
  };

  const [authorizedDirs, setAuthorizedDirs] = createSignal<string[]>([]);

  const [workspaceConfig, setWorkspaceConfig] = createSignal<WorkspaceVesloConfig | null>(null);
  const [workspaceConfigLoaded, setWorkspaceConfigLoaded] = createSignal(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = createSignal(false);
  const [createRemoteWorkspaceOpen, setCreateRemoteWorkspaceOpen] = createSignal(false);
  const [connectingWorkspaceId, setConnectingWorkspaceId] = createSignal<string | null>(null);
  const [workspaceConnectionStateById, setWorkspaceConnectionStateById] = createSignal<
    Record<string, WorkspaceConnectionState>
  >({});

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

  const buildPrivateWorkspaceRoot = async () => {
    const cached = privateWorkspaceRoot().trim();
    if (cached) return cached;
    if (!isTauriRuntime()) return "";
    const base = (await appDataDir()).replace(/[\\/]+$/, "");
    const next = `${base}/private-workspaces`;
    setPrivateWorkspaceRoot(next);
    return next;
  };

  if (isTauriRuntime()) {
    void buildPrivateWorkspaceRoot().catch(e => reportError(e, "workspace.buildPrivateRoot"));
  }

  const updateWorkspaceConnectionState = (
    workspaceId: string,
    next: Partial<WorkspaceConnectionState>,
  ) => {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceConnectionStateById((prev) => {
      const current = prev[id] ?? { status: "idle", message: null, checkedAt: null };
      return {
        ...prev,
        [id]: {
          ...current,
          ...next,
          checkedAt: Date.now(),
        },
      };
    });
  };

  const clearWorkspaceConnectionState = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setWorkspaceConnectionStateById((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  createEffect(() => {
    const ids = new Set(workspaces().map((workspace) => workspace.id));
    setWorkspaceConnectionStateById((prev) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [id, state] of Object.entries(prev)) {
        if (!ids.has(id)) {
          changed = true;
          continue;
        }
        next[id] = state;
      }
      return changed ? next : prev;
    });
  });

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

  const activateVesloHostWorkspace = async (workspacePath: string) => {
    const client = options.vesloServerClient?.();
    if (!client) return;
    const targetPath = normalizeDirectoryPath(workspacePath);
    if (!targetPath) return;
    try {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
      if (!match?.id) return;
      if (response.activeId === match.id) return;
      await client.activateWorkspace(match.id);
    } catch {
      // ignore
    }
  };

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
          message: "Veslo server URL is required.",
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
            message: "Veslo server unavailable. Check the URL and token.",
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
        message: "Remote base URL is required.",
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

  async function activateWorkspace(workspaceId: string) {
    const id = workspaceId.trim();
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

    console.log("[workspace] activate", { id: next.id, type: next.workspaceType });
    const activateStart = Date.now();
    wsDebug("activate:start", {
      id: next.id,
      type: next.workspaceType,
      remoteType: next.remoteType ?? null,
      prevActiveId: activeWorkspaceId(),
      prevProjectDir: projectDir(),
      startupPref: options.startupPreference(),
      hasClient: Boolean(options.client()),
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
            options.setError("Veslo server URL is required.");
            updateWorkspaceConnectionState(id, {
              status: "error",
              message: "Veslo server URL is required.",
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
              options.setError("Veslo server unavailable. Check the URL and token.");
              updateWorkspaceConnectionState(id, {
                status: "error",
                message: "Veslo server unavailable. Check the URL and token.",
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
              message: "Remote base URL is required.",
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
              message: "Failed to connect to worker.",
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
              await withTimeoutOrThrow(
                workspaceSetActive(id),
                { timeoutMs: WORKSPACE_SET_ACTIVE_TIMEOUT_MS, label: "workspace_set_active" },
              );
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
            message: "Remote base URL is required.",
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
            message: "Failed to connect to worker.",
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
            await withTimeoutOrThrow(
              workspaceSetActive(id),
              { timeoutMs: WORKSPACE_SET_ACTIVE_TIMEOUT_MS, label: "workspace_set_active" },
            );
          } catch {
            // ignore
          }
        }

        updateWorkspaceConnectionState(id, { status: "connected", message: null });
        wsDebug("activate:remote:done", { id, ms: Date.now() - activateStart });
        return true;
      }

    const wasLocalConnection = options.startupPreference() === "local" && options.client();
    options.setStartupPreference("local");
    const nextRoot = isRemote ? next.directory?.trim() ?? "" : next.path;
    const oldWorkspacePath = projectDir();
    // Compare against the actual engine directory, not just projectDir().
    // createLocalWorkspace() prematurely updates projectDir before
    // activateWorkspace runs, so projectDir() may already equal nextRoot
    // even though the engine is still on the previous workspace.
    const actualEngineDir = engineStore.engine()?.projectDir?.trim() ?? "";
    const workspaceChanged =
      oldWorkspacePath !== nextRoot ||
      (actualEngineDir !== "" && actualEngineDir !== nextRoot);

    wsDebug("activate:local:prep", {
      id,
      nextRoot,
      workspaceChanged,
      wasLocalConnection: Boolean(wasLocalConnection),
      prevProjectDir: oldWorkspacePath,
      actualEngineDir,
    });

    syncActiveWorkspaceId(id);
    setProjectDir(nextRoot);

    if (isTauriRuntime()) {
      if (isRemote) {
        setWorkspaceConfig(null);
        setWorkspaceConfigLoaded(true);
        setAuthorizedDirs([]);
      } else {
        setWorkspaceConfigLoaded(false);
        try {
          const cfg = await withTimeoutOrThrow(
            workspaceVesloRead({ workspacePath: next.path }),
            { timeoutMs: WORKSPACE_IO_TIMEOUT_MS, label: "workspace_veslo_read" },
          );
          setWorkspaceConfig(cfg);
          setWorkspaceConfigLoaded(true);

          const roots = Array.isArray(cfg.authorizedRoots) ? cfg.authorizedRoots : [];
          if (roots.length) {
            setAuthorizedDirs(roots);
          } else {
            setAuthorizedDirs([next.path]);
          }
        } catch {
          setWorkspaceConfig(null);
          setWorkspaceConfigLoaded(true);
          setAuthorizedDirs([next.path]);
        }
      }

      try {
        await withTimeoutOrThrow(
          workspaceSetActive(id),
          { timeoutMs: WORKSPACE_SET_ACTIVE_TIMEOUT_MS, label: "workspace_set_active" },
        );
      } catch {
        // ignore
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
    if (!isRemote && options.client() && !wasLocalConnection) {
      if (isSuperseded()) {
        wsDebug("activate:superseded:before-remote-to-local", { id });
        return false;
      }
      wsDebug("activate:remote->local:reconnect", {
        id,
        nextPath: next.path,
        engine: engineStore.engine()?.baseUrl ?? null,
        engineRunning: Boolean(engineStore.engine()?.running),
      });
      options.setSelectedSessionId(null);
      options.setMessages([]);
      options.setTodos([]);
      options.setPendingPermissions([]);
      options.setSessionStatusById({});

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
          await activateOrchestratorWorkspace({
            workspacePath: next.path,
            name: next.displayName?.trim() || next.name?.trim() || null,
          });
          await activateVesloHostWorkspaceWithTimeout(
            () => activateVesloHostWorkspace(next.path),
          );

          const nextInfo = await withTimeoutOrThrow(
            engineInfo(),
            { timeoutMs: ENGINE_INFO_TIMEOUT_MS, label: "engine_info" },
          );
          engineStore.setEngine(nextInfo);

          const username = nextInfo.opencodeUsername?.trim() ?? "";
          const password = nextInfo.opencodePassword?.trim() ?? "";
          const auth = username && password ? { username, password } : undefined;
          engineStore.setEngineAuth(auth ?? null);

          if (nextInfo.baseUrl) {
            connectedToLocalHost = await connectToServer(
              nextInfo.baseUrl,
              next.path,
              {
                workspaceId: next.id,
                workspaceType: "local",
                targetRoot: next.path,
                reason: "workspace-attach-local",
              },
              auth,
              { navigate: false },
            );
          }
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
        const startHostAt = Date.now();
        const ok = await withTimeoutOrThrow(
          engineStore.startHost({ workspacePath: next.path, navigate: false }),
          { timeoutMs: START_HOST_TIMEOUT_MS, label: "startHost" },
        );
        wsDebug("activate:remote->local:startHost:done", { ok, ms: Date.now() - startHostAt });
        if (!ok) {
          updateWorkspaceConnectionState(id, {
            status: "error",
            message: "Failed to start local engine.",
          });
          return false;
        }
      }
    }

    // When running locally, restart the engine when workspace changes
    let engineRestartFailed = false;
    if (!isRemote && wasLocalConnection && workspaceChanged) {
      if (isSuperseded()) {
        wsDebug("activate:superseded:before-engine-restart", { id });
        return false;
      }
      wsDebug("activate:local->local:restartEngine", { id, nextPath: next.path });
      options.setError(null);
      options.setBusy(true);
      options.setBusyLabel("status.restarting_engine");
      options.setBusyStartedAt(Date.now());

      try {
        const runtime = resolveEngineRuntime();
        if (runtime === "veslo-orchestrator") {
          await activateOrchestratorWorkspace({
            workspacePath: next.path,
            name: next.displayName?.trim() || next.name?.trim() || null,
          });
          await activateVesloHostWorkspaceWithTimeout(
            () => activateVesloHostWorkspace(next.path),
          );

          const newInfo = await withTimeoutOrThrow(
            engineInfo(),
            { timeoutMs: ENGINE_INFO_TIMEOUT_MS, label: "engine_info" },
          );
          engineStore.setEngine(newInfo);

          const username = newInfo.opencodeUsername?.trim() ?? "";
          const password = newInfo.opencodePassword?.trim() ?? "";
          const auth = username && password ? { username, password } : undefined;
          engineStore.setEngineAuth(auth ?? null);

          if (newInfo.baseUrl) {
            const ok = await connectToServer(
              newInfo.baseUrl,
              next.path,
              {
                workspaceId: next.id,
                workspaceType: "local",
                targetRoot: next.path,
                reason: "workspace-orchestrator-switch",
              },
              auth,
              { navigate: false },
            );
            if (!ok) {
              engineRestartFailed = true;
              options.setError("Failed to reconnect after worker switch");
            }
          }
        } else {
          const { stopResult: info, startResult: newInfo } = await runWorkspaceEngineRestartWithTimeouts({
            stop: () => engineStop(),
            start: () =>
              engineStart(next.path, {
                preferSidecar: options.engineSource() === "sidecar",
                opencodeBinPath:
                  options.engineSource() === "custom" ? options.engineCustomBinPath?.().trim() || null : null,
                runtime,
                workspacePaths: resolveWorkspacePaths(),
              }),
          });
          engineStore.setEngine(info);
          engineStore.setEngine(newInfo);

          const username = newInfo.opencodeUsername?.trim() ?? "";
          const password = newInfo.opencodePassword?.trim() ?? "";
          const auth = username && password ? { username, password } : undefined;
          engineStore.setEngineAuth(auth ?? null);

          // Reconnect to server
          if (newInfo.baseUrl) {
            const ok = await connectToServer(
              newInfo.baseUrl,
              next.path,
              {
                workspaceId: next.id,
                workspaceType: "local",
                targetRoot: next.path,
                reason: "workspace-restart",
              },
              auth,
              { navigate: false },
            );
            if (!ok) {
              engineRestartFailed = true;
              options.setError("Failed to reconnect after worker switch");
            }
          }
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
        updateWorkspaceConnectionState(id, {
          status: "error",
          message: "Failed to switch worker",
        });
        wsDebug("activate:local:engineRestartFailed", { id, ms: Date.now() - activateStart });
        return false;
      }

      options.refreshSkills({ force: true }).catch(e => reportError(e, "workspace.refreshSkills"));
      options.refreshPlugins().catch(e => reportError(e, "workspace.refreshPlugins"));
      updateWorkspaceConnectionState(id, { status: "connected", message: null });
      wsDebug("activate:local:done", { id, ms: Date.now() - activateStart });
      return true;
    } finally {
      if (activateTimeoutId !== null) {
        clearTimeout(activateTimeoutId);
      }
      wsActivateGuard.exit(myVersion, setConnectingWorkspaceId);
      wsDebug("activate:finally", { id, ms: Date.now() - activateStart });
    }
  }

  async function connectToServer(
    nextBaseUrl: string,
    directory?: string,
    context?: {
      workspaceId?: string;
      workspaceType?: WorkspaceInfo["workspaceType"];
      targetRoot?: string;
      reason?: string;
    },
    auth?: OpencodeAuth,
    connectOptions?: { quiet?: boolean; navigate?: boolean },
  ) {
    const requestKey = connectRequestKey(nextBaseUrl, directory, context, auth, connectOptions);
    const existing = connectInFlightByKey.get(requestKey);
    if (existing) {
      wsDebug("connect:dedupe", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        reason: context?.reason ?? null,
        workspaceType: context?.workspaceType ?? null,
      });
      return existing;
    }

    const run = (async () => {
      console.log("[workspace] connect", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        workspaceType: context?.workspaceType ?? null,
      });
      const connectStart = Date.now();
      wsDebug("connect:start", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        reason: context?.reason ?? null,
        workspaceType: context?.workspaceType ?? null,
        targetRoot: context?.targetRoot ?? null,
        healthTimeoutMs: resolveConnectHealthTimeoutMs(context?.reason),
        quiet: connectOptions?.quiet ?? false,
        navigate: connectOptions?.navigate ?? true,
        authMode: auth && "mode" in auth ? (auth as any).mode : auth ? "basic" : "none",
      });
      const quiet = connectOptions?.quiet ?? false;
      const navigate = connectOptions?.navigate ?? true;
      options.setError(null);
      if (!quiet) {
        options.setBusy(true);
        options.setBusyLabel("status.connecting");
        options.setBusyStartedAt(Date.now());
      }
      options.setSseConnected(false);

      const connectMeta: OpencodeConnectStatus = {
        at: Date.now(),
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        reason: context?.reason ?? null,
        status: "connecting",
        error: null,
      };
      options.setOpencodeConnectStatus?.(connectMeta);

      const connectMetrics: NonNullable<OpencodeConnectStatus["metrics"]> = {};

      try {
        let resolvedDirectory = directory?.trim() ?? "";
        let nextClient = createClient(nextBaseUrl, resolvedDirectory || undefined, auth);
        const healthTimeoutMs = resolveConnectHealthTimeoutMs(context?.reason);
        const health = await waitForHealthy(nextClient, { timeoutMs: healthTimeoutMs });
        connectMetrics.healthyMs = Date.now() - connectStart;
        wsDebug("connect:healthy", {
          ms: Date.now() - connectStart,
          version: health.version,
          timeoutMs: healthTimeoutMs,
        });

        if (context?.workspaceType === "remote" && !resolvedDirectory) {
          try {
            const pathInfo = unwrap(await nextClient.path.get());
            const discovered = pathInfo.directory?.trim() ?? "";
            if (discovered) {
              resolvedDirectory = discovered;
              console.log("[workspace] remote directory resolved", resolvedDirectory);
              if (isTauriRuntime() && context.workspaceId) {
                const updated = await workspaceUpdateRemote({
                  workspaceId: context.workspaceId,
                  directory: resolvedDirectory,
                });
                setWorkspaces(updated.workspaces);
                syncActiveWorkspaceId(updated.activeId);
              }
              setProjectDir(resolvedDirectory);
              nextClient = createClient(nextBaseUrl, resolvedDirectory, auth);
            }
          } catch (error) {
            console.log("[workspace] remote directory lookup failed", error);
          }
        }

        options.setClient(nextClient);
        options.setConnectedVersion(health.version);
        options.setBaseUrl(nextBaseUrl);
        options.setClientDirectory(resolvedDirectory);

        const providersPromise = (async () => {
          const providersAt = Date.now();
          wsDebug("connect:providers:start", { baseUrl: nextBaseUrl });
          try {
            const providerList = unwrap(
              await withTimeoutOrThrow(
                nextClient.provider.list(),
                { timeoutMs: CONNECT_PROVIDER_LIST_TIMEOUT_MS, label: "provider.list" },
              ),
            );
            wsDebug("connect:providers:done", {
              ms: Date.now() - providersAt,
              source: "provider.list",
              available: providerList.all?.length ?? 0,
              connected: providerList.connected?.length ?? 0,
            });
            return {
              providers: providerList.all,
              defaults: providerList.default,
              connectedIds: providerList.connected,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : safeStringify(error);
            wsDebug("connect:providers:fallback", { ms: Date.now() - providersAt, message });
            try {
              const cfg = unwrap(
                await withTimeoutOrThrow(
                  nextClient.config.providers(),
                  { timeoutMs: CONNECT_PROVIDER_LIST_TIMEOUT_MS, label: "config.providers" },
                ),
              );
              const mapped = mapConfigProvidersToList(cfg.providers);
              wsDebug("connect:providers:done", {
                ms: Date.now() - providersAt,
                source: "config.providers",
                available: mapped.length,
                connected: 0,
              });
              return {
                providers: mapped,
                defaults: cfg.default,
                connectedIds: [],
              };
            } catch (fallbackError) {
              const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : safeStringify(fallbackError);
              wsDebug("connect:providers:error", { ms: Date.now() - providersAt, message: fallbackMessage });
              return {
                providers: [],
                defaults: {},
                connectedIds: [],
              };
            }
          } finally {
            connectMetrics.providersMs = Date.now() - providersAt;
          }
        })();

        const targetRoot = context?.targetRoot ?? (resolvedDirectory || activeWorkspaceRoot().trim());
        wsDebug("connect:loadSessions", { targetRoot, resolvedDirectory });
        const sessionsAt = Date.now();
        await withTimeoutOrThrow(
          options.loadSessions(targetRoot),
          { timeoutMs: CONNECT_LOAD_SESSIONS_TIMEOUT_MS, label: "loadSessions" },
        );
        connectMetrics.loadSessionsMs = Date.now() - sessionsAt;
        wsDebug("connect:loadSessions:done", { ms: Date.now() - sessionsAt });
        const pendingPermissionsAt = Date.now();
        await withTimeoutOrThrow(
          options.refreshPendingPermissions(),
          { timeoutMs: CONNECT_PENDING_PERMISSIONS_TIMEOUT_MS, label: "refreshPendingPermissions" },
        );
        connectMetrics.pendingPermissionsMs = Date.now() - pendingPermissionsAt;

        const providerState = await providersPromise;
        options.setProviders(providerState.providers);
        options.setProviderDefaults(providerState.defaults);
        options.setProviderConnectedIds(providerState.connectedIds);

        options.setSelectedSessionId(null);
        options.setMessages([]);
        options.setTodos([]);
        options.setPendingPermissions([]);
        options.setSessionStatusById({});

        options.refreshSkills({ force: true }).catch(e => reportError(e, "workspace.refreshSkills"));
        options.refreshPlugins().catch(e => reportError(e, "workspace.refreshPlugins"));
        if (navigate && !options.selectedSessionId()) {
          options.setTab("scheduled");
          options.setView("session");
        }

        // If the user successfully connected, treat onboarding as complete so we
        // don't force the onboarding flow on subsequent launches.
        markOnboardingComplete();
        options.onEngineStable?.();
        connectMetrics.totalMs = Date.now() - connectStart;
        options.setOpencodeConnectStatus?.({ ...connectMeta, status: "connected", metrics: connectMetrics });
        wsDebug("connect:done", { ok: true, ms: Date.now() - connectStart });
        return true;
      } catch (e) {
        options.setClient(null);
        options.setConnectedVersion(null);
        const message = e instanceof Error ? e.message : safeStringify(e);
        wsDebug("connect:error", { ms: Date.now() - connectStart, message });
        connectMetrics.totalMs = Date.now() - connectStart;
        options.setOpencodeConnectStatus?.({
          ...connectMeta,
          status: "error",
          error: addOpencodeCacheHint(message),
          metrics: connectMetrics,
        });
        if (!quiet) {
          options.setError(addOpencodeCacheHint(message));
        }
        return false;
      } finally {
        if (!quiet) {
          options.setBusy(false);
          options.setBusyLabel(null);
          options.setBusyStartedAt(null);
        }
      }
    })();

    connectInFlightByKey.set(requestKey, run);
    try {
      return await run;
    } finally {
      if (connectInFlightByKey.get(requestKey) === run) {
        connectInFlightByKey.delete(requestKey);
      }
    }
  }

  const openEmptySession = async (scopeRoot?: string) => {
    const root = (scopeRoot ?? activeWorkspaceRoot().trim()).trim();
    if (options.client()) {
      try {
        await options.loadSessions(root || undefined);
      } catch {
        // If session loading fails, still fall back to an empty session draft view.
      }
    }
    options.setSelectedSessionId(null);
    options.setMessages([]);
    options.setTodos([]);
    options.setPendingPermissions([]);
    options.setSessionStatusById({});
    options.setView("session");
  };

  const activateFreshLocalWorkspace = async (workspaceId: string | null, workspacePath: string) => {
    if (!workspaceId) {
      await openEmptySession(workspacePath);
      return true;
    }
    const hasClient = Boolean(options.client());
    const ok = hasClient
      ? await activateWorkspace(workspaceId)
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
    remoteStoreRef.clearSandboxCreateProgress();

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
      if (active) {
        setProjectDir(active.path);
        setAuthorizedDirs([active.path]);
      }

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
    if (existing) return existing;

    return await createLocalWorkspace("starter", resolvedFolder, {
      markOnboardingComplete: true,
      navigateToDashboard: false,
      closeModal: false,
    });
  }

  const isPrivateWorkspacePath = (folder: string | null | undefined) => {
    const root = normalizeDirectoryPath(privateWorkspaceRoot());
    const value = normalizeDirectoryPath(folder ?? "");
    if (!root || !value) return false;
    return value === root || value.startsWith(`${root}/`);
  };

  async function ensureLocalWorkspaceActive(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return false;
    const activated = await activateWorkspace(id);
    if (activated === false) return false;
    if (options.client()) return true;

    const workspace = workspaces().find((entry) => entry.id === id) ?? null;
    if (!workspace || workspace.workspaceType !== "local") {
      options.setError("Local workspace is not available.");
      return false;
    }

    const started = await engineStore.startHost({ workspacePath: workspace.path, navigate: false });
    if (!started) return false;
    return Boolean(options.client());
  }

  async function forgetWorkspace(workspaceId: string) {
    if (!isTauriRuntime()) {
      options.setError(t("app.error.tauri_required", currentLocale()));
      return;
    }

    const id = workspaceId.trim();
    if (!id) return;

    console.log("[workspace] forget", { id });

    try {
      const previousActive = activeWorkspaceId();
      const ws = await workspaceForget(id);
      setWorkspaces(ws.workspaces);
      clearWorkspaceConnectionState(id);
      syncActiveWorkspaceId(ws.activeId);

      const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
      if (active) {
        setProjectDir(active.workspaceType === "remote" ? active.directory?.trim() ?? "" : active.path);
      }

      if (ws.activeId && ws.activeId !== previousActive) {
        await activateWorkspace(ws.activeId);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      options.setError(addOpencodeCacheHint(message));
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
      window.localStorage.setItem("veslo.onboardingComplete", "1");
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

  const resolveWelcomeOnboardingStep = (): OnboardingStep =>
    hasPersistedLanguagePreference() ? "welcome" : "language";

  const engineStore = createEngineStore({
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
    engineStore: {
      refreshSandboxDoctor: engineStore.refreshSandboxDoctor,
    },
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
  remoteStoreRef.clearSandboxCreateProgress = remoteStore.clearSandboxCreateProgress;

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

  async function bootstrapOnboarding() {
    bootTrace("bootstrapOnboarding START");
    const startupPref = readStartupPreference();
    const onboardingComplete = (() => {
      try {
        return window.localStorage.getItem("veslo.onboardingComplete") === "1";
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
      }
    }

    bootTrace("refreshEngine...");
    await withTimeout(engineStore.refreshEngine(), 10_000, "refreshEngine");
    bootTrace("refreshEngine DONE");
    bootTrace("refreshEngineDoctor...");
    await withTimeout(engineStore.refreshEngineDoctor(), 10_000, "refreshEngineDoctor");
    bootTrace("refreshEngineDoctor DONE");

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

    bootTrace("language check...", "hasPersistedLanguage=", hasPersistedLanguagePreference());
    if (!hasPersistedLanguagePreference()) {
      bootTrace("→ setOnboardingStep('language') and RETURN");
      options.setOnboardingStep("language");
      return;
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
    // Validate stored auth with Den server before allowing app use.
    bootTrace("validateDenAuth...");
    const authValid = await validateDenAuth(denAuth);
    bootTrace("validateDenAuth DONE, valid=", authValid);
    if (!authValid) {
      clearDenAuth();
      bootTrace("→ auth invalid, setOnboardingStep('auth') and RETURN");
      options.setOnboardingStep("auth");
      return;
    }

    if (CLOUD_ONLY_MODE) {
      options.setStartupPreference("server");
      const settings = options.vesloServerSettings();
      const cloudHostUrl = normalizeVesloServerUrl(settings.urlOverride ?? "") ?? "";
      const cloudToken = settings.token?.trim() ?? "";
      const cloudDirectory = options.clientDirectory().trim() ? options.clientDirectory().trim() : null;
      const normalizedCloudHost = normalizeVesloServerUrl(cloudHostUrl) ?? "";

      const activeRemoteWorkspace = activeWorkspaceInfo()?.workspaceType === "remote"
        ? activeWorkspaceInfo()
        : null;
      const cloudMatchedRemoteWorkspace = normalizedCloudHost
        ? workspaces().find((workspace) => {
            if (workspace.workspaceType !== "remote") return false;
            const workspaceHost = normalizeVesloServerUrl(
              workspace.vesloHostUrl ?? workspace.baseUrl ?? workspace.path ?? "",
            );
            return Boolean(workspaceHost && workspaceHost === normalizedCloudHost);
          }) ?? null
        : null;
      const preferredRemoteWorkspace = cloudMatchedRemoteWorkspace ?? activeRemoteWorkspace;

      if (preferredRemoteWorkspace?.workspaceType === "remote") {
        options.setOnboardingStep("connecting");
        const ok = await activateWorkspace(preferredRemoteWorkspace.id);
        if (ok) {
          return;
        }

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

      if (cloudHostUrl) {
        options.setOnboardingStep("connecting");
        const ok = await remoteStoreRef.createRemoteWorkspaceFlow({
          vesloHostUrl: cloudHostUrl,
          vesloToken: cloudToken || null,
          directory: cloudDirectory,
          displayName: null,
        });
        if (ok) {
          return;
        }
      }

      options.setOnboardingStep("server");
      return;
    }

    bootTrace("activeWorkspace type=", activeWorkspace?.workspaceType, "CLOUD_ONLY=", CLOUD_ONLY_MODE);
    if (activeWorkspace?.workspaceType === "remote") {
      bootTrace("remote workspace → activateWorkspace...");
      options.setStartupPreference("server");
      options.setOnboardingStep("connecting");
      const ok = await activateWorkspace(activeWorkspace.id);
      bootTrace("activateWorkspace ok=", ok);
      if (!ok) {
        options.setOnboardingStep("server");
      }
      return;
    }

    if (startupPref) {
      options.setStartupPreference(startupPref);
    }

    if (startupPref === "server") {
      bootTrace("→ setOnboardingStep('server') and RETURN");
      options.setOnboardingStep("server");
      return;
    }

    bootTrace("activeWorkspacePath=", activeWorkspacePath().trim() || "(empty)");
    if (activeWorkspacePath().trim()) {
      options.setStartupPreference("local");

      if (info?.running && info.baseUrl) {
        bootTrace("engine running, connectToServer...");
        options.setOnboardingStep("connecting");
        const ok = await connectToServer(
          info.baseUrl,
          (activeWorkspacePath().trim() || info.projectDir || undefined),
          {
            workspaceId: activeWorkspace?.id || undefined,
            workspaceType: "local",
            targetRoot: activeWorkspacePath().trim() || undefined,
            reason: "bootstrap-local",
          },
          engineStore.engineAuth() ?? undefined,
        );
        bootTrace("connectToServer ok=", ok);
        if (!ok) {
          options.setStartupPreference(null);
          options.setOnboardingStep(resolveWelcomeOnboardingStep());
          return;
        }
        markOnboardingComplete();
        return;
      }

      bootTrace("startHost...");
      options.setOnboardingStep("connecting");
      const ok = await engineStore.startHost({ workspacePath: activeWorkspacePath().trim() });
      bootTrace("startHost ok=", ok);
      if (!ok) {
        options.setOnboardingStep("local");
        return;
      }
      markOnboardingComplete();
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
      engineAuth() ?? undefined,
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

  return {
    engine: engineStore.engine,
    engineDoctorResult: engineStore.engineDoctorResult,
    engineDoctorCheckedAt: engineStore.engineDoctorCheckedAt,
    engineInstallLogs: engineStore.engineInstallLogs,
    sandboxDoctorResult: engineStore.sandboxDoctorResult,
    sandboxDoctorCheckedAt: engineStore.sandboxDoctorCheckedAt,
    sandboxDoctorBusy: engineStore.sandboxDoctorBusy,
    sandboxPreflightBusy: remoteStore.sandboxPreflightBusy,
    sandboxCreatePhase: remoteStore.sandboxCreatePhase,
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
    testWorkspaceConnection,
    connectToServer,
    createWorkspaceFlow,
    createScratchWorkspace,
    createSandboxFlow: remoteStore.createSandboxFlow,
    createRemoteWorkspaceFlow: remoteStore.createRemoteWorkspaceFlow,
    updateRemoteWorkspaceFlow: remoteStore.updateRemoteWorkspaceFlow,
    updateWorkspaceDisplayName,
    ensureLocalWorkspaceActive,
    ensureWorkspaceForFolder,
    forgetWorkspace,
    recoverWorkspace: remoteStore.recoverWorkspace,
    stopSandbox: remoteStore.stopSandbox,
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
    refreshSandboxDoctor: engineStore.refreshSandboxDoctor,
    sandboxCreateProgress: remoteStore.sandboxCreateProgress,
    clearSandboxCreateProgress: remoteStore.clearSandboxCreateProgress,
    workspaceDebugEvents,
    clearWorkspaceDebugEvents,
    isPrivateWorkspacePath,
  };
}
