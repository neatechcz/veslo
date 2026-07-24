import type { EngineEnsureResult, EngineProcess, EngineWorkspace } from "./engine-pool.js";
import { usesSharedOpenCodeEngine, type EngineTopologyMode } from "./engine-topology.js";
import type { SharedOpenCodeEngine } from "./shared-opencode-engine.js";
import type { RuntimeEngineState } from "./runtime-engine-state.js";
import { runtimeEngineStateFromEngineState } from "./runtime-engine-state.js";

export type PooledOpenCodeEngine = {
  get?: (workspaceId: string) => EngineProcess | undefined;
  getRunning: (workspaceId: string) => EngineProcess | null;
  ensure: (workspace: EngineWorkspace) => Promise<EngineProcess>;
  ensureWithStatus?: (workspace: EngineWorkspace) => Promise<EngineEnsureResult>;
};

export type SharedOpenCodeEngineLike = Pick<
  SharedOpenCodeEngine,
  "getRunning" | "ensureStarted" | "snapshot"
> & {
  ensureStartedWithStatus?: (reason: string) => Promise<{ engine: EngineProcess; spawned: boolean }>;
};

export type OpenCodeProxyTarget = {
  engine: EngineProcess | null;
  engineKind: "pooled" | "shared";
  directory: string;
  spawnedByRequest: boolean;
  engineState: RuntimeEngineState;
  unavailableReason?: "absent" | "starting" | "stopped" | "failed";
};

function unavailableReasonForEngineState(
  engineState: RuntimeEngineState,
): OpenCodeProxyTarget["unavailableReason"] {
  switch (engineState) {
    case "starting":
      return "starting";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "absent":
      return "absent";
    default:
      return undefined;
  }
}

export async function resolveOpencodeProxyTarget(input: {
  topology: EngineTopologyMode;
  method: string;
  allowEngineStart?: boolean;
  workspaceId: string;
  workspacePath: string;
  pooledEngine: PooledOpenCodeEngine;
  sharedEngine?: SharedOpenCodeEngineLike;
}): Promise<OpenCodeProxyTarget> {
  const method = input.method.toUpperCase();
  const isReadOnlyProbe = method === "GET" || method === "HEAD" || input.allowEngineStart === false;

  if (usesSharedOpenCodeEngine(input.topology)) {
    if (!input.sharedEngine) {
      throw new Error("shared OpenCode engine is not configured");
    }
    if (isReadOnlyProbe) {
      const engine = input.sharedEngine.getRunning();
      const engineState = engine
        ? runtimeEngineStateFromEngineState(engine.state)
        : input.sharedEngine.snapshot().engineState;
      return {
        engine,
        engineKind: "shared",
        directory: input.workspacePath,
        spawnedByRequest: false,
        engineState,
        unavailableReason: engine ? undefined : unavailableReasonForEngineState(engineState),
      };
    }
    const runningBeforeEnsure = input.sharedEngine.getRunning();
    const ensured = input.sharedEngine.ensureStartedWithStatus
      ? await input.sharedEngine.ensureStartedWithStatus(`proxy ${method} ${input.workspaceId}`)
      : {
          engine: await input.sharedEngine.ensureStarted(`proxy ${method} ${input.workspaceId}`),
          spawned: runningBeforeEnsure === null,
        };
    return {
      engine: ensured.engine,
      engineKind: "shared",
      directory: input.workspacePath,
      spawnedByRequest: ensured.spawned,
      engineState: runtimeEngineStateFromEngineState(ensured.engine.state),
    };
  }

  if (isReadOnlyProbe) {
    const engine = input.pooledEngine.getRunning(input.workspaceId);
    const snapshot = engine ?? input.pooledEngine.get?.(input.workspaceId) ?? null;
    const engineState = runtimeEngineStateFromEngineState(snapshot?.state);
    return {
      engine,
      engineKind: "pooled",
      directory: input.workspacePath,
      spawnedByRequest: false,
      engineState,
      unavailableReason: engine ? undefined : unavailableReasonForEngineState(engineState),
    };
  }

  const runningBeforeEnsure = input.pooledEngine.getRunning(input.workspaceId);
  const ensured = input.pooledEngine.ensureWithStatus
    ? await input.pooledEngine.ensureWithStatus({
        id: input.workspaceId,
        path: input.workspacePath,
      })
    : {
        engine: await input.pooledEngine.ensure({
          id: input.workspaceId,
          path: input.workspacePath,
        }),
        spawned: runningBeforeEnsure === null && !input.pooledEngine.get?.(input.workspaceId),
      };
  return {
    engine: ensured.engine,
    engineKind: "pooled",
    directory: input.workspacePath,
    spawnedByRequest: ensured.spawned,
    engineState: runtimeEngineStateFromEngineState(ensured.engine.state),
  };
}
