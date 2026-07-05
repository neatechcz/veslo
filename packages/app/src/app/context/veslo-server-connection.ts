import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";

import {
  createInitialVesloServerStatusStabilityState,
  applyVesloServerStatusProbe,
} from "../lib/veslo-server/status-stability";
import {
  createVesloServerClient,
  deriveLocalVesloServerUrlFromOpencodeBaseUrl,
  normalizeVesloServerUrl,
  readVesloServerSettings,
  resolveSessionArchiveClientOptions,
  writeVesloServerSettings,
  clearVesloServerSettings,
  VesloServerError,
  type VesloAuditEntry,
  type VesloServerCapabilities,
  type VesloServerClient,
  type VesloServerDiagnostics,
  type VesloServerSettings,
  type VesloServerStatus,
} from "../lib/veslo-server";
import { resolveManagedAiGatewayBaseUrl } from "../lib/ai-access";
import { recordPerfLog } from "../lib/perf-log";
import { resolveRunningVesloServerHostInfo } from "../lib/veslo-server-host";
import {
  vesloServerInfo as defaultVesloServerInfo,
  vesloServerRestart as defaultVesloServerRestart,
  opencodeRouterInfo as defaultOpenCodeRouterInfo,
  orchestratorEnginesList as defaultOrchestratorEnginesList,
  orchestratorStatus as defaultOrchestratorStatus,
  type OpenCodeRouterInfo,
  type OrchestratorEngineSnapshot,
  type OrchestratorStatus,
  type VesloServerInfo,
} from "../lib/tauri";
import { safeStringify } from "../utils";
import type { StartupPreference } from "../types";

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
  activeWorkspaceDisplay: Accessor<{ workspaceType: string; remoteType?: string | null }>;
  activeWorkspaceId: Accessor<string>;
  activeWorkspaceRoot: Accessor<string>;
  createRemoteWorkspaceFlow?: (input: { vesloHostUrl: string; vesloToken?: string | null }) => Promise<unknown>;
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
  opencodeRouterInfo?: () => Promise<OpenCodeRouterInfo | null>;
  orchestratorStatus?: () => Promise<OrchestratorStatus | null>;
  orchestratorEnginesList?: () => Promise<OrchestratorEngineSnapshot[]>;
  now?: () => number;
};

export type VesloServerAuth = {
  token?: string;
  hostToken?: string;
};

export type ResolveVesloServerBaseUrlInput = {
  startupPreference: StartupPreference | null;
  activeHostInfo: VesloServerConnectionHostInfo | null;
  localFallbackUrl: string;
  settingsUrl: string;
};

export type ResolveVesloServerAuthInput = {
  startupPreference: StartupPreference | null;
  activeHostInfo: VesloServerConnectionHostInfo | null;
  localFallbackUrl: string;
  settingsToken: string;
};

export type VesloServerConnection = ReturnType<typeof createVesloServerConnection>;

function stateKey(value: unknown): string {
  return safeStringify(value ?? null);
}

