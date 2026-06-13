import type { EngineProcess, EngineWorkspace } from "./engine-pool.js";
import type { EngineTopologyMode } from "./engine-topology.js";
import type { SharedOpenCodeEngine } from "./shared-opencode-engine.js";

export type PooledOpenCodeEngine = {
  getRunning: (workspaceId: string) => EngineProcess | null;
  ensure: (workspace: EngineWorkspace) => Promise<EngineProcess>;
};

export type SharedOpenCodeEngineLike = Pick<
  SharedOpenCodeEngine,
  "getRunning" | "ensureStarted"
>;

export type OpenCodeProxyTarget = {
  engine: EngineProcess | null;
  engineKind: "pooled" | "shared";
  directory: string;
  spawnedByRequest: boolean;
};

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
      return {
        engine: input.sharedEngine.getRunning(),
        engineKind: "shared",
        directory: input.workspacePath,
        spawnedByRequest: false,
      };
    }
    return {
      engine: await input.sharedEngine.ensureStarted(`proxy ${method} ${input.workspaceId}`),
      engineKind: "shared",
      directory: input.workspacePath,
      spawnedByRequest: true,
    };
  }

  if (isReadOnlyProbe) {
    return {
      engine: input.pooledEngine.getRunning(input.workspaceId),
      engineKind: "pooled",
      directory: input.workspacePath,
      spawnedByRequest: false,
    };
  }

  return {
    engine: await input.pooledEngine.ensure({
      id: input.workspaceId,
      path: input.workspacePath,
    }),
    engineKind: "pooled",
    directory: input.workspacePath,
    spawnedByRequest: true,
  };
}
