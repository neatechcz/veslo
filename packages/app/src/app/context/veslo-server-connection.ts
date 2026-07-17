import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import {
  listen,
  type Event as TauriEvent,
  type UnlistenFn,
} from "@tauri-apps/api/event";

import {
  createInitialVesloServerStatusStabilityState,
  applyVesloServerStatusProbe,
} from "../lib/veslo-server/status-stability";
import {
  createVesloServerClient,
  normalizeVesloServerUrl,
  readVesloServerSettings,
  resolveSessionArchiveClientOptions,
  writeVesloServerSettings,
  clearVesloServerSettings,
  resolveVesloServerAuthFailureStatus,
  type VesloServerCapabilities,
  type VesloServerClient,
  type VesloServerConnectionSnapshot,
  type VesloServerDiagnostics,
  type VesloServerReachability,
  type VesloRuntimeReadiness,
  type VesloServerSettings,
  type VesloServerStatus,
} from "../lib/veslo-server";
import { resolveManagedAiGatewayBaseUrl } from "../lib/ai-access";
import { tryRecordBootstrapDiagnostic } from "../lib/bootstrap-diagnostics";
import { recordPerfLog, runtimePerfAuditEnabled } from "../lib/perf-log";
import { truncateErrorField } from "../lib/session-error";
import { resolveRunningVesloServerHostInfo } from "../lib/veslo-server-host";
import {
  vesloServerInfo as defaultVesloServerInfo,
  vesloServerRestart as defaultVesloServerRestart,
  opencodeRouterInfo as defaultOpenCodeRouterInfo,
  orchestratorEnginesList as defaultOrchestratorEnginesList,
  orchestratorStatus as defaultOrchestratorStatus,
  VESLO_SERVER_STATE_EVENT,
  type OpenCodeRouterInfo,
  type OrchestratorEngineSnapshot,
  type OrchestratorStatus,
  type VesloServerInfo,
} from "../lib/tauri";
import { safeStringify } from "../utils";
import type { StartupPreference } from "../types";

function isReachableVesloServerStatus(status: VesloServerStatus) {
  return status === "connected" || status === "limited";
}

function isAuthenticatedVesloServerStatus(status: VesloServerStatus) {
  return status === "connected";
}

export type VesloServerConnectionHostInfo = {
  baseUrl?: string | null;
  connectUrl?: string | null;
  lanUrl?: string | null;
  mdnsUrl?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
};

export type VesloServerConnectionClientFactoryInput = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
};

export type VesloServerConnectionClient = {
  baseUrl: string;
  health: () => Promise<unknown>;
  capabilities: () => Promise<VesloServerCapabilities>;
  status?: () => Promise<VesloServerDiagnostics>;
};

export type VesloServerConnectionClientFactory = (
  input: VesloServerConnectionClientFactoryInput,
) => VesloServerConnectionClient & Partial<VesloServerClient>;

export type VesloServerConnectionWorkspaceDeps = {
  workspacesHydrated: Accessor<boolean>;
  activeWorkspaceDisplay: Accessor<{
    workspaceType: string;
    remoteType?: string | null;
  }>;
  activeWorkspaceId: Accessor<string>;
  activeWorkspaceRoot: Accessor<string>;
  createRemoteWorkspaceFlow?: (input: {
    vesloHostUrl: string;
    vesloToken?: string | null;
  }) => Promise<unknown>;
  refreshEngine?: () => Promise<void>;
};

export type VesloServerConnectionDeps = {
  startupPreference: Accessor<StartupPreference | null>;
  opencodeBaseUrl: Accessor<string>;
  authenticatedAccountId: Accessor<string | null>;
  cloudEnvironment: {
    vesloUrl?: string | null;
    token?: string | null;
  };
  documentVisible: Accessor<boolean>;
  developerMode: Accessor<boolean>;
  isTauriRuntime: Accessor<boolean>;
  workspace?: VesloServerConnectionWorkspaceDeps;
  routedClient?: Accessor<unknown>;
  reportError?: (error: unknown, context: string) => void;
  setError?: (message: string | null) => void;
  addOpencodeCacheHint?: (message: string) => string;
  createClient?: VesloServerConnectionClientFactory;
  vesloServerInfo?: () => Promise<VesloServerInfo | null>;
  vesloServerRestart?: () => Promise<VesloServerInfo | null>;
  vesloServerStateListen?: (
    handler: (info: VesloServerInfo) => void,
  ) => Promise<UnlistenFn>;
  opencodeRouterInfo?: () => Promise<OpenCodeRouterInfo | null>;
  orchestratorStatus?: () => Promise<OrchestratorStatus | null>;
  orchestratorEnginesList?: () => Promise<OrchestratorEngineSnapshot[]>;
  localEnsureTimeoutMs?: number;
  now?: () => number;
};

export type VesloServerAuth = {
  token?: string;
  hostToken?: string;
};

export type CheckVesloServerOptions = {
  requireRuntimeChainReady?: boolean;
};

export type EnsureLocalVesloServerRunningOptions = {
  ignoreStartupPreference?: boolean;
  requireRuntimeChainReady?: boolean;
};

export type VesloServerProbeResult = {
  status: VesloServerStatus;
  capabilities: VesloServerCapabilities | null;
  runtimeReadiness?: VesloRuntimeReadiness;
  failureReason?: string;
};

export type ResolveVesloServerBaseUrlInput = {
  startupPreference: StartupPreference | null;
  activeHostInfo: VesloServerConnectionHostInfo | null;
  settingsUrl: string;
};

export type ResolveVesloServerAuthInput = {
  startupPreference: StartupPreference | null;
  activeHostInfo: VesloServerConnectionHostInfo | null;
  settingsToken: string;
};

export type VesloServerConnection = ReturnType<
  typeof createVesloServerConnection
>;

