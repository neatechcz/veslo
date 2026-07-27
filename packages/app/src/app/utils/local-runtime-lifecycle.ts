import type { OpencodeAuth } from "../lib/opencode";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import type { EngineInfo, WorkspaceInfo, WorkspaceRuntimePrepareResult } from "../lib/tauri";
import {
  activateVesloHostWorkspaceWithTimeout,
} from "./workspace-switch-timeouts";
import { withTimeoutOrThrow } from "./promise-timeout";

const DEFAULT_LOCAL_RUNTIME_PREPARE_TIMEOUT_MS = 75_000;
const DEFAULT_LOCAL_RUNTIME_PREPARE_QUEUE_STALE_RELEASE_MS = 190_000;

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
  skillViewRevision?: string | null;
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
  runtimePrepareTimeoutMs?: () => number | null;
  prepareWorkspaceRuntime: (input: LocalRuntimeStartOptions & {
    projectDir: string;
    workspaceId?: string | null;
    workspaceName?: string | null;
    reason?: string | null;
    forceFreshRuntime?: boolean;
    skillViewRevision?: string | null;
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

function messageFromUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveRuntimePrepareTimeoutMs(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_LOCAL_RUNTIME_PREPARE_TIMEOUT_MS;
}

export function createLocalRuntimeLifecycle(deps: LocalRuntimeLifecycleDeps) {
  let prepareQueue: Promise<void> = Promise.resolve();

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

  const recordPrepareTrace = (
    event: string,
    options: LocalRuntimeReconnectOptions,
    payload: Record<string, unknown> = {},
  ) => {
    recordSendWorkflowTrace("local-runtime-lifecycle", event, {
      workspaceId: options.workspaceId ?? null,
      workspacePath: options.workspacePath,
      reason: options.reason,
      connectMode: options.connectMode ?? "server",
      ...payload,
    });
  };

  const acquirePrepareQueue = async (
    options: LocalRuntimeReconnectOptions,
  ) => {
    const previous = prepareQueue;
    let releaseQueue!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    prepareQueue = previous.catch(() => undefined).then(() => current);

    let released = false;
    let staleReleaseId: ReturnType<typeof setTimeout> | null = null;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      if (staleReleaseId) clearTimeout(staleReleaseId);
      releaseQueue();
    };

    const timeoutMs = resolveRuntimePrepareTimeoutMs(deps.runtimePrepareTimeoutMs?.() ?? null);
    const queuedAt = Date.now();
    recordPrepareTrace("prepare-runtime:queue-wait:start", options, {
      timeoutMs,
    });
    try {
      await withTimeoutOrThrow(previous.catch(() => undefined), {
        timeoutMs,
        label: "local runtime prepare queue",
      });
    } catch (error) {
      recordPrepareTrace("prepare-runtime:queue-timeout", options, {
        durationMs: Date.now() - queuedAt,
        timeoutMs,
      });
      releaseOnce();
      throw error;
    }
    recordPrepareTrace("prepare-runtime:queue-wait:done", options, {
      durationMs: Date.now() - queuedAt,
      timeoutMs,
    });

    staleReleaseId = setTimeout(() => {
      recordPrepareTrace("prepare-runtime:native-queue-stale-release", options, {
        durationMs: Date.now() - queuedAt,
      });
      releaseOnce();
    }, Math.max(timeoutMs, DEFAULT_LOCAL_RUNTIME_PREPARE_QUEUE_STALE_RELEASE_MS));

    return { releaseOnce, timeoutMs };
  };

  const runNativePrepare = async (
    input: LocalRuntimeStartOptions & {
      projectDir: string;
      workspaceId?: string | null;
      workspaceName?: string | null;
      reason?: string | null;
      forceFreshRuntime?: boolean;
      skillViewRevision?: string | null;
    },
    options: LocalRuntimeReconnectOptions,
    timeoutMs: number,
    releaseQueue: () => void,
  ) => {
    const startedAt = Date.now();
    recordPrepareTrace("prepare-runtime:native-start", options, {
      runtime: input.runtime,
      forceFreshRuntime: input.forceFreshRuntime === true,
      timeoutMs,
    });

    const nativePrepare = deps.prepareWorkspaceRuntime(input);
    nativePrepare.then(
      (result) => {
        recordPrepareTrace("prepare-runtime:native-done", options, {
          durationMs: Date.now() - startedAt,
          action: result.action,
          ok: result.ok,
          engineState: result.engine.engineState ?? null,
          running: result.engine.running,
        });
      },
      (error) => {
        recordPrepareTrace("prepare-runtime:native-error", options, {
          durationMs: Date.now() - startedAt,
          error: messageFromUnknownError(error),
        });
      },
    );

    try {
      return await withTimeoutOrThrow(nativePrepare, {
        timeoutMs,
        label: "local runtime prepare",
      });
    } catch (error) {
      const message = messageFromUnknownError(error);
      if (message.includes("Timed out waiting for local runtime prepare")) {
        recordPrepareTrace("prepare-runtime:native-timeout", options, {
          durationMs: Date.now() - startedAt,
          timeoutMs,
        });
        // Timed-out warmup must release the queue so a send recovery can take over.
        releaseQueue();
      }
      throw error;
    }
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
    const recordEngineInfoPollTrace = (
      event: string,
      payload: Record<string, unknown>,
    ) => {
      recordSendWorkflowTrace("local-runtime-lifecycle", event, {
        workspaceId: options.workspaceId ?? null,
        workspacePath: options.workspacePath,
        reason: options.reason,
        connectMode: options.connectMode ?? "server",
        ...payload,
      });
    };

    // VSLO-171 — orchestrator F2Ú7 spawn-on-demand: engine_info returns an
    // empty baseUrl when the per-workspace engine hasn't been spawned yet.
    // Poll engine_info (with workspaceId) until baseUrl is populated so
    // connectToServer can run instead of being silently skipped.
    if (!baseUrl && options.workspaceId) {
      const pollStart = Date.now();
      const timeoutMs = 10_000;
      const pollIntervalMs = 200;
      let attempts = 0;
      let failures = 0;
      let lastError: string | null = null;
      while (Date.now() - pollStart < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        attempts += 1;
        try {
          activeInfo = await deps.readEngineInfo(options.workspaceId, options.workspacePath);
        } catch (error) {
          failures += 1;
          lastError = messageFromUnknownError(error);
          if (failures === 1) {
            recordEngineInfoPollTrace("engine-info-poll:error", {
              phase: "base-url",
              attempt: attempts,
              error: lastError,
            });
          }
          continue;
        }
        baseUrl = activeInfo.baseUrl?.trim() ?? "";
        if (baseUrl) {
          auth = syncEngineSnapshot(activeInfo);
          break;
        }
      }
      if (!baseUrl && (attempts > 0 || failures > 0)) {
        recordEngineInfoPollTrace("engine-info-poll:timeout", {
          phase: "base-url",
          attempts,
          failures,
          lastError,
          durationMs: Date.now() - pollStart,
        });
      }
    }

    if (options.workspaceId && isEngineStarting(activeInfo)) {
      const pollStart = Date.now();
      const timeoutMs = 10_000;
      const pollIntervalMs = 250;
      let attempts = 0;
      let failures = 0;
      let lastError: string | null = null;
      while (Date.now() - pollStart < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        attempts += 1;
        try {
          activeInfo = await deps.readEngineInfo(options.workspaceId, options.workspacePath);
        } catch (error) {
          failures += 1;
          lastError = messageFromUnknownError(error);
          if (failures === 1) {
            recordEngineInfoPollTrace("engine-info-poll:error", {
              phase: "starting",
              attempt: attempts,
              error: lastError,
            });
          }
          continue;
        }
        baseUrl = activeInfo.baseUrl?.trim() ?? baseUrl;
        auth = syncEngineSnapshot(activeInfo);
        if (!isEngineStarting(activeInfo) || activeInfo.running) break;
      }
      if (isEngineStarting(activeInfo) && !activeInfo.running && (attempts > 0 || failures > 0)) {
        recordEngineInfoPollTrace("engine-info-poll:timeout", {
          phase: "starting",
          attempts,
          failures,
          lastError,
          engineState: activeInfo.engineState ?? null,
          durationMs: Date.now() - pollStart,
        });
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
    const { releaseOnce, timeoutMs } = await acquirePrepareQueue(options);
    try {
      const result = await runNativePrepare({
        ...buildStartOptions(runtime),
        projectDir: options.workspacePath,
        workspaceId: options.workspaceId?.trim() || null,
        workspaceName: options.workspaceName?.trim() || null,
        reason: options.reason,
        forceFreshRuntime: options.forceFreshRuntime === true,
        skillViewRevision: options.skillViewRevision ?? null,
      }, options, timeoutMs, releaseOnce);

      if (result.engine.runtime === "veslo-orchestrator") {
        await activateVesloHostWorkspaceWithTimeout(
          () => deps.activateVesloHostWorkspace(options.workspacePath),
        );
      }

      return await reconnectFromEngineSnapshot(result.engine, options);
    } finally {
      // Keep the runtime prepare queue held through activation and reconnect so a
      // foreground recovery cannot replace a warmup engine before its routed
      // client is bound.
      releaseOnce();
    }
  }

  async function startHost(
    options: Pick<
      LocalRuntimeReconnectOptions,
      "workspacePath" | "workspaceId" | "reason" | "connectMode" | "navigate" | "skillViewRevision"
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
