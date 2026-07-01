import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  createConversationRunLifecycleController,
  type ConversationRunLifecycleController,
  type ConversationRunLifecycleSubmitInput,
  type ConversationRunLifecycleSnapshot,
} from "../conversation-run-lifecycle-controller.js";
import { ApiError } from "../errors.js";
import {
  OrchestratorLifecycleRequestError,
  RunAlreadyActiveError,
  type LifecycleRunStatusResult,
  type OrchestratorLifecycleClient,
} from "../orchestrator-lifecycle-client.js";
import type { ConversationRunQueueItem, ConversationRunQueueStore } from "../conversation-run-queue-store.js";
import {
  setConversationRunLifecycleControllerFactoryForTests,
  startServer,
} from "../server.js";

const tempDirs: string[] = [];
const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const envRestores: Array<() => void> = [];

afterEach(async () => {
  setConversationRunLifecycleControllerFactoryForTests(null);

  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore fixture cleanup failures
    }
  }

  while (envRestores.length > 0) {
    envRestores.pop()?.();
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

type TimerRecord = {
  id: number;
  callback: () => void;
  delayMs: number;
  cleared: boolean;
  fired: boolean;
};

class TimerHarness {
  private nextTimerId = 1;
  readonly timers: TimerRecord[] = [];

  readonly port = {
    setTimeout: (callback: () => void, delayMs: number) => {
      const timer = {
        id: this.nextTimerId++,
        callback,
        delayMs,
        cleared: false,
        fired: false,
      };
      this.timers.push(timer);
      return timer.id;
    },
    clearTimeout: (handle: unknown) => {
      const timer = this.timers.find((candidate) => candidate.id === handle);
      if (timer) timer.cleared = true;
    },
  };

  activeTimers() {
    return this.timers.filter((timer) => !timer.cleared && !timer.fired);
  }

  fire(timerId: number) {
    const timer = this.timers.find((candidate) => candidate.id === timerId);
    if (!timer) throw new Error(`Timer ${timerId} not found`);
    timer.fired = true;
    timer.callback();
  }
}

class LifecycleHarness implements OrchestratorLifecycleClient {
  activeResult: LifecycleRunStatusResult | null = null;
  activeError: unknown = null;
  registerError: unknown = null;
  readonly calls: string[] = [];

  async active(workspaceId: string, conversationId: string): Promise<LifecycleRunStatusResult | null> {
    this.calls.push(`active:${workspaceId}:${conversationId}`);
    if (this.activeError) throw this.activeError;
    return this.activeResult;
  }

  async register(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    engineSessionId: string;
    directory: string;
    kind: string;
  }): Promise<void> {
    this.calls.push(
      `register:${input.workspaceId}:${input.conversationId}:${input.runId}:${input.engineSessionId}:${input.kind}`,
    );
    if (this.registerError) throw this.registerError;
  }

  async markFailed(): Promise<void> {
    this.calls.push("markFailed");
  }

  async markAborted(): Promise<void> {
    this.calls.push("markAborted");
  }

  async markAbortRequested(): Promise<void> {
    this.calls.push("markAbortRequested");
  }

  async status(): Promise<LifecycleRunStatusResult | null> {
    this.calls.push("status");
    return null;
  }
}

class QueueHarness implements ConversationRunQueueStore {
  private nextId = 1;
  readonly items: ConversationRunQueueItem[] = [];
  readonly enqueueCalls: Array<Parameters<ConversationRunQueueStore["enqueue"]>[0]> = [];

  enqueue(input: Parameters<ConversationRunQueueStore["enqueue"]>[0]) {
    this.enqueueCalls.push(input);
    const existing = input.clientMessageId
      ? this.items.find((item) =>
        item.workspaceId === input.workspaceId &&
        item.conversationId === input.conversationId &&
        item.clientMessageId === input.clientMessageId
      )
      : null;
    if (existing) {
      return {
        item: existing,
        inserted: false,
        queuePosition: this.items.findIndex((item) => item.queueItemId === existing.queueItemId) + 1,
      };
    }
    const now = Date.now();
    const item: ConversationRunQueueItem = {
      queueItemId: `queue-${this.nextId++}`,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      opencodeSessionId: input.opencodeSessionId,
      directory: input.directory,
      reservedRunId: input.reservedRunId,
      clientMessageId: input.clientMessageId ?? null,
      origin: input.origin ?? null,
      kind: input.kind,
      bodyJson: input.bodyJson,
      state: "pending",
      activeRunId: input.activeRunId ?? null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      submittedAt: null,
      completedAt: null,
      error: null,
    };
    this.items.push(item);
    return {
      item,
      inserted: true,
      queuePosition: this.items.length,
    };
  }

  nextPending(): ConversationRunQueueItem | null {
    return null;
  }

  markStarting(): ConversationRunQueueItem | null {
    return null;
  }

  markPending(): ConversationRunQueueItem | null {
    return null;
  }

  markSubmitted(): ConversationRunQueueItem | null {
    return null;
  }

  markFailed(): ConversationRunQueueItem | null {
    return null;
  }

