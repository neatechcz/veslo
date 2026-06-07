import { createHash } from "node:crypto";

import type { EngineProcess, EngineWorkspace } from "./engine-pool.js";
import type { ReconciledRun, RunLifecycleOwner } from "./run-registry.js";
import type { RunKind, RunRecord } from "./run-store.js";

export const DEFAULT_SHARED_ENGINE_ID = "opencode-shared";

export type ExecutionMode =
  | {
      type: "shared";
      engineId?: string;
    }
  | {
      type: "sandbox";
      sandboxId?: string | null;
    };

export type ExecutionEngine = Pick<EngineProcess, "workspaceId" | "baseUrl" | "workdir">;

export type ExecutionEnginePool = {
  ensure(workspace: EngineWorkspace): Promise<ExecutionEngine>;
};

export type CreateEngineSessionInput = {
  engine: ExecutionEngine;
  workspaceId: string;
  conversationId: string;
  directory: string;
  mode: ExecutionMode;
};

export type ExecutionManagerDeps = {
  pool: ExecutionEnginePool;
  registry: RunLifecycleOwner;
  createEngineSession: (input: CreateEngineSessionInput) => Promise<string>;
};

export type StartExecutionRunInput = {
  mode: ExecutionMode;
  workspaceId: string;
  workspaceRoot: string | null | undefined;
  conversationId: string;
  runId: string;
  kind: RunKind;
};

export type StartedExecutionRun = {
  engine: ExecutionEngine;
  engineWorkspaceId: string;
  engineSessionId: string;
  sessionRoot: string;
  reusedEngineSession: boolean;
  run: RunRecord;
};

export type ExecutionManager = {
  startRun(input: StartExecutionRunInput): Promise<StartedExecutionRun>;
};

export class WorkspaceRootRequiredError extends Error {
  constructor() {
    super("workspace root is required for execution");
    this.name = "WorkspaceRootRequiredError";
  }
}

function requiredText(value: string, name: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function requiredWorkspaceRoot(value: string | null | undefined): string {
  const root = value?.trim() ?? "";
  if (!root) throw new WorkspaceRootRequiredError();
  return root;
}

function latestBinding(latest: ReconciledRun | null): {
  engineSessionId: string;
  directory: string;
} | null {
  const engineSessionId = latest?.record.engineSessionId.trim() ?? "";
  const directory = latest?.record.directory.trim() ?? "";
  if (!engineSessionId || !directory) return null;
  return { engineSessionId, directory };
}

function identityHash(parts: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

export function engineWorkspaceIdFor(input: {
  mode: ExecutionMode;
  workspaceId: string;
  sessionRoot: string;
}): string {
  if (input.mode.type === "shared") {
    const configured = input.mode.engineId?.trim();
    return configured || DEFAULT_SHARED_ENGINE_ID;
  }

  const sandboxId = input.mode.sandboxId?.trim() || input.workspaceId;
  const suffix = identityHash([input.workspaceId, sandboxId, input.sessionRoot]);
  return `opencode-sandbox-${suffix}`;
}

export function createExecutionManager(deps: ExecutionManagerDeps): ExecutionManager {
  return {
    async startRun(input) {
      const workspaceRoot = requiredWorkspaceRoot(input.workspaceRoot);
      const workspaceId = requiredText(input.workspaceId, "workspaceId");
      const conversationId = requiredText(input.conversationId, "conversationId");
      const runId = requiredText(input.runId, "runId");

      const prior = latestBinding(await deps.registry.latest(workspaceId, conversationId));
      const sessionRoot = prior?.directory ?? workspaceRoot;
      const engineWorkspaceId = engineWorkspaceIdFor({
        mode: input.mode,
        workspaceId,
        sessionRoot,
      });
      const engine = await deps.pool.ensure({ id: engineWorkspaceId, path: sessionRoot });
      const engineSessionId =
        prior?.engineSessionId ??
        await deps.createEngineSession({
          engine,
          workspaceId,
          conversationId,
          directory: sessionRoot,
          mode: input.mode,
        });

      const run = await deps.registry.register({
        workspaceId,
        conversationId,
        runId,
        engineSessionId,
        directory: sessionRoot,
        kind: input.kind,
      });

      return {
        engine,
        engineWorkspaceId,
        engineSessionId,
        sessionRoot,
        reusedEngineSession: Boolean(prior),
        run,
      };
    },
  };
}