function defaultCreateClient(input: VesloServerConnectionClientFactoryInput) {
  return createVesloServerClient(input) as VesloServerConnectionClient & VesloServerClient;
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

function hasReadyRuntimeChain(status: VesloServerDiagnostics | null | undefined): boolean {
  return status?.runtimeChain?.status === "runtime_chain_ready";
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
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

export function resolveVesloServerBaseUrl(input: ResolveVesloServerBaseUrlInput): string {
  const pref = input.startupPreference;
  const hostInfo = input.activeHostInfo;
  const settingsUrl = input.settingsUrl.trim();
  const localFallbackUrl = input.localFallbackUrl.trim();
  const preferredLocalUrl = hostInfo?.baseUrl?.trim() || localFallbackUrl;

  if (pref === "local") return preferredLocalUrl;
  if (pref === "server") return settingsUrl;
  return preferredLocalUrl || settingsUrl;
}

export function resolveVesloServerAuth(input: ResolveVesloServerAuthInput): VesloServerAuth {
  const pref = input.startupPreference;
  const hostInfo = input.activeHostInfo;
  const settingsToken = input.settingsToken.trim();
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
  if (input.localFallbackUrl.trim()) {
    return { token: undefined, hostToken: undefined };
  }
  return { token: settingsToken || undefined, hostToken: undefined };
}

export function createVesloServerConnection(deps: VesloServerConnectionDeps) {
  const now = deps.now ?? (() => Date.now());
  const createClient = deps.createClient ?? defaultCreateClient;
  const loadVesloServerInfo = deps.vesloServerInfo ?? defaultVesloServerInfo;
  const restartVesloServer = deps.vesloServerRestart ?? defaultVesloServerRestart;
  const loadOpenCodeRouterInfo = deps.opencodeRouterInfo ?? defaultOpenCodeRouterInfo;
  const loadOrchestratorStatus = deps.orchestratorStatus ?? defaultOrchestratorStatus;
  const loadOrchestratorEngines = deps.orchestratorEnginesList ?? defaultOrchestratorEnginesList;

  const [vesloServerSettings, setVesloServerSettings] = createSignal<VesloServerSettings>({});
  const [vesloServerUrl, setVesloServerUrl] = createSignal("");
  const [vesloServerStatus, setVesloServerStatus] = createSignal<VesloServerStatus>("disconnected");
  const [vesloServerCapabilities, setVesloServerCapabilities] =
    createSignal<VesloServerCapabilities | null>(null);
  const [vesloServerCheckedAt, setVesloServerCheckedAt] = createSignal<number | null>(null);
  const [vesloServerWorkspaceId, setVesloServerWorkspaceId] = createSignal<string | null>(null);
  const [vesloServerHostInfo, setVesloServerHostInfo] = createSignal<VesloServerInfo | null>(null);
  const [vesloServerDiagnostics, setVesloServerDiagnostics] =
    createSignal<VesloServerDiagnostics | null>(null);
  const [vesloReconnectBusy, setVesloReconnectBusy] = createSignal(false);
  const [opencodeRouterInfoState, setOpenCodeRouterInfoState] =
    createSignal<OpenCodeRouterInfo | null>(null);
  const [orchestratorStatusState, setOrchestratorStatusState] =
    createSignal<OrchestratorStatus | null>(null);
  const [orchestratorEnginesState, setOrchestratorEnginesState] =
    createSignal<OrchestratorEngineSnapshot[]>([]);
  const [vesloAuditEntries, setVesloAuditEntries] = createSignal<VesloAuditEntry[]>([]);
  const [vesloAuditStatus, setVesloAuditStatus] =
    createSignal<"idle" | "loading" | "error">("idle");
  const [vesloAuditError, setVesloAuditError] = createSignal<string | null>(null);
  const [devtoolsWorkspaceId, setDevtoolsWorkspaceId] = createSignal<string | null>(null);
  let vesloServerLastReachableAt = 0;
  let ensureLocalVesloServerRunningInFlight: Promise<boolean> | null = null;
  let lastLocalVesloEnsureKey = "";

  const markVesloServerReachable = (status: VesloServerStatus, at = now()) => {
    if (status === "connected" || status === "limited") {
      vesloServerLastReachableAt = at;
    }
  };

  const vesloServerRecentlyReachable = (at = now()) =>
    vesloServerLastReachableAt > 0 && at - vesloServerLastReachableAt <= 30_000;

  const setVesloServerCapabilitiesStable = (next: VesloServerCapabilities | null) => {
    const nextKey = stateKey(next);
    setVesloServerCapabilities((current) => (stateKey(current) === nextKey ? current : next));
  };

  const setVesloServerHostInfoStable = (next: VesloServerInfo | null) => {
    const nextKey = stateKey(next);
    setVesloServerHostInfo((current) => (stateKey(current) === nextKey ? current : next));
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
      if (engine.state === "ready" || engine.state === "idle") set.add(engine.workspaceId);
    }
    return set;
  });

  const vesloServerLocalFallbackBaseUrl = createMemo(() => {
    if (!deps.isTauriRuntime()) return "";
    if (deps.startupPreference() === "server") return "";
    return deriveLocalVesloServerUrlFromOpencodeBaseUrl(deps.opencodeBaseUrl()) ?? "";
  });

  const vesloServerBaseUrl = createMemo(() =>
    resolveVesloServerBaseUrl({
      startupPreference: deps.startupPreference(),
      activeHostInfo: activeVesloServerHostInfo(),
      localFallbackUrl: vesloServerLocalFallbackBaseUrl(),
      settingsUrl: normalizeVesloServerUrl(vesloServerSettings().urlOverride ?? "") ?? "",
    }),
  );

  const vesloServerAuth = createMemo(
    () =>
      resolveVesloServerAuth({
        startupPreference: deps.startupPreference(),
        activeHostInfo: activeVesloServerHostInfo(),
        localFallbackUrl: vesloServerLocalFallbackBaseUrl(),
        settingsToken: vesloServerSettings().token?.trim() ?? "",
      }),
    undefined,
    {
      equals: (prev, next) => prev?.token === next.token && prev?.hostToken === next.hostToken,
    },
  );

  const vesloServerClient = createMemo<VesloServerClient | null>(() => {
    const baseUrl = vesloServerBaseUrl().trim();
    if (!baseUrl) return null;
    const auth = vesloServerAuth();
    return createClient({ baseUrl, token: auth.token, hostToken: auth.hostToken }) as VesloServerClient;
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

  const sessionArchiveOwnerKey = createMemo(() => vesloArchiveClientOptions()?.accountId ?? "");

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

    if (isLoopbackVesloServerConnectionUrl(activeBaseUrl) && !isLoopbackVesloServerConnectionUrl(remoteUrl)) {
      return createClient({ baseUrl: remoteUrl, token: remoteToken }) as VesloServerClient;
    }

    return active;
  });

  const managedAiGatewayBaseUrl = createMemo(() => {
    const settings = vesloServerSettings();
    return resolveManagedAiGatewayBaseUrl({
      settingsUrl: normalizeVesloServerUrl(settings.urlOverride ?? "") ?? "",
      gatewayClientBaseUrl: gatewayVesloServerClient()?.baseUrl?.trim() ?? "",
      localFallbackBaseUrl: vesloServerLocalFallbackBaseUrl(),
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

  const checkVesloServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createClient({ baseUrl: url, token, hostToken });
    const requireRuntimeChainReady = requiresLocalRuntimeChainReadiness({
      isTauriRuntime: deps.isTauriRuntime(),
      startupPreference: deps.startupPreference(),
      activeWorkspaceType: deps.workspace?.activeWorkspaceDisplay().workspaceType,
      url,
    });
    try {
      await client.health();
    } catch (error) {
      if (error instanceof VesloServerError && (error.status === 401 || error.status === 403)) {
        const result = { status: "limited" as VesloServerStatus, capabilities: null };
        markVesloServerReachable(result.status);
        return result;
      }
      return { status: "disconnected" as VesloServerStatus, capabilities: null };
    }
    markVesloServerReachable("limited");

    if (!token) {
      return { status: "limited" as VesloServerStatus, capabilities: null };
    }

    try {
      const caps = await client.capabilities();
      if (requireRuntimeChainReady) {
        const diagnostics = await activeWorkspaceRuntimeStatus(client, deps.workspace?.activeWorkspaceId());
        if (!hasReadyRuntimeChain(diagnostics)) {
          setVesloServerDiagnostics(diagnostics ?? null);
          return { status: "disconnected" as VesloServerStatus, capabilities: null };
        }
        setVesloServerDiagnostics(diagnostics ?? null);
      }
      const result = { status: "connected" as VesloServerStatus, capabilities: caps };
      markVesloServerReachable(result.status);
      return result;
    } catch (error) {
      if (error instanceof VesloServerError && (error.status === 401 || error.status === 403)) {
        const result = { status: "limited" as VesloServerStatus, capabilities: null };
        markVesloServerReachable(result.status);
        return result;
      }
      return { status: "disconnected" as VesloServerStatus, capabilities: null };
    }
  };

  const applyVesloServerProbeResult = (result: {
    status: VesloServerStatus;
    capabilities: VesloServerCapabilities | null;
  }) => {
    setVesloServerStatus(result.status);
    setVesloServerCapabilitiesStable(result.capabilities);
    setVesloServerCheckedAt(now());
  };

  const testVesloServerConnection = async (next: VesloServerSettings) => {
    const derived = normalizeVesloServerUrl(next.urlOverride ?? "");
    if (!derived) {
      applyVesloServerProbeResult({ status: "disconnected", capabilities: null });
      return false;
    }
    const result = await checkVesloServer(derived, next.token, vesloServerAuth().hostToken);
    applyVesloServerProbeResult(result);
    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !deps.isTauriRuntime()) {
      const active = deps.workspace?.activeWorkspaceDisplay();
      const shouldAttach =
        !deps.routedClient?.() ||
        !active ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "veslo";
      if (shouldAttach) {
        await deps.workspace?.createRemoteWorkspaceFlow?.({
          vesloHostUrl: derived,
          vesloToken: next.token ?? null,
        }).catch((error) => deps.reportError?.(error, "workspace.createRemoteFlow"));
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
      if (runningHostInfo?.clientToken?.trim() && deps.startupPreference() !== "server") {
        const liveToken = runningHostInfo.clientToken.trim();
        const settings = vesloServerSettings();
        if ((settings.token?.trim() ?? "") !== liveToken) {
          updateVesloServerSettings({ ...settings, token: liveToken });
        }
      }

      const url = vesloServerBaseUrl().trim();
      const auth = vesloServerAuth();
      if (!url) {
        applyVesloServerProbeResult({ status: "disconnected", capabilities: null });
        return false;
      }

      const result = await checkVesloServer(url, auth.token, auth.hostToken);
      applyVesloServerProbeResult(result);
      return result.status === "connected" || result.status === "limited";
    } finally {
      setVesloReconnectBusy(false);
    }
  };

  const ensureLocalVesloServerRunning = async (options?: { ignoreStartupPreference?: boolean }) => {
    if (!deps.isTauriRuntime()) return false;
    if (!options?.ignoreStartupPreference && deps.startupPreference() === "server") return false;
    if (deps.workspace?.activeWorkspaceDisplay().workspaceType !== "local") return false;
    if (ensureLocalVesloServerRunningInFlight) {
      return ensureLocalVesloServerRunningInFlight;
    }

    ensureLocalVesloServerRunningInFlight = (async () => {
      let info: VesloServerInfo | null = null;
      try {
        info = await loadVesloServerInfo();
        setVesloServerHostInfoStable(info);
      } catch {
        setVesloServerHostInfoStable(null);
      }

      const liveInfo = resolveRunningVesloServerHostInfo(info);
      if (liveInfo?.baseUrl?.trim()) {
        const result = await checkVesloServer(
          liveInfo.baseUrl.trim(),
          liveInfo.clientToken?.trim() || undefined,
          liveInfo.hostToken?.trim() || undefined,
        );
        applyVesloServerProbeResult(result);
        if (result.status !== "disconnected") {
          return true;
        }
      }

      const restarted = await restartVesloServer();
      setVesloServerHostInfoStable(restarted);
      const restartedInfo = resolveRunningVesloServerHostInfo(restarted);
      const baseUrl = restartedInfo?.baseUrl?.trim() ?? "";
      if (!baseUrl) {
        applyVesloServerProbeResult({ status: "disconnected", capabilities: null });
        return false;
      }

      const result = await checkVesloServer(
        baseUrl,
        restartedInfo?.clientToken?.trim() || undefined,
        restartedInfo?.hostToken?.trim() || undefined,
      );
      applyVesloServerProbeResult(result);
      return result.status !== "disconnected";
    })().finally(() => {
      ensureLocalVesloServerRunningInFlight = null;
    });

    return ensureLocalVesloServerRunningInFlight;
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    setVesloServerSettings(readVesloServerSettings());
  });

  createEffect(() => {
    const pref = deps.startupPreference();
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

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!deps.documentVisible()) return;
    const url = vesloServerBaseUrl().trim();
    const auth = vesloServerAuth();
    const token = auth.token;
    const hostToken = auth.hostToken;

    if (!url) {
      applyVesloServerProbeResult({ status: "disconnected", capabilities: null });
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
        setVesloServerStatus(decision.visibleStatus);
        setVesloServerCapabilitiesStable(decision.visibleCapabilities);
        delayMs = decision.nextDelayMs;
        if (decision.transientFailure) {
          recordPerfLog(deps.developerMode(), "workspace.requests", "veslo-status-transient-failure", {
            visibleStatus: decision.visibleStatus,
            nextDelayMs: decision.nextDelayMs,
          });
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
        setVesloServerStatus(decision.visibleStatus);
        setVesloServerCapabilitiesStable(decision.visibleCapabilities);
        delayMs = decision.nextDelayMs;
        if (decision.transientFailure) {
          recordPerfLog(deps.developerMode(), "workspace.requests", "veslo-status-transient-failure", {
            visibleStatus: decision.visibleStatus,
            nextDelayMs: decision.nextDelayMs,
            message: error instanceof Error ? error.message : safeStringify(error),
          });
        }
      } finally {
        if (!active) return;
        setVesloServerCheckedAt(now());
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
    if (!deps.isTauriRuntime()) return;
    if (!deps.documentVisible()) return;
    let active = true;
    let timeoutId: number | undefined;

    const schedule = (delayMs: number) => {
      if (!active) return;
      timeoutId = window.setTimeout(run, delayMs);
    };

    const run = async () => {
      try {
        const info = await loadVesloServerInfo();
        if (!active) return;
        setVesloServerHostInfoStable(info);
        schedule(info?.running ? 10_000 : 1_000);
      } catch {
        if (!active) return;
        setVesloServerHostInfoStable(null);
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
    if (!deps.documentVisible()) return;
    if (!deps.developerMode()) {
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
        const status = await activeWorkspaceRuntimeStatus(client, deps.workspace?.activeWorkspaceId());
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

    run();
    const interval = window.setInterval(run, 10_000);
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

    run();
    const interval = window.setInterval(run, 10_000);
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
    run();
    const interval = window.setInterval(run, 30_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!deps.isTauriRuntime()) return;
    if (!deps.workspace?.workspacesHydrated()) return;
    if (deps.startupPreference() === "server") return;
    if (deps.workspace.activeWorkspaceDisplay().workspaceType !== "local") return;

    const activeWorkspaceId = deps.workspace.activeWorkspaceId().trim();
    const activeWorkspaceRoot = deps.workspace.activeWorkspaceRoot().trim();
    const nextKey = activeWorkspaceId || activeWorkspaceRoot
      ? [activeWorkspaceId, activeWorkspaceRoot, deps.opencodeBaseUrl().trim()].join("::")
      : "app-service";
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
        deps.setError?.(deps.addOpencodeCacheHint?.(message) ?? message);
        deps.reportError?.(error, "veslo-server.ensure.effect");
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
    vesloServerLocalFallbackBaseUrl,
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
