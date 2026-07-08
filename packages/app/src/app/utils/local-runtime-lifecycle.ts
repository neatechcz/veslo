import type { OpencodeAuth } from "../lib/opencode";
import type { EngineInfo, WorkspaceInfo, WorkspaceRuntimePrepareResult } from "../lib/tauri";
import {
  activateVesloHostWorkspaceWithTimeout,
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
  forceFreshRuntime?: boolean;
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
  readEngineInfo: (workspaceId?: string, workspacePath?: string) => Promise<EngineInfo>;
  prepareWorkspaceRuntime: (input: LocalRuntimeStartOptions & {
    projectDir: string;
    workspaceId?: string | null;
    workspaceName?: string | null;
    reason?: string | null;
    forceFreshRuntime?: boolean;
  }) => Promise<WorkspaceRuntimePrepareResult>;
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
  connectQuiet: (
    baseUrl: string,
    directory: string,
    auth?: OpencodeAuth,
    context?: {
      workspaceId?: string;
      workspaceType?: WorkspaceInfo["workspaceType"];
      targetRoot?: string;
      reason?: string;
    },
  ) => Promise<boolean>;
}

export function resolveEngineAuth(
  info: Pick<EngineInfo, "opencodeUsername" | "opencodePassword">,
): OpencodeAuth | undefined {
  const username = info.opencodeUsername?.trim() ?? "";
  const password = info.opencodePassword?.trim() ?? "";
  return username && password ? { username, password } : undefined;
}

function isEngineStarting(info: Pick<EngineInfo, "runtime" | "engineState">): boolean {
  return info.runtime === "veslo-orchestrator" && info.engineState === "starting";
}

function shouldSkipQuietConnectForOrchestratorState(
  info: Pick<EngineInfo, "runtime" | "running" | "engineState">,
): boolean {
  if (info.runtime !== "veslo-orchestrator" || info.running) return false;
  return info.engineState === "absent" || info.engineState === "stopped" || info.engineState === "failed";
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
    let activeInfo = info;
    const mountWorkspaceId = (value: string | null | undefined) => {
      const baseUrl = value?.trim() ?? "";
      if (!baseUrl) return "";
      try {
        const match = new URL(baseUrl).pathname.match(/^\/workspace\/([^/]+)\/opencode(?:\/.*)?$/);
        return match ? decodeURIComponent(match[1] ?? "").trim() : "";
      } catch {
        return "";
      }
    };
    const snapshotWorkspaceId = mountWorkspaceId(activeInfo.baseUrl);
    if (
      options.workspaceId &&
      activeInfo.runtime === "veslo-orchestrator" &&
      snapshotWorkspaceId &&
      snapshotWorkspaceId !== options.workspaceId
    ) {
      activeInfo = await deps.readEngineInfo(options.workspaceId, options.workspacePath);
    }

    let auth = syncEngineSnapshot(activeInfo);
    let baseUrl = activeInfo.baseUrl?.trim() ?? "";

    // VSLO-171 — orchestrator F2Ú7 spawn-on-demand: engine_info returns an
    // empty baseUrl when the per-workspace engine hasn't been spawned yet.
    // Poll engine_info (with workspaceId) until baseUrl is populated so
    // connectToServer can run instead of being silently skipped.
    if (!baseUrl && options.workspaceId) {
      const pollStart = Date.now();
      const timeoutMs = 10_000;
      const pollIntervalMs = 200;
      while (Date.now() - pollStart < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        try {
          activeInfo = await deps.readEngineInfo(options.workspaceId, options.workspacePath);
        } catch {
          continue;
        }
        baseUrl = activeInfo.baseUrl?.trim() ?? "";
        if (baseUrl) {
          auth = syncEngineSnapshot(activeInfo);
          break;
        }
      }
    }

    if (options.workspaceId && isEngineStarting(activeInfo)) {
      const pollStart = Date.now();
      const timeoutMs = 10_000;
      const pollIntervalMs = 250;
      while (Date.now() - pollStart < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        try {
          activeInfo = await deps.readEngineInfo(options.workspaceId, options.workspacePath);
        } catch {
          continue;
        }
        baseUrl = activeInfo.baseUrl?.trim() ?? baseUrl;
        auth = syncEngineSnapshot(activeInfo);
        if (!isEngineStarting(activeInfo) || activeInfo.running) break;
      }
    }

    if (shouldSkipQuietConnectForOrchestratorState(activeInfo)) return false;

    if (!baseUrl) return true;

    if ((options.connectMode ?? "server") === "quiet") {
      return await deps.connectQuiet(baseUrl, options.workspacePath, auth ?? undefined, {
        workspaceId: options.workspaceId,
        workspaceType: "local",
        targetRoot: options.workspacePath,
        reason: options.reason,
      });
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

  async function prepareWorkspaceRuntime(options: LocalRuntimeReconnectOptions) {
    const runtime = deps.resolveEngineRuntime();
    const result = await deps.prepareWorkspaceRuntime({
      ...buildStartOptions(runtime),
      projectDir: options.workspacePath,
      workspaceId: options.workspaceId?.trim() || null,
      workspaceName: options.workspaceName?.trim() || null,
      reason: options.reason,
      forceFreshRuntime: options.forceFreshRuntime === true,
    });

    if (result.engine.runtime === "veslo-orchestrator") {
      await activateVesloHostWorkspaceWithTimeout(
        () => deps.activateVesloHostWorkspace(options.workspacePath),
      );
    }

    return await reconnectFromEngineSnapshot(result.engine, options);
  }

  async function startHost(
    options: Pick<
      LocalRuntimeReconnectOptions,
      "workspacePath" | "workspaceId" | "reason" | "connectMode" | "navigate"
    >,
  ) {
    return await prepareWorkspaceRuntime({
      ...options,
      forceFreshRuntime: true,
    });
  }

  async function restartWorkspaceRuntime(options: LocalRuntimeReconnectOptions) {
    return await prepareWorkspaceRuntime(options);
  }

  async function reattachOrchestratorWorkspace(
    options: Pick<
      LocalRuntimeReconnectOptions,
      "workspacePath" | "workspaceId" | "workspaceName" | "reason" | "connectMode" | "navigate"
    >,
  ) {
    return await prepareWorkspaceRuntime(options);
  }

  return {
    prepareWorkspaceRuntime,
    startHost,
    restartWorkspaceRuntime,
    reattachOrchestratorWorkspace,
    syncEngineSnapshot,
  };
}