  pendingConversationKeys(): Array<{ workspaceId: string; conversationId: string }> {
    return [];
  }
}

function createRunTrace() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    traceId: "trace-test",
    record(event: string, payload: Record<string, unknown> = {}) {
      entries.push({ event, ...payload });
    },
    async step<T>(event: string, fn: () => Promise<T>, payload: Record<string, unknown> = {}): Promise<T> {
      entries.push({ event: `${event}:start`, ...payload });
      const result = await fn();
      entries.push({ event, ...payload });
      return result;
    },
  };
}

function submitInput(overrides: Partial<ConversationRunLifecycleSubmitInput> = {}): ConversationRunLifecycleSubmitInput {
  return {
    runTrace: createRunTrace(),
    workspace: {
      id: "ws_1",
      name: "Workspace",
      path: "/repo",
      workspaceType: "local",
    },
    target: {
      directory: "/repo",
      opencodeSessionId: "sess-a",
      conversationId: "conv-a",
    },
    runId: "run-reserved",
    kind: "prompt_async",
    body: { kind: "prompt_async", parts: [{ type: "text", text: "Hello" }] },
    clientMessageId: "msg-a",
    origin: "composer",
    expectAiGatewayStart: false,
    ...overrides,
  };
}

function controllerHarness() {
  const lifecycle = new LifecycleHarness();
  const queue = new QueueHarness();
  const submitCalls: unknown[] = [];
  const drainCalls: Array<{ workspaceId: string; conversationId: string; delayMs: number }> = [];
  const controller = createConversationRunLifecycleController({
    lifecycleClient: lifecycle,
    queueStore: queue,
    submitOpenCode: async (input) => {
      submitCalls.push(input);
      return { accepted: true };
    },
    queueDrainPollMs: 1_500,
    scheduleQueueDrain: (workspaceId, conversationId, delayMs) => {
      drainCalls.push({ workspaceId, conversationId, delayMs });
    },
  });
  return { controller, lifecycle, queue, submitCalls, drainCalls };
}

function snapshotStub(overrides: Partial<ConversationRunLifecycleSnapshot> = {}): ConversationRunLifecycleSnapshot {
  return {
    started: false,
    activeTimerCount: 0,
    diagnostics: {
      enabled: false,
      intervalMs: null,
      runs: 0,
    },
    ports: {
      lifecycleClient: false,
      queueStore: false,
      submitOpenCode: false,
      aiGatewayProviderWatch: false,
    },
    ...overrides,
  };
}

test("controller shell starts, stops, and clears diagnostics timers", () => {
  const timers = new TimerHarness();
  const traceEvents: string[] = [];
  const controller = createConversationRunLifecycleController({
    diagnostics: { intervalMs: 250 },
    timers: timers.port,
    trace: {
      record: (event) => {
        traceEvents.push(event);
      },
    },
  });

  expect(controller.snapshotForTests()).toEqual(snapshotStub({
    diagnostics: { enabled: true, intervalMs: 250, runs: 0 },
  }));

  controller.start();
  controller.start();

  expect(controller.snapshotForTests()).toEqual(snapshotStub({
    started: true,
    activeTimerCount: 1,
    diagnostics: { enabled: true, intervalMs: 250, runs: 0 },
  }));
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([250]);

  timers.fire(timers.activeTimers()[0]!.id);

  expect(controller.snapshotForTests()).toEqual(snapshotStub({
    started: true,
    activeTimerCount: 1,
    diagnostics: { enabled: true, intervalMs: 250, runs: 1 },
  }));

  controller.stop();
  controller.stop();

  expect(controller.snapshotForTests()).toEqual(snapshotStub({
    diagnostics: { enabled: true, intervalMs: 250, runs: 1 },
  }));
  expect(timers.activeTimers()).toEqual([]);
  expect(traceEvents).toEqual([
    "conversation-run-lifecycle:start",
    "conversation-run-lifecycle:diagnostics",
    "conversation-run-lifecycle:stop",
  ]);
});

test("controller shell records explicit ports without invoking behavior", () => {
  const submitCalls: unknown[] = [];
  const providerWatchCalls: unknown[] = [];
  const controller = createConversationRunLifecycleController({
    lifecycleClient: {} as never,
    queueStore: {} as never,
    submitOpenCode: async (input) => {
      submitCalls.push(input);
      return null;
    },
    aiGatewayProviderWatch: {
      waitForProviderStart: async (input) => {
        providerWatchCalls.push(input);
        return { started: false };
      },
    },
  });

  controller.start();
  controller.stop();

  expect(controller.snapshotForTests().ports).toEqual({
    lifecycleClient: true,
    queueStore: true,
    submitOpenCode: true,
    aiGatewayProviderWatch: true,
  });
  expect(submitCalls).toEqual([]);
  expect(providerWatchCalls).toEqual([]);
});

