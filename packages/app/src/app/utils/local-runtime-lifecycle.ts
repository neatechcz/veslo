import type { OpencodeAuth } from "../lib/opencode";
import type { EngineInfo, WorkspaceInfo } from "../lib/tauri";
import { withTimeoutOrThrow } from "./promise-timeout";
import {
  activateVesloHostWorkspaceWithTimeout,
  runWorkspaceEngineRestartWithTimeouts,
} from "./workspace-switch-timeouts";

export type LocalRuntimeStartOptions = {
  preferSidecar: boolean;
  opencodeBinPath: string | null;
  runtime: EngineInfo["runtime"];
  workspacePaths: string[];
  // VSLO-171 F3Ú9: pool tuning forwarded to orchestrator daemon.
  maxEngines?: number | null;
  idleSuspendMs?: number | null;
};

export type LocalRuntimeConnectMode = "server" | "quiet";

export type LocalRuntimeReconnectOptions = {
  workspacePath: string;
  workspaceId?: string;
  workspaceName?: string | null;
  reason: string;
  connectMode?: LocalRuntimeConnectMode;
  navigate?: boolean;
  quiet?: boolean;
  beforeOrchestratorReconnect?: () => Promise<void>;
};

export interface LocalRuntimeLifecycleDeps {
  engineSource: () => "path" | "sidecar" | "custom";
  engineCustomBinPath?: () => string;
  resolveEngineRuntime: () => EngineInfo["runtime"];
  resolveWorkspacePaths: () => string[];
  // VSLO-171 F3Ú9: pool tuning accessors from Settings preferences.
  maxEngines?: () => number | null;
  idleSuspendMs?: () => number | null;
  setEngine: (info: EngineInfo) => void;
  setEngineAuth: (auth: OpencodeAuth | null) => void;
  startEngine: (workspacePath: string, options: LocalRuntimeStartOptions) => Promise<EngineInfo>;
  stopEngine: () => Promise<EngineInfo>;
  readEngineInfo: () => Promise<EngineInfo>;
  activateOrchestratorWorkspace: (input: {
    workspacePath: string;
    name?: string | null;
  }) => Promise<unknown>;
  activateVesloHostWorkspace: (workspacePath: string) => Promise<unknown>;
  connectToServer: (
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
  ) => Promise<boolean>;
  connectQuiet: (baseUrl: string, directory: string, auth?: OpencodeAuth) => Promise<boolean>;
}

export function resolveEngineAuth(
  info: Pick<EngineInfo, "opencodeUsername" | "opencodePassword">,
): OpencodeAuth | undefined {
  const username = info.opencodeUsername?.trim() ?? "";
  const password = info.opencodePassword?.trim() ?? "";
  return username && password ? { username, password } : undefined;
}

export function createLocalRuntimeLifecycle(deps: LocalRuntimeLifecycleDeps) {
  const buildStartOptions = (runtime: EngineInfo["runtime"]): LocalRuntimeStartOptions => ({
    preferSidecar: deps.engineSource() === "sidecar",
    opencodeBinPath: deps.engineSource() === "custom" ? deps.engineCustomBinPath?.().trim() || null : null,
    runtime,
    workspacePaths: deps.resolveWorkspacePaths(),
    maxEngines: deps.maxEngines?.() ?? null,
    idleSuspendMs: deps.idleSuspendMs?.() ?? null,
  });

  const syncEngineSnapshot = (info: EngineInfo): OpencodeAuth | undefined => {
    deps.setEngine(info);
    const auth = resolveEngineAuth(info);
    deps.setEngineAuth(auth ?? null);
    return auth;
  };

  const buildConnectOptions = (options: Pick<LocalRuntimeReconnectOptions, "navigate" | "quiet">) => {
    const next: { quiet?: boolean; navigate?: boolean } = {};
    if (options.quiet !== undefined) next.quiet = options.quiet;
    if (options.navigate !== undefined) next.navigate = options.navigate;
    return Object.keys(next).length ? next : undefined;
  };

  const reconnectFromEngineSnapshot = async (
    info: EngineInfo,
    options: LocalRuntimeReconnectOptions,
  ) => {
    const auth = syncEngineSnapshot(info);
    const baseUrl = info.baseUrl?.trim() ?? "";
    if (!baseUrl) return true;

    if ((options.connectMode ?? "server") === "quiet") {
      return await deps.connectQuiet(baseUrl, options.workspacePath, auth);
    }

    return await deps.connectToServer(
      baseUrl,
      options.workspacePath,
      {
        workspaceId: options.workspaceId,
        workspaceType: "local",
        targetRoot: options.workspacePath,
        reason: options.reason,
      },
      auth,
      buildConnectOptions(options),
    );
  };

  const activateOrchestratorWorkspace = async (options: Pick<
    LocalRuntimeReconnectOptions,
    "workspacePath" | "workspaceName"
  >) => {
    await deps.activateOrchestratorWorkspace({
      workspacePath: options.workspacePath,
      name: options.workspaceName?.trim() || null,
    });
    await activateVesloHostWorkspaceWithTimeout(
      () => deps.activateVesloHostWorkspace(options.workspacePath),
    );
  };

  async function startHost(
    options: Pick<LocalRuntimeReconnectOptions, "workspacePath" | "workspaceId" | "reason" | "navigate">,
  ) {
    const runtime = deps.resolveEngineRuntime();
    const info = await deps.startEngine(options.workspacePath, buildStartOptions(runtime));
    return await reconnectFromEngineSnapshot(info, options);
  }

  async function restartWorkspaceRuntime(options: LocalRuntimeReconnectOptions) {
    const runtime = deps.resolveEngineRuntime();
    if (runtime === "veslo-orchestrator") {
      if (options.beforeOrchestratorReconnect) {
        await options.beforeOrchestratorReconnect();
      }
      await activateOrchestratorWorkspace(options);
      const nextInfo = await withTimeoutOrThrow(
        deps.readEngineInfo(),
        { timeoutMs: 12_000, label: "engine_info" },
      );
      return await reconnectFromEngineSnapshot(nextInfo, options);
    }

    const { stopResult, startResult } = await runWorkspaceEngineRestartWithTimeouts({
      stop: () => deps.stopEngine(),
      start: () => deps.startEngine(options.workspacePath, buildStartOptions(runtime)),
    });
    deps.setEngine(stopResult);
    return await reconnectFromEngineSnapshot(startResult, options);
  }

  async function reattachOrchestratorWorkspace(
    options: Pick<LocalRuntimeReconnectOptions, "workspacePath" | "workspaceId" | "workspaceName" | "reason" | "navigate">,
  ) {
    await activateOrchestratorWorkspace(options);
    const nextInfo = await withTimeoutOrThrow(
      deps.readEngineInfo(),
      { timeoutMs: 12_000, label: "engine_info" },
    );
    return await reconnectFromEngineSnapshot(nextInfo, options);
  }

  return {
    startHost,
    restartWorkspaceRuntime,
    reattachOrchestratorWorkspace,
    syncEngineSnapshot,
  };
}