const DEFAULT_LOCAL_VESLO_SERVER_ENSURE_TIMEOUT_MS = 15_000;

function stateKey(value: unknown): string {
  return safeStringify(value ?? null);
}

function summarizeConnectionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : safeStringify(error);
  return truncateErrorField(message, 240) ?? "Unknown connection failure";
}

function runtimeChainTraceDetails(
  diagnostics: VesloServerDiagnostics | null | undefined,
) {
  const runtimeChain = diagnostics?.runtimeChain;
  return {
    runtimeChainStatus: runtimeChain?.status ?? null,
    orchestratorConfigured: runtimeChain?.orchestrator.configured ?? null,
    orchestratorOk: runtimeChain?.orchestrator.ok ?? null,
    orchestratorError: truncateErrorField(
      runtimeChain?.orchestrator.error,
      240,
    ),
    sharedEngineRunning: runtimeChain?.sharedEngine.running ?? null,
    sharedEnginePending: runtimeChain?.sharedEngine.pending ?? null,
    sharedEngineState: runtimeChain?.sharedEngine.engineState ?? null,
    proxyOk: runtimeChain?.proxy.ok ?? null,
    proxyStatus: runtimeChain?.proxy.status ?? null,
    proxyError: truncateErrorField(runtimeChain?.proxy.error, 240),
  };
}

type VesloConnectionTraceState = {
  serverStatus: VesloServerStatus;
  snapshot: VesloServerConnectionSnapshot;
  failureReason: string | null;
  runtimeChain: ReturnType<typeof runtimeChainTraceDetails>;
};

function defaultCreateClient(input: VesloServerConnectionClientFactoryInput) {
  return createVesloServerClient(input) as VesloServerConnectionClient &
    VesloServerClient;
}

function defaultListenVesloServerState(
  handler: (info: VesloServerInfo) => void,
) {
  return listen<VesloServerInfo>(
    VESLO_SERVER_STATE_EVENT,
    (event: TauriEvent<VesloServerInfo>) => {
      handler(event.payload);
    },
  );
}

export function mergeVesloServerDescriptorEvent(
  current: VesloServerInfo | null,
  next: VesloServerInfo | null,
): VesloServerInfo | null {
  if (!next) return null;
  if (!current) return next;

  const sameInstance =
    Boolean(current.instanceId?.trim()) &&
    Boolean(next.instanceId?.trim()) &&
    current.instanceId?.trim() === next.instanceId?.trim();
  if (!sameInstance) return next;

  return {
    ...next,
    hostToken: next.hostToken?.trim() ? next.hostToken : current.hostToken,
    lastStdout: next.lastStdout ?? current.lastStdout,
    lastStderr: next.lastStderr ?? current.lastStderr,
  };
}

function requiresLocalRuntimeChainReadiness(input: {
  isTauriRuntime: boolean;
  startupPreference: StartupPreference | null;
  activeWorkspaceType?: string | null;
  url: string;
}): boolean {
  return Boolean(
    input.isTauriRuntime &&
    input.startupPreference !== "server" &&
    input.activeWorkspaceType === "local" &&
    isLoopbackVesloServerConnectionUrl(input.url),
  );
}

export function resolveVesloServerReachability(
  status: VesloServerStatus,
): VesloServerReachability {
  switch (status) {
    case "connected":
      return "reachable";
    case "limited":
      return "limited";
    case "auth_desync":
      return "auth_desync";
    default:
      return "unreachable";
  }
}

export function resolveVesloRuntimeReadiness(input: {
  localRuntimeContract: boolean;
  diagnostics: VesloServerDiagnostics | null | undefined;
}): VesloRuntimeReadiness {
  if (!input.localRuntimeContract) return "not-applicable";

  const runtimeChain = input.diagnostics?.runtimeChain;
  if (!runtimeChain) return "unavailable";

  switch (runtimeChain.status) {
    case "runtime_chain_ready":
      return "ready";
    case "server_running":
      return "starting";
    case "shared_engine_unhealthy":
      return runtimeChain.sharedEngine.pending === true
        ? "starting"
        : "degraded";
    case "orchestrator_unavailable":
      return "unavailable";
    case "proxy_unreachable":
      return "degraded";
  }

  return "unavailable";
}

function activeWorkspaceRuntimeStatus(
  client: VesloServerConnectionClient & Partial<VesloServerClient>,
  workspaceId: string | null | undefined,
) {
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  if (normalizedWorkspaceId && client.workspace?.statusForWorkspace) {
    return client.workspace.statusForWorkspace(normalizedWorkspaceId);
  }
  return client.status?.() ?? Promise.resolve(null);
}

export function isLoopbackVesloServerConnectionUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.trim().toLowerCase();
    return (
      hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function resolveVesloServerBaseUrl(
  input: ResolveVesloServerBaseUrlInput,
): string {
  const pref = input.startupPreference;
  const hostInfo = input.activeHostInfo;
  const settingsUrl = input.settingsUrl.trim();
  const preferredLocalUrl = hostInfo?.baseUrl?.trim() ?? "";

  if (pref === "local") return preferredLocalUrl;
  if (pref === "server") return settingsUrl;
  return preferredLocalUrl || settingsUrl;
}

export function resolveVesloServerAuth(
  input: ResolveVesloServerAuthInput,
): VesloServerAuth {
  const pref = input.startupPreference;
  const hostInfo = input.activeHostInfo;
  const settingsToken = input.settingsToken.trim();
  const clientToken = hostInfo?.clientToken?.trim() ?? "";
  const hostToken = hostInfo?.hostToken?.trim() ?? "";

  if (pref === "local") {
    return {
      token: clientToken || undefined,
      hostToken: hostToken || undefined,
    };
  }
  if (pref === "server") {
    return { token: settingsToken || undefined, hostToken: undefined };
  }
  if (hostInfo?.baseUrl) {
    return {
      token: clientToken || undefined,
      hostToken: hostToken || undefined,
    };
  }
  return { token: settingsToken || undefined, hostToken: undefined };
}

export function createVesloServerConnection(deps: VesloServerConnectionDeps) {
  const now = deps.now ?? (() => Date.now());
  const createClient = deps.createClient ?? defaultCreateClient;
  const localEnsureTimeoutMs = Math.max(
    1,
    deps.localEnsureTimeoutMs ?? DEFAULT_LOCAL_VESLO_SERVER_ENSURE_TIMEOUT_MS,
  );
  const loadVesloServerInfo = deps.vesloServerInfo ?? defaultVesloServerInfo;
  const restartVesloServer =
    deps.vesloServerRestart ?? defaultVesloServerRestart;
  const listenVesloServerState =
    deps.vesloServerStateListen ?? defaultListenVesloServerState;
  const loadOpenCodeRouterInfo =
    deps.opencodeRouterInfo ?? defaultOpenCodeRouterInfo;
  const loadOrchestratorStatus =
    deps.orchestratorStatus ?? defaultOrchestratorStatus;
  const loadOrchestratorEngines =
    deps.orchestratorEnginesList ?? defaultOrchestratorEnginesList;

  const [vesloServerSettings, setVesloServerSettings] =
    createSignal<VesloServerSettings>({});
  const [vesloServerUrl, setVesloServerUrl] = createSignal("");
  const [vesloServerStatus, setVesloServerStatus] =
    createSignal<VesloServerStatus>("disconnected");
  const [vesloRuntimeReadiness, setVesloRuntimeReadiness] =
    createSignal<VesloRuntimeReadiness>("unknown");
  const [vesloServerCapabilities, setVesloServerCapabilities] =
    createSignal<VesloServerCapabilities | null>(null);
  const [vesloServerCheckedAt, setVesloServerCheckedAt] = createSignal<
    number | null
  >(null);
  const [vesloServerWorkspaceId, setVesloServerWorkspaceId] = createSignal<
    string | null
  >(null);
  const [vesloServerHostInfo, setVesloServerHostInfo] =
    createSignal<VesloServerInfo | null>(null);
  const [vesloServerDiagnostics, setVesloServerDiagnostics] =
    createSignal<VesloServerDiagnostics | null>(null);
  const [vesloReconnectBusy, setVesloReconnectBusy] = createSignal(false);
  const [opencodeRouterInfoState, setOpenCodeRouterInfoState] =
    createSignal<OpenCodeRouterInfo | null>(null);
  const [orchestratorStatusState, setOrchestratorStatusState] =
    createSignal<OrchestratorStatus | null>(null);
  const [orchestratorEnginesState, setOrchestratorEnginesState] = createSignal<
    OrchestratorEngineSnapshot[]
  >([]);
  const [devtoolsWorkspaceId, setDevtoolsWorkspaceId] = createSignal<
    string | null
  >(null);
  let vesloServerLastReachableAt = 0;
  const ensureLocalVesloServerRunningInFlight = new Map<
    string,
    Promise<boolean>
  >();
  let lastLocalVesloEnsureKey = "";
  let desktopBootstrapReadyRecorded = false;
  let desktopBootstrapReadyRecording = false;

  const recordDesktopBootstrapReady = async (): Promise<boolean> => {
    if (
      desktopBootstrapReadyRecorded ||
      desktopBootstrapReadyRecording ||
      !deps.isTauriRuntime()
    ) {
      return false;
    }
    if (vesloServerStatus() !== "connected" || vesloRuntimeReadiness() !== "ready") {
      return false;
    }

    desktopBootstrapReadyRecording = true;
    try {
      const recorded = await tryRecordBootstrapDiagnostic("desktop-bootstrap:ready", {
        serverStatus: vesloServerStatus(),
        runtimeReadiness: vesloRuntimeReadiness(),
        workspaceType: deps.workspace?.activeWorkspaceDisplay().workspaceType ?? null,
      });
      if (recorded) desktopBootstrapReadyRecorded = true;
      return recorded;
    } finally {
      desktopBootstrapReadyRecording = false;
    }
  };

  const markVesloServerReachable = (status: VesloServerStatus, at = now()) => {
    if (isReachableVesloServerStatus(status)) {
      vesloServerLastReachableAt = at;
    }
  };

  const vesloServerRecentlyReachable = (at = now()) =>
    vesloServerLastReachableAt > 0 && at - vesloServerLastReachableAt <= 30_000;

  const vesloServerConnectionSnapshot = (): VesloServerConnectionSnapshot => ({
    serverReachability: resolveVesloServerReachability(vesloServerStatus()),
    runtimeReadiness: vesloRuntimeReadiness(),
  });

  let lastConnectionTraceState: VesloConnectionTraceState | null = null;
  const runtimeConnectionTraceEnabled = () =>
    deps.developerMode() || runtimePerfAuditEnabled();

  const recordConnectionStateTransition = (
    result: VesloServerProbeResult,
    source: string,
  ) => {
    const next: VesloConnectionTraceState = {
      serverStatus: result.status,
      snapshot: vesloServerConnectionSnapshot(),
      failureReason: result.failureReason ?? null,
      runtimeChain: runtimeChainTraceDetails(
        isReachableVesloServerStatus(result.status)
          ? vesloServerDiagnostics()
          : null,
      ),
    };
    if (stateKey(next) === stateKey(lastConnectionTraceState)) return;

    const previous = lastConnectionTraceState;
    lastConnectionTraceState = next;
    recordPerfLog(
      runtimeConnectionTraceEnabled(),
      "workspace.requests",
      "veslo-connection-state",
      {
        source,
        activeWorkspaceId: deps.workspace?.activeWorkspaceId().trim() || null,
        previousServerStatus: previous?.serverStatus ?? null,
        previousReachability: previous?.snapshot.serverReachability ?? null,
        previousRuntimeReadiness: previous?.snapshot.runtimeReadiness ?? null,
        previousRuntimeChainStatus:
          previous?.runtimeChain.runtimeChainStatus ?? null,
        serverStatus: next.serverStatus,
        serverReachability: next.snapshot.serverReachability,
        runtimeReadiness: next.snapshot.runtimeReadiness,
        failureReason: next.failureReason,
        ...next.runtimeChain,
      },
    );
  };

  const recordLocalEnsureOutcome = (input: {
    outcome:
      | "ready"
      | "runtime-not-ready"
      | "server-unreachable"
      | "restart-missing-info"
      | "deadline-exceeded"
      | "ensure-failed"
      | "skipped-startup-preference"
      | "skipped-nonlocal-workspace";
    requireRuntimeChainReady: boolean;
    restartAttempted: boolean;
  }) => {
    const snapshot = vesloServerConnectionSnapshot();
    recordPerfLog(
      runtimeConnectionTraceEnabled(),
      "workspace.requests",
      "veslo-local-server-ensure",
      {
        ...input,
        activeWorkspaceId: deps.workspace?.activeWorkspaceId().trim() || null,
        serverReachability: snapshot.serverReachability,
        runtimeReadiness: snapshot.runtimeReadiness,
        runtimeChainStatus: isReachableVesloServerStatus(vesloServerStatus())
          ? (vesloServerDiagnostics()?.runtimeChain?.status ?? null)
          : null,
      },
    );
  };

  const setVesloServerCapabilitiesStable = (
    next: VesloServerCapabilities | null,
  ) => {
    const nextKey = stateKey(next);
    setVesloServerCapabilities((current) =>
      stateKey(current) === nextKey ? current : next,
    );
  };

  const setVesloServerHostInfoStable = (next: VesloServerInfo | null) => {
    const nextKey = stateKey(next);
    setVesloServerHostInfo((current) =>
      stateKey(current) === nextKey ? current : next,
    );
  };

  const setVesloServerHostInfoFromEvent = (next: VesloServerInfo | null) => {
    setVesloServerHostInfoStable(
      mergeVesloServerDescriptorEvent(vesloServerHostInfo(), next),
    );
  };

  const activeVesloServerHostInfo = createMemo(() =>
    resolveRunningVesloServerHostInfo(vesloServerHostInfo()),
  );

  const activeVesloServerRoutingInfo = createMemo(
    () => {
      const hostInfo = activeVesloServerHostInfo();
      if (!hostInfo) return null;
      return {
        baseUrl: hostInfo.baseUrl?.trim() ?? "",
        engineUrl: hostInfo.engineUrl?.trim() ?? "",
        clientToken: hostInfo.clientToken?.trim() ?? "",
        hostToken: hostInfo.hostToken?.trim() ?? "",
      };
    },
    undefined,
    {
      equals: (prev, next) =>
        (prev?.baseUrl ?? "") === (next?.baseUrl ?? "") &&
        (prev?.engineUrl ?? "") === (next?.engineUrl ?? "") &&
        (prev?.clientToken ?? "") === (next?.clientToken ?? "") &&
        (prev?.hostToken ?? "") === (next?.hostToken ?? ""),
    },
  );

  const readyEngineWorkspaceIds = createMemo(() => {
    const set = new Set<string>();
    for (const engine of orchestratorEnginesState()) {
      if (engine.state === "ready" || engine.state === "idle")
        set.add(engine.workspaceId);
    }
    return set;
  });

  const vesloServerBaseUrl = createMemo(() =>
    resolveVesloServerBaseUrl({
      startupPreference: deps.startupPreference(),
      activeHostInfo: activeVesloServerHostInfo(),
      settingsUrl:
        normalizeVesloServerUrl(vesloServerSettings().urlOverride ?? "") ?? "",
    }),
  );

  const vesloServerAuth = createMemo(
    () =>
      resolveVesloServerAuth({
        startupPreference: deps.startupPreference(),
        activeHostInfo: activeVesloServerHostInfo(),
        settingsToken: vesloServerSettings().token?.trim() ?? "",
      }),
    undefined,
    {
      equals: (prev, next) =>
        prev?.token === next.token && prev?.hostToken === next.hostToken,
    },
  );

  const vesloServerClient = createMemo<VesloServerClient | null>(() => {
    const baseUrl = vesloServerBaseUrl().trim();
    if (!baseUrl) return null;
    const auth = vesloServerAuth();
    return createClient({
      baseUrl,
      token: auth.token,
      hostToken: auth.hostToken,
    }) as VesloServerClient;
  });

  const vesloArchiveClientOptions = createMemo(() => {
    const auth = vesloServerAuth();
    return resolveSessionArchiveClientOptions({
      accountId: deps.authenticatedAccountId(),
      activeBaseUrl: vesloServerBaseUrl(),
      activeToken: auth.token,
      settingsUrl: vesloServerSettings().urlOverride,
      settingsToken: vesloServerSettings().token,
      cloudUrl: deps.cloudEnvironment.vesloUrl,
      cloudToken: deps.cloudEnvironment.token,
    });
  });

  const sessionArchiveOwnerKey = createMemo(
    () => vesloArchiveClientOptions()?.accountId ?? "",
  );

  const vesloArchiveClient = createMemo<VesloServerClient | null>(() => {
    const resolved = vesloArchiveClientOptions();
    if (!resolved) return null;
    return createClient(resolved) as VesloServerClient;
  });

  const gatewayVesloServerClient = createMemo<VesloServerClient | null>(() => {
    const active = vesloServerClient();
    const activeBaseUrl = active?.baseUrl?.trim() ?? "";
    const settings = vesloServerSettings();
    const remoteUrl = normalizeVesloServerUrl(settings.urlOverride ?? "") ?? "";
    const remoteToken = settings.token?.trim() ?? "";

    if (!remoteUrl || !remoteToken) {
      return active;
    }

    if (
      isLoopbackVesloServerConnectionUrl(activeBaseUrl) &&
      !isLoopbackVesloServerConnectionUrl(remoteUrl)
    ) {
      return createClient({
        baseUrl: remoteUrl,
        token: remoteToken,
      }) as VesloServerClient;
    }

    return active;
  });

  const managedAiGatewayBaseUrl = createMemo(() => {
    const settings = vesloServerSettings();
    return resolveManagedAiGatewayBaseUrl({
      settingsUrl: normalizeVesloServerUrl(settings.urlOverride ?? "") ?? "",
      gatewayClientBaseUrl: gatewayVesloServerClient()?.baseUrl?.trim() ?? "",
      localFallbackBaseUrl: "",
      isDesktopRuntime: deps.isTauriRuntime(),
    });
  });

  const devtoolsVesloClient = createMemo(() => vesloServerClient());

  const updateVesloServerSettings = (next: VesloServerSettings) => {
    const stored = writeVesloServerSettings(next);
    setVesloServerSettings(stored);
  };

  const resetVesloServerSettings = () => {
    clearVesloServerSettings();
    setVesloServerSettings({});
  };

  const checkVesloServer = async (
    url: string,
    token?: string,
    hostToken?: string,
    options?: CheckVesloServerOptions,
  ): Promise<VesloServerProbeResult> => {
    const client = createClient({ baseUrl: url, token, hostToken });
    const localRuntimeContract = requiresLocalRuntimeChainReadiness({
      isTauriRuntime: deps.isTauriRuntime(),
      startupPreference: deps.startupPreference(),
      activeWorkspaceType:
        deps.workspace?.activeWorkspaceDisplay().workspaceType,
      url,
    });
    const requireRuntimeChainReady =
      options?.requireRuntimeChainReady !== false && localRuntimeContract;
    try {
      await client.health();
    } catch (error) {
      const authStatus = resolveVesloServerAuthFailureStatus(error, {
        token,
        hostToken,
      });
      if (authStatus) {
        const result: VesloServerProbeResult = {
          status: authStatus,
          capabilities: null,
          runtimeReadiness: "unknown",
        };
        markVesloServerReachable(result.status);
        return result;
      }
      return {
        status: "disconnected" as VesloServerStatus,
        capabilities: null,
        runtimeReadiness: "unknown" as VesloRuntimeReadiness,
        failureReason: summarizeConnectionFailure(error),
      };
    }
    markVesloServerReachable("limited");

    if (!token) {
      return {
        status: "limited" as VesloServerStatus,
        capabilities: null,
        runtimeReadiness: localRuntimeContract ? "unknown" : "not-applicable",
      };
    }

    try {
      const caps = await client.capabilities();
      if (requireRuntimeChainReady) {
        let diagnostics: VesloServerDiagnostics | null = null;
        let failureReason: string | undefined;
        try {
          diagnostics = await activeWorkspaceRuntimeStatus(
            client,
            deps.workspace?.activeWorkspaceId(),
          );
        } catch (error) {
          failureReason = summarizeConnectionFailure(error);
        }
        setVesloServerDiagnostics(diagnostics ?? null);
        return {
          status: "connected" as VesloServerStatus,
          capabilities: caps,
          runtimeReadiness: resolveVesloRuntimeReadiness({
            localRuntimeContract,
            diagnostics,
          }),
          failureReason,
        };
      }
      const result: VesloServerProbeResult = {
        status: "connected" as VesloServerStatus,
        capabilities: caps,
        runtimeReadiness: localRuntimeContract ? undefined : "not-applicable",
      };
      markVesloServerReachable(result.status);
      return result;
    } catch (error) {
      const authStatus = resolveVesloServerAuthFailureStatus(error, {
        token,
        hostToken,
      });
      if (authStatus) {
        const result: VesloServerProbeResult = {
          status: authStatus,
          capabilities: null,
          runtimeReadiness: "unknown",
        };
        markVesloServerReachable(result.status);
        return result;
      }
      return {
        status: "disconnected" as VesloServerStatus,
        capabilities: null,
        runtimeReadiness: "unknown" as VesloRuntimeReadiness,
        failureReason: summarizeConnectionFailure(error),
      };
    }
  };

  const applyVesloServerProbeResult = (
    result: VesloServerProbeResult,
    source = "unspecified",
  ) => {
    setVesloServerStatus(result.status);
    setVesloServerCapabilitiesStable(result.capabilities);
    if (result.runtimeReadiness !== undefined) {
      setVesloRuntimeReadiness(result.runtimeReadiness);
    } else if (!isAuthenticatedVesloServerStatus(result.status)) {
      setVesloRuntimeReadiness("unknown");
    }
    setVesloServerCheckedAt(now());
    recordConnectionStateTransition(result, source);
  };

  const testVesloServerConnection = async (next: VesloServerSettings) => {
    const derived = normalizeVesloServerUrl(next.urlOverride ?? "");
    if (!derived) {
      applyVesloServerProbeResult(
        { status: "disconnected", capabilities: null },
        "manual-test-no-url",
      );
      return false;
    }
    const result = await checkVesloServer(
      derived,
      next.token,
      vesloServerAuth().hostToken,
    );
    applyVesloServerProbeResult(result, "manual-test");
    const ok = isAuthenticatedVesloServerStatus(result.status);
    if (ok && !deps.isTauriRuntime()) {
      const active = deps.workspace?.activeWorkspaceDisplay();
      const shouldAttach =
        !deps.routedClient?.() ||
        !active ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "veslo";
      if (shouldAttach) {
        await deps.workspace
          ?.createRemoteWorkspaceFlow?.({
            vesloHostUrl: derived,
            vesloToken: next.token ?? null,
          })
          .catch((error) =>
            deps.reportError?.(error, "workspace.createRemoteFlow"),
          );
      }
    }
    return ok;
  };

  const reconnectVesloServer = async () => {
    if (vesloReconnectBusy()) return false;
    setVesloReconnectBusy(true);
    try {
      if (
        deps.isTauriRuntime() &&
        deps.startupPreference() !== "server" &&
        deps.workspace?.activeWorkspaceDisplay().workspaceType === "local"
      ) {
        return await ensureLocalVesloServerRunning();
      }

      let hostInfo = vesloServerHostInfo();
      if (deps.isTauriRuntime()) {
        try {
          hostInfo = await loadVesloServerInfo();
          setVesloServerHostInfoStable(hostInfo);
        } catch {
          hostInfo = null;
          setVesloServerHostInfoStable(null);
        }
      }

      const runningHostInfo = resolveRunningVesloServerHostInfo(hostInfo);
      if (
        runningHostInfo?.clientToken?.trim() &&
        deps.startupPreference() !== "server"
      ) {
        const liveToken = runningHostInfo.clientToken.trim();
        const settings = vesloServerSettings();
        if ((settings.token?.trim() ?? "") !== liveToken) {
          updateVesloServerSettings({ ...settings, token: liveToken });
        }
      }

      const url = vesloServerBaseUrl().trim();
      const auth = vesloServerAuth();
      if (!url) {
        applyVesloServerProbeResult(
          { status: "disconnected", capabilities: null },
          "reconnect-no-url",
        );
        return false;
      }

      const result = await checkVesloServer(url, auth.token, auth.hostToken);
      applyVesloServerProbeResult(result, "reconnect");
      return isAuthenticatedVesloServerStatus(result.status);
    } finally {
      setVesloReconnectBusy(false);
    }
  };

  const ensureLocalVesloServerRunning = async (
    options?: EnsureLocalVesloServerRunningOptions,
  ) => {
    if (!deps.isTauriRuntime()) return false;
    const requireRuntimeChainReady =
      options?.requireRuntimeChainReady !== false;
    if (
      !options?.ignoreStartupPreference &&
      deps.startupPreference() === "server"
    ) {
      recordLocalEnsureOutcome({
        outcome: "skipped-startup-preference",
        requireRuntimeChainReady,
        restartAttempted: false,
      });
      return false;
    }
    if (deps.workspace?.activeWorkspaceDisplay().workspaceType !== "local") {
      recordLocalEnsureOutcome({
        outcome: "skipped-nonlocal-workspace",
        requireRuntimeChainReady,
        restartAttempted: false,
      });
      return false;
    }
    const ensureKey = [
      options?.ignoreStartupPreference === true
        ? "ignore-startup"
        : "respect-startup",
      requireRuntimeChainReady ? "runtime-chain" : "server-only",
    ].join(":");
    const inFlight = ensureLocalVesloServerRunningInFlight.get(ensureKey);
    if (inFlight) {
      return inFlight;
    }

    const ensureDeadline = new Set<true>();
    let restartAttempted = false;
    const ensureWork = async () => {
      let info: VesloServerInfo | null = null;
      try {
        info = await loadVesloServerInfo();
        if (ensureDeadline.has(true)) return false;
        setVesloServerHostInfoStable(info);
      } catch {
        if (ensureDeadline.has(true)) return false;
        setVesloServerHostInfoStable(null);
      }

      const liveInfo = resolveRunningVesloServerHostInfo(info);
      if (liveInfo?.baseUrl?.trim()) {
        const result = await checkVesloServer(
          liveInfo.baseUrl.trim(),
          liveInfo.clientToken?.trim() || undefined,
          liveInfo.hostToken?.trim() || undefined,
          { requireRuntimeChainReady },
        );
        if (ensureDeadline.has(true)) return false;
        applyVesloServerProbeResult(result, "local-ensure-existing");
        if (isAuthenticatedVesloServerStatus(result.status)) {
          // A reachable owned server must not be restarted merely because its
          // workspace runtime is warming or degraded. Runtime-dependent
          // callers still receive false until the readiness contract is met.
          const ready =
            !requireRuntimeChainReady || result.runtimeReadiness === "ready";
          recordLocalEnsureOutcome({
            outcome: ready ? "ready" : "runtime-not-ready",
            requireRuntimeChainReady,
            restartAttempted: false,
          });
          return ready;
        }
        // Desktop owns this local process; auth desync blocks inference, so try
        // one respawn instead of leaving non-technical users stuck.
      }

      restartAttempted = true;
      const restarted = await restartVesloServer();
      if (ensureDeadline.has(true)) return false;
      setVesloServerHostInfoStable(restarted);
      const restartedInfo = resolveRunningVesloServerHostInfo(restarted);
      const baseUrl = restartedInfo?.baseUrl?.trim() ?? "";
      if (!baseUrl) {
        applyVesloServerProbeResult(
          { status: "disconnected", capabilities: null },
          "local-ensure-restart-missing-info",
        );
        recordLocalEnsureOutcome({
          outcome: "restart-missing-info",
          requireRuntimeChainReady,
          restartAttempted: true,
        });
        return false;
      }

      const result = await checkVesloServer(
        baseUrl,
        restartedInfo?.clientToken?.trim() || undefined,
        restartedInfo?.hostToken?.trim() || undefined,
        { requireRuntimeChainReady },
      );
      if (ensureDeadline.has(true)) return false;
      applyVesloServerProbeResult(result, "local-ensure-restart");
      const ready =
        isAuthenticatedVesloServerStatus(result.status) &&
        (!requireRuntimeChainReady || result.runtimeReadiness === "ready");
      recordLocalEnsureOutcome({
        outcome: ready
          ? "ready"
          : isAuthenticatedVesloServerStatus(result.status)
            ? "runtime-not-ready"
            : "server-unreachable",
        requireRuntimeChainReady,
        restartAttempted: true,
      });
      return ready;
    };

    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => {
          ensureDeadline.add(true);
          reject(new Error("Local Veslo server ensure deadline exceeded"));
        },
        localEnsureTimeoutMs,
      );
    });
    const ensurePromise = Promise.race([ensureWork(), deadline])
      .catch((error) =>
        untrack(() => {
          const timedOut = error instanceof Error &&
            error.message === "Local Veslo server ensure deadline exceeded";
          applyVesloServerProbeResult(
            { status: "disconnected", capabilities: null },
            timedOut ? "local-ensure-deadline-exceeded" : "local-ensure-failed",
          );
          recordLocalEnsureOutcome({
            outcome: timedOut ? "deadline-exceeded" : "ensure-failed",
            requireRuntimeChainReady,
            restartAttempted,
          });
          return false;
        })
      )
      .finally(() => {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        if (
          ensureLocalVesloServerRunningInFlight.get(ensureKey) === ensurePromise
        ) {
          ensureLocalVesloServerRunningInFlight.delete(ensureKey);
        }
      });

    ensureLocalVesloServerRunningInFlight.set(ensureKey, ensurePromise);
    return ensurePromise;
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    setVesloServerSettings(readVesloServerSettings());
  });

  createEffect(() => {
    const pref = deps.startupPreference();
    const info = activeVesloServerHostInfo();
    const hostUrl =
      info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl =
      normalizeVesloServerUrl(vesloServerSettings().urlOverride ?? "") ?? "";

    if (pref === "local") {
      setVesloServerUrl(hostUrl);
      return;
    }
    if (pref === "server") {
      setVesloServerUrl(settingsUrl);
      return;
    }
    setVesloServerUrl(hostUrl || settingsUrl);
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!deps.documentVisible()) return;
    const url = vesloServerBaseUrl().trim();
    const auth = vesloServerAuth();
    const token = auth.token;
    const hostToken = auth.hostToken;

    if (!url) {
      applyVesloServerProbeResult(
        { status: "disconnected", capabilities: null },
        "status-poll-no-url",
      );
      return;
    }

    let active = true;
    let busy = false;
    let timeoutId: number | undefined;
    let delayMs = 1_000;
    let statusStability = createInitialVesloServerStatusStabilityState();

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
        const decision = applyVesloServerStatusProbe(statusStability, result, {
          nowMs: now(),
          previousDelayMs: delayMs,
        });
        statusStability = decision.state;
        applyVesloServerProbeResult(
          {
            status: decision.visibleStatus,
            capabilities: decision.visibleCapabilities,
            runtimeReadiness: isReachableVesloServerStatus(result.status)
              ? result.runtimeReadiness
              : isReachableVesloServerStatus(decision.visibleStatus)
                ? undefined
                : "unknown",
            failureReason: result.failureReason,
          },
          "status-poll",
        );
        delayMs = decision.nextDelayMs;
        if (decision.transientFailure) {
          recordPerfLog(
            runtimeConnectionTraceEnabled(),
            "workspace.requests",
            "veslo-status-transient-failure",
            {
              visibleStatus: decision.visibleStatus,
              observedStatus: result.status,
              observedReachability: resolveVesloServerReachability(
                result.status,
              ),
              observedRuntimeReadiness: result.runtimeReadiness ?? null,
              failureReason: result.failureReason ?? null,
              nextDelayMs: decision.nextDelayMs,
            },
          );
        }
      } catch (error) {
        const decision = applyVesloServerStatusProbe(
          statusStability,
          { status: "disconnected", capabilities: null },
          {
            nowMs: now(),
            previousDelayMs: delayMs,
          },
        );
        statusStability = decision.state;
        applyVesloServerProbeResult(
          {
            status: decision.visibleStatus,
            capabilities: decision.visibleCapabilities,
            runtimeReadiness: isReachableVesloServerStatus(
              decision.visibleStatus,
            )
              ? undefined
              : "unknown",
            failureReason: summarizeConnectionFailure(error),
          },
          "status-poll-error",
        );
        delayMs = decision.nextDelayMs;
        if (decision.transientFailure) {
          recordPerfLog(
            runtimeConnectionTraceEnabled(),
            "workspace.requests",
            "veslo-status-transient-failure",
            {
              visibleStatus: decision.visibleStatus,
              nextDelayMs: decision.nextDelayMs,
              failureReason: summarizeConnectionFailure(error),
            },
          );
        }
      } finally {
        if (!active) return;
        setVesloServerCheckedAt(now());
        busy = false;
        scheduleNext();
      }
    };

    void run();
    onCleanup(() => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
    });
  });

  createEffect(() => {
    if (!deps.isTauriRuntime()) return;
    if (!deps.documentVisible()) return;
    let active = true;
    let unlisten: UnlistenFn | null = null;
    let timeoutId: number | undefined;
    const timerApi = typeof window !== "undefined" ? window : null;

    const scheduleSnapshotWatchdog = () => {
      if (!active || !timerApi) return;
      timeoutId = timerApi.setTimeout(refreshSnapshot, 30_000);
    };

    const refreshSnapshot = async () => {
      try {
        const info = await loadVesloServerInfo();
        if (!active) return;
        setVesloServerHostInfoStable(info);
      } catch {
        if (!active) return;
        setVesloServerHostInfoStable(null);
      } finally {
        scheduleSnapshotWatchdog();
      }
    };

    void refreshSnapshot();
    const applyServerStateEvent = (info: VesloServerInfo) =>
      untrack(() => {
        if (!active) return;
        setVesloServerHostInfoFromEvent(info);
      });

    void listenVesloServerState(applyServerStateEvent)
      .then((cleanup) => {
        if (active) {
          unlisten = cleanup;
        } else {
          cleanup();
        }
      })
      .catch((error) =>
        deps.reportError?.(error, "vesloServer.stateEventListen"),
      );

    onCleanup(() => {
      active = false;
      unlisten?.();
      if (timeoutId && timerApi) timerApi.clearTimeout(timeoutId);
    });
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!deps.documentVisible()) return;
    if (!deps.developerMode()) {
      setVesloServerDiagnostics(null);
      return;
    }

    const client = vesloServerClient();
    if (!client || !isAuthenticatedVesloServerStatus(vesloServerStatus())) {
      setVesloServerDiagnostics(null);
      return;
    }

    let active = true;
    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        const status = await activeWorkspaceRuntimeStatus(
          client,
          deps.workspace?.activeWorkspaceId(),
        );
        if (active) setVesloServerDiagnostics(status);
      } catch {
        if (active) setVesloServerDiagnostics(null);
      } finally {
        busy = false;
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!deps.isTauriRuntime()) return;
    if (!deps.developerMode()) return;
    if (!deps.documentVisible()) return;
    if (!deps.workspace?.refreshEngine) return;

    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        await deps.workspace?.refreshEngine?.();
      } catch (error) {
        deps.reportError?.(error, "vesloServer.refreshEngine.poll");
      } finally {
        busy = false;
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, 10_000);
    onCleanup(() => {
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!deps.isTauriRuntime()) return;
    if (!deps.developerMode()) {
      setOpenCodeRouterInfoState(null);
      return;
    }
    if (!deps.documentVisible()) return;

    let active = true;

    const run = async () => {
      try {
        const info = await loadOpenCodeRouterInfo();
        if (active) setOpenCodeRouterInfoState(info);
      } catch {
        if (active) setOpenCodeRouterInfoState(null);
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!deps.isTauriRuntime()) return;
    if (!deps.developerMode()) {
      setOrchestratorStatusState(null);
      return;
    }
    if (!deps.documentVisible()) return;

    let active = true;

    const run = async () => {
      try {
        const status = await loadOrchestratorStatus();
        if (active) setOrchestratorStatusState(status);
      } catch {
        if (active) setOrchestratorStatusState(null);
      }
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!deps.isTauriRuntime()) return;
    if (!deps.documentVisible()) return;
    let active = true;
    const run = async () => {
      try {
        const list = await loadOrchestratorEngines();
        if (active) setOrchestratorEnginesState(list);
      } catch {
        if (active) setOrchestratorEnginesState([]);
      }
    };
    void run();
    const interval = window.setInterval(() => {
      void run();
    }, 30_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!deps.isTauriRuntime()) return;
    if (!deps.workspace?.workspacesHydrated()) return;
    if (deps.startupPreference() === "server") return;
    if (deps.workspace.activeWorkspaceDisplay().workspaceType !== "local")
      return;

    const activeWorkspaceId = deps.workspace.activeWorkspaceId().trim();
    const activeWorkspaceRoot = deps.workspace.activeWorkspaceRoot().trim();
    const nextKey =
      activeWorkspaceId || activeWorkspaceRoot
        ? [
            activeWorkspaceId,
            activeWorkspaceRoot,
            deps.opencodeBaseUrl().trim(),
          ].join("::")
        : "app-service";
    if (nextKey === lastLocalVesloEnsureKey) return;

    const scheduledKey = nextKey;
    void ensureLocalVesloServerRunning({ requireRuntimeChainReady: true })
      .then((ok) => {
        if (ok) {
          lastLocalVesloEnsureKey = scheduledKey;
        }
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : safeStringify(error);
        deps.setError?.(deps.addOpencodeCacheHint?.(message) ?? message);
        deps.reportError?.(error, "veslo-server.ensure.effect");
      });
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!deps.isTauriRuntime()) return;
    if (deps.startupPreference() === "server") return;
    if (deps.workspace?.activeWorkspaceDisplay().workspaceType !== "local") return;
    if (vesloServerStatus() !== "connected" || vesloRuntimeReadiness() !== "ready") return;

    let active = true;
    let retryTimer: number | undefined;
    const attemptRecord = () => {
      void recordDesktopBootstrapReady().then((recorded) => {
        if (!active || recorded || desktopBootstrapReadyRecorded) return;
        retryTimer = window.setTimeout(attemptRecord, 1_000);
      });
    };

    attemptRecord();
    onCleanup(() => {
      active = false;
      if (retryTimer) window.clearTimeout(retryTimer);
    });
  });

  return {
    vesloServerSettings,
    setVesloServerSettings,
    updateVesloServerSettings,
    resetVesloServerSettings,
    vesloServerUrl,
    setVesloServerUrl,
    vesloServerStatus,
    setVesloServerStatus,
    vesloServerConnectionSnapshot,
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
    setVesloServerDiagnostics,
    vesloReconnectBusy,
    setVesloReconnectBusy,
    opencodeRouterInfoState,
    setOpenCodeRouterInfoState,
    orchestratorStatusState,
    setOrchestratorStatusState,
    orchestratorEnginesState,
    setOrchestratorEnginesState,
    readyEngineWorkspaceIds,
    devtoolsWorkspaceId,
    setDevtoolsWorkspaceId,
    activeVesloServerHostInfo,
    activeVesloServerRoutingInfo,
    vesloServerBaseUrl,
    vesloServerAuth,
    vesloServerClient,
    vesloArchiveClientOptions,
    sessionArchiveOwnerKey,
    vesloArchiveClient,
    gatewayVesloServerClient,
    managedAiGatewayBaseUrl,
    devtoolsVesloClient,
    checkVesloServer,
    testVesloServerConnection,
    reconnectVesloServer,
    ensureLocalVesloServerRunning,
  };
}
