import type { EngineProcess, EngineWorkspace } from "./engine-pool.js";
import type { EngineTopologyMode } from "./engine-topology.js";
import type { SharedOpenCodeEngine } from "./shared-opencode-engine.js";
import type { RuntimeEngineState } from "./runtime-engine-state.js";
import { runtimeEngineStateFromEngineState } from "./runtime-engine-state.js";

export type PooledOpenCodeEngine = {
  get?: (workspaceId: string) => EngineProcess | undefined;
  getRunning: (workspaceId: string) => EngineProcess | null;
  ensure: (workspace: EngineWorkspace) => Promise<EngineProcess>;
};

export type SharedOpenCodeEngineLike = Pick<
  SharedOpenCodeEngine,
  "getRunning" | "ensureStarted" | "snapshot"
>;

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
  workspaceId: string;
  workspacePath: string;
  pooledEngine: PooledOpenCodeEngine;
  sharedEngine?: SharedOpenCodeEngineLike;
}): Promise<OpenCodeProxyTarget> {
  const method = input.method.toUpperCase();
  const isReadOnlyProbe = method === "GET" || method === "HEAD";

  if (input.topology === "shared-unsandboxed") {
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
    const engine = await input.sharedEngine.ensureStarted(`proxy ${method} ${input.workspaceId}`);
    return {
      engine,
      engineKind: "shared",
      directory: input.workspacePath,
      spawnedByRequest: true,
      engineState: runtimeEngineStateFromEngineState(engine.state),
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

  const engine = await input.pooledEngine.ensure({
    id: input.workspaceId,
    path: input.workspacePath,
  });
  return {
    engine,
    engineKind: "pooled",
    directory: input.workspacePath,
    spawnedByRequest: true,
    engineState: runtimeEngineStateFromEngineState(engine.state),
  };
}