test("server stop calls the lifecycle controller stop hook", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-lifecycle-controller-workspace-"));
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-lifecycle-controller-data-"));
  tempDirs.push(workspaceRoot, dataDir);

  const previousDataDir = process.env.VESLO_DATA_DIR;
  process.env.VESLO_DATA_DIR = dataDir;
  envRestores.push(() => {
    if (previousDataDir === undefined) {
      delete process.env.VESLO_DATA_DIR;
    } else {
      process.env.VESLO_DATA_DIR = previousDataDir;
    }
  });

  let startCalls = 0;
  let stopCalls = 0;
  const fakeController: ConversationRunLifecycleController = {
    submitRun: async () => {
      throw new Error("submitRun should not be called by the shutdown fixture");
    },
    start: () => {
      startCalls += 1;
    },
    stop: () => {
      stopCalls += 1;
    },
    snapshotForTests: () => snapshotStub(),
  };
  setConversationRunLifecycleControllerFactoryForTests(() => fakeController);

  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: workspaceRoot, workspaceType: "local" },
    ],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 200,
      batchMaxBytes: 256 * 1024,
      spoolMaxBytes: 100 * 1024 * 1024,
      flushIntervalMs: 60_000,
    },
  });
  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

  expect(startCalls).toBe(1);
  server.stop(true);
  runningServers.pop();

  expect(stopCalls).toBe(1);
});

test("submitRun registers inactive local runs before submitting", async () => {
  const { controller, lifecycle, queue, submitCalls, drainCalls } = controllerHarness();

  const result = await controller.submitRun(submitInput());

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(result.payload.runId).toBe("run-reserved");
  expect(result.payload.upstream).toEqual({ accepted: true });
  expect(lifecycle.calls).toEqual([
    "active:ws_1:conv-a",
    "register:ws_1:conv-a:run-reserved:sess-a:prompt",
  ]);
  expect(queue.items).toEqual([]);
  expect(drainCalls).toEqual([]);
  expect((submitCalls[0] as { lifecycleOwner?: unknown }).lifecycleOwner).toBe(lifecycle);
});

test("submitRun queues when active peek finds an active run", async () => {
  const { controller, lifecycle, queue, submitCalls, drainCalls } = controllerHarness();
  lifecycle.activeResult = { runId: "run-active", status: "running", stale: false };

  const result = await controller.submitRun(submitInput());

  expect(result.httpStatus).toBe(202);
  expect(result.payload.status).toBe("queued");
  expect(result.payload.reservedRunId).toBe("run-reserved");
  expect(result.payload.queueItemId).toBe("queue-1");
  expect(result.payload.activeRunId).toBe("run-active");
  expect(result.payload.queuePosition).toBe(1);
  expect(lifecycle.calls).toEqual(["active:ws_1:conv-a"]);
  expect(queue.enqueueCalls[0]?.activeRunId).toBe("run-active");
  expect(submitCalls).toEqual([]);
  expect(drainCalls).toEqual([{ workspaceId: "ws_1", conversationId: "conv-a", delayMs: 1_500 }]);
});

test("submitRun queues when lifecycle register reports an active run", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.registerError = new RunAlreadyActiveError("run-active-register");

  const result = await controller.submitRun(submitInput());

  expect(result.httpStatus).toBe(202);
  expect(result.payload.status).toBe("queued");
  expect(result.payload.activeRunId).toBe("run-active-register");
  expect(lifecycle.calls).toEqual([
    "active:ws_1:conv-a",
    "register:ws_1:conv-a:run-reserved:sess-a:prompt",
  ]);
  expect(queue.items).toHaveLength(1);
  expect(submitCalls).toEqual([]);
});

test("submitRun bypasses local lifecycle and queue paths for remote workspaces", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();

  const result = await controller.submitRun(submitInput({
    workspace: {
      id: "ws_remote",
      name: "Remote",
      path: "/repo",
      workspaceType: "remote",
    },
  }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(lifecycle.calls).toEqual([]);
  expect(queue.items).toEqual([]);
  expect((submitCalls[0] as { lifecycleOwner?: unknown }).lifecycleOwner).toBeNull();
});

test("submitRun maps lifecycle request failures to the existing API error shape", async () => {
  const { controller, lifecycle } = controllerHarness();
  lifecycle.registerError = new OrchestratorLifecycleRequestError("/lifecycle", 503, { code: "down" });

  await expect(controller.submitRun(submitInput())).rejects.toMatchObject({
    status: 503,
    code: "lifecycle_unavailable",
  } satisfies Partial<ApiError>);
});

test("submitRun returns the existing queue item for an idempotent client message id", async () => {
  const { controller, lifecycle, queue } = controllerHarness();
  lifecycle.activeResult = { runId: "run-active", status: "running", stale: false };

  const first = await controller.submitRun(submitInput({ runId: "run-first" }));
  const second = await controller.submitRun(submitInput({ runId: "run-second" }));

  expect(first.httpStatus).toBe(202);
  expect(first.payload.queueItemId).toBe("queue-1");
  expect(first.payload.reservedRunId).toBe("run-first");
  expect(second.httpStatus).toBe(200);
  expect(second.payload.queueItemId).toBe("queue-1");
  expect(second.payload.reservedRunId).toBe("run-first");
  expect(queue.enqueueCalls).toHaveLength(2);
});
