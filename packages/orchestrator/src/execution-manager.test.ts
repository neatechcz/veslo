import { describe, expect, test } from "bun:test";

import {
  createExecutionManager,
  WorkspaceRootRequiredError,
  type ExecutionEngine,
  type ExecutionMode,
} from "./execution-manager.js";
import type { RunKind, RunRecord } from "./run-store.js";
import type { ReconciledRun, RunLifecycleOwner } from "./run-registry.js";

type EnsureCall = {
  id: string;
  path?: string;
};

type RegisterCall = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  engineSessionId: string;
  directory: string;
  kind: RunKind;
};

type CreateSessionCall = {
  engineWorkspaceId: string;
  directory: string;
  workspaceId: string;
  conversationId: string;
};

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    workspaceId: "ws-a",
    conversationId: "conv-a",
    runId: "run-a",
    engineSessionId: "session-a",
    directory: "/repo/a",
    kind: "prompt",
    status: "completed",
    abortRequested: false,
    createdAt: 1,
    startedAt: 1,
    completedAt: 2,
    error: null,
    ...overrides,
  };
}

function createHarness(options: {
  latestByConversation?: Record<string, ReconciledRun | null>;
} = {}) {
  const ensureCalls: EnsureCall[] = [];
  const registerCalls: RegisterCall[] = [];
  const createSessionCalls: CreateSessionCall[] = [];
  const engines = new Map<string, ExecutionEngine>();
  let nextSession = 1;

  const pool = {
    async ensure(input: EnsureCall): Promise<ExecutionEngine> {
      ensureCalls.push({ ...input });
      const existing = engines.get(input.id);
      if (existing) return existing;
      const engine: ExecutionEngine = {
        workspaceId: input.id,
        baseUrl: `http://engine/${encodeURIComponent(input.id)}`,
        workdir: input.path ?? "",
      };
      engines.set(input.id, engine);
      return engine;
    },
  };

  const registry: RunLifecycleOwner = {
    async register(input) {
      registerCalls.push({ ...input });
      return runRecord(input);
    },
    markFailed() {
      return null;
    },
    markAbortRequested() {
      return null;
    },
    async get() {
      return null;
    },
    async latest(workspaceId, conversationId) {
      return options.latestByConversation?.[`${workspaceId}:${conversationId}`] ?? null;
    },
  };

  const manager = createExecutionManager({
    pool,
    registry,
    createEngineSession: async (input) => {
      createSessionCalls.push({
        engineWorkspaceId: input.engine.workspaceId,
        directory: input.directory,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
      });
      return `new-session-${nextSession++}`;
    },
  });

  return {
    manager,
    ensureCalls,
    registerCalls,
    createSessionCalls,
  };
}

const sharedMode: ExecutionMode = { type: "shared" };
const sandboxMode = (sandboxId: string): ExecutionMode => ({ type: "sandbox", sandboxId });

describe("execution manager", () => {
  test("routes different unsandboxed workspaces through the same shared engine", async () => {
    const h = createHarness();

    const first = await h.manager.startRun({
      mode: sharedMode,
      workspaceId: "ws-a",
      workspaceRoot: "/repo/a",
      conversationId: "conv-a",
      runId: "run-a",
      kind: "prompt",
    });
    const second = await h.manager.startRun({
      mode: sharedMode,
      workspaceId: "ws-b",
      workspaceRoot: "/repo/b",
      conversationId: "conv-b",
      runId: "run-b",
      kind: "prompt",
    });

    expect(second.engine).toBe(first.engine);
    expect(h.ensureCalls.map((call) => call.id)).toEqual([
      "opencode-shared",
      "opencode-shared",
    ]);
    expect(h.createSessionCalls.map((call) => call.directory)).toEqual([
      "/repo/a",
      "/repo/b",
    ]);
    expect(h.registerCalls.map((call) => call.directory)).toEqual([
      "/repo/a",
      "/repo/b",
    ]);
  });

  test("routes sandboxed workspaces through isolated engines by sandbox identity", async () => {
    const h = createHarness();

    const first = await h.manager.startRun({
      mode: sandboxMode("sandbox-a"),
      workspaceId: "ws-a",
      workspaceRoot: "/repo/a",
      conversationId: "conv-a",
      runId: "run-a",
      kind: "prompt",
    });
    const second = await h.manager.startRun({
      mode: sandboxMode("sandbox-b"),
      workspaceId: "ws-b",
      workspaceRoot: "/repo/b",
      conversationId: "conv-b",
      runId: "run-b",
      kind: "prompt",
    });

    expect(second.engine).not.toBe(first.engine);
    expect(h.ensureCalls[0]?.id).not.toBe(h.ensureCalls[1]?.id);
    expect(h.ensureCalls.map((call) => call.path)).toEqual(["/repo/a", "/repo/b"]);
    expect(h.createSessionCalls.map((call) => call.engineWorkspaceId)).toEqual(
      h.ensureCalls.map((call) => call.id),
    );
  });

  test("throws an explicit error when workspace root is missing", async () => {
    const h = createHarness();

    await expect(h.manager.startRun({
      mode: sharedMode,
      workspaceId: "ws-a",
      workspaceRoot: "  ",
      conversationId: "conv-a",
      runId: "run-a",
      kind: "prompt",
    })).rejects.toThrow(WorkspaceRootRequiredError);

    expect(h.ensureCalls).toEqual([]);
    expect(h.createSessionCalls).toEqual([]);
    expect(h.registerCalls).toEqual([]);
  });

  test("keeps the first bound session root for later runs in the same conversation", async () => {
    const h = createHarness({
      latestByConversation: {
        "ws-a:conv-a": {
          stale: false,
          record: runRecord({
            workspaceId: "ws-a",
            conversationId: "conv-a",
            runId: "run-first",
            engineSessionId: "session-first",
            directory: "/repo/original",
          }),
        },
      },
    });

    const result = await h.manager.startRun({
      mode: sharedMode,
      workspaceId: "ws-a",
      workspaceRoot: "/repo/selected-later",
      conversationId: "conv-a",
      runId: "run-second",
      kind: "prompt",
    });

    expect(result.sessionRoot).toBe("/repo/original");
    expect(result.engineSessionId).toBe("session-first");
    expect(result.reusedEngineSession).toBe(true);
    expect(h.createSessionCalls).toEqual([]);
    expect(h.ensureCalls).toEqual([{ id: "opencode-shared", path: "/repo/original" }]);
    expect(h.registerCalls).toEqual([
      {
        workspaceId: "ws-a",
        conversationId: "conv-a",
        runId: "run-second",
        engineSessionId: "session-first",
        directory: "/repo/original",
        kind: "prompt",
      },
    ]);
  });
});
