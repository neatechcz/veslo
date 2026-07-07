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
  activeResults: Array<LifecycleRunStatusResult | null> = [];
  activeError: unknown = null;
  statusResult: LifecycleRunStatusResult | null = null;
  statusError: unknown = null;
  registerError: unknown = null;
  registerResult: LifecycleRunStatusResult | null = null;
  readonly calls: string[] = [];

  async active(workspaceId: string, conversationId: string): Promise<LifecycleRunStatusResult | null> {
    this.calls.push(`active:${workspaceId}:${conversationId}`);
    if (this.activeError) throw this.activeError;
    if (this.activeResults.length > 0) return this.activeResults.shift() ?? null;
    return this.activeResult;
  }

  async register(input: {
    workspaceId: string;
    conversationId: string;
    runId: string;
    engineSessionId: string;
    clientMessageId?: string | null;
    origin?: string | null;
    directory: string;
    kind: string;
  }): Promise<LifecycleRunStatusResult | null> {
    this.calls.push(
      `register:${input.workspaceId}:${input.conversationId}:${input.runId}:${input.engineSessionId}:${input.kind}`,
    );
    if (this.registerError) throw this.registerError;
    return this.registerResult ?? {
      runId: input.runId,
      status: "running",
      stale: false,
      clientMessageId: input.clientMessageId ?? null,
      origin: input.origin ?? null,
    };
  }

  async markFailed(workspaceId: string, runId: string, reason: string): Promise<void> {
    this.calls.push(`markFailed:${workspaceId}:${runId}:${reason}`);
  }

  async markAborted(workspaceId: string, runId: string, reason: string): Promise<void> {
    this.calls.push(`markAborted:${workspaceId}:${runId}:${reason}`);
  }

  async markAbortRequested(workspaceId: string, runId: string): Promise<void> {
    this.calls.push(`markAbortRequested:${workspaceId}:${runId}`);
  }

  async status(workspaceId: string, conversationId: string, runId: string): Promise<LifecycleRunStatusResult | null> {
    this.calls.push(`status:${workspaceId}:${conversationId}:${runId}`);
    if (this.statusError) throw this.statusError;
    return this.statusResult;
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

  nextPending(workspaceId: string, conversationId: string): ConversationRunQueueItem | null {
    return this.items.find((item) =>
      item.workspaceId === workspaceId && item.conversationId === conversationId && item.state === "pending"
    ) ?? null;
  }

  markStarting(queueItemId: string): ConversationRunQueueItem | null {
    const item = this.items.find((candidate) => candidate.queueItemId === queueItemId);
    if (!item || item.state !== "pending") return item ?? null;
    item.state = "starting";
    item.attempts += 1;
    item.startedAt = Date.now();
    item.updatedAt = item.startedAt;
    item.error = null;
    return item;
  }

  markPending(queueItemId: string, activeRunId?: string | null): ConversationRunQueueItem | null {
    const item = this.items.find((candidate) => candidate.queueItemId === queueItemId);
    if (!item || item.state !== "starting") return item ?? null;
    item.state = "pending";
    item.activeRunId = activeRunId ?? null;
    item.startedAt = null;
    item.updatedAt = Date.now();
    return item;
  }

  markSubmitted(queueItemId: string): ConversationRunQueueItem | null {
    const item = this.items.find((candidate) => candidate.queueItemId === queueItemId);
    if (!item) return null;
    const now = Date.now();
    item.state = "submitted";
    item.submittedAt = now;
    item.completedAt = now;
    item.updatedAt = now;
    return item;
  }

  markFailed(queueItemId: string, error: string): ConversationRunQueueItem | null {
    const item = this.items.find((candidate) => candidate.queueItemId === queueItemId);
    if (!item) return null;
    const now = Date.now();
    item.state = "failed";
    item.error = error;
    item.completedAt = now;
    item.updatedAt = now;
    return item;
  }

  pendingConversationKeys(): Array<{ workspaceId: string; conversationId: string }> {
    const keys = new Map<string, { workspaceId: string; conversationId: string }>();
    for (const item of this.items) {
      if (item.state !== "pending") continue;
      const key = `${item.workspaceId}\0${item.conversationId}`;
      keys.set(key, { workspaceId: item.workspaceId, conversationId: item.conversationId });
    }
    return [...keys.values()];
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
  const timers = new TimerHarness();
  const workspaces = [
    {
      id: "ws_1",
      name: "Workspace",
      path: "/repo",
      workspaceType: "local" as const,
    },
  ];
  const behavior = {
    submitError: null as unknown,
    abortError: null as unknown,
    providerStartResult: { started: true, timeoutMs: 25 },
  };
  const submitCalls: unknown[] = [];
  const activeGatewayCalls: Array<{ kind: "register" | "unregister"; input: unknown }> = [];
  const activeProxyAbortCalls: unknown[] = [];
  const providerWatchCalls: unknown[] = [];
  const abortCalls: unknown[] = [];
  const drainCalls: Array<{ workspaceId: string; conversationId: string; delayMs: number }> = [];
  const traceEntries: Array<Record<string, unknown>> = [];
  const reconcileCalls: Array<{
    workspaceId: string;
    conversationId: string;
    runId: string;
    reason: string;
    delayMs: number | undefined;
  }> = [];
  const controller = createConversationRunLifecycleController({
    lifecycleClient: lifecycle,
    queueStore: queue,
    timers: timers.port,
    resolveWorkspace: (workspaceId) => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    createBackgroundRunTrace: createRunTrace,
    submitOpenCode: async (input) => {
      submitCalls.push(input);
      if (behavior.submitError) throw behavior.submitError;
      return { accepted: true };
    },
    aiGatewayActiveRun: {
      register: (input) => {
        activeGatewayCalls.push({ kind: "register", input });
      },
      unregister: (input) => {
        activeGatewayCalls.push({ kind: "unregister", input });
      },
    },
    aiGatewayProviderWatch: {
      waitForProviderStart: async (input) => {
        providerWatchCalls.push(input);
        return behavior.providerStartResult;
      },
    },
    abortOpenCode: async (input) => {
      abortCalls.push(input);
      if (behavior.abortError) throw behavior.abortError;
      return { aborted: true };
    },
    abortActiveGatewayProxyRequests: (input) => {
      activeProxyAbortCalls.push(input);
      return [{ requestId: "proxy-1" }];
    },
    queueDrainPollMs: 1_500,
    resolveLifecycleReconcilePollMs: () => 2_000,
    resolveLifecycleReconcileMaxAttempts: () => 3,
    trace: {
      record: (event, payload = {}) => {
        traceEntries.push({ event, ...payload });
        if (event !== "conversation-run-lifecycle:start" && event !== "conversation-run-lifecycle:stop") {
          reconcileCalls.push({
            workspaceId: typeof payload.workspaceId === "string" ? payload.workspaceId : "",
            conversationId: typeof payload.conversationId === "string" ? payload.conversationId : "",
            runId: typeof payload.runId === "string" ? payload.runId : "",
            reason: typeof payload.reason === "string" ? payload.reason : event,
            delayMs: typeof payload.delayMs === "number" ? payload.delayMs : undefined,
          });
        }
      },
    },
    resolveLifecycleReconcileInitialDelayMs: () => 1_234,
  });
  return {
    controller,
    lifecycle,
    queue,
    timers,
    workspaces,
    behavior,
    submitCalls,
    activeGatewayCalls,
    activeProxyAbortCalls,
    providerWatchCalls,
    abortCalls,
    drainCalls,
    traceEntries,
    reconcileCalls,
  };
}

function enqueuePendingRun(queue: QueueHarness, overrides: Partial<Parameters<QueueHarness["enqueue"]>[0]> = {}) {
  return queue.enqueue({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    opencodeSessionId: "sess-a",
    directory: "/repo",
    reservedRunId: "run-queued",
    clientMessageId: "msg-queued",
    origin: "composer",
    kind: "prompt_async",
    bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "Queued" }] }),
    activeRunId: null,
    ...overrides,
  }).item;
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
    lifecycle: {
      pendingQueueDrains: [],
      pendingLifecycleReconciles: [],
      inFlightQueueDrains: [],
      inFlightLifecycleReconciles: [],
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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
        return { started: false, timeoutMs: 25 };
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
    submitAcceptedRun: async () => {
      throw new Error("submitAcceptedRun should not be called by the shutdown fixture");
    },
    abortRun: async () => {
      throw new Error("abortRun should not be called by the shutdown fixture");
    },
    scheduleQueueDrain: () => {
      throw new Error("scheduleQueueDrain should not be called by the shutdown fixture");
    },
    drainConversationQueue: async () => {
      throw new Error("drainConversationQueue should not be called by the shutdown fixture");
    },
    scheduleLifecycleReconcile: () => {
      throw new Error("scheduleLifecycleReconcile should not be called by the shutdown fixture");
    },
    reconcileConversationRunLifecycle: async () => {
      throw new Error("reconcileConversationRunLifecycle should not be called by the shutdown fixture");
    },
    handleTranscriptAppend: async () => {
      throw new Error("handleTranscriptAppend should not be called by the shutdown fixture");
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
  expect(submitCalls).toHaveLength(1);
});

test("submitRun queues when active peek finds an active run", async () => {
  const { controller, lifecycle, queue, submitCalls, timers } = controllerHarness();
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
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500]);
});

test("submitRun reuses active direct run when clientMessageId matches", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.activeResult = {
    runId: "run-active",
    status: "running",
    stale: false,
    clientMessageId: "msg-a",
    origin: "composer",
  };

  const result = await controller.submitRun(submitInput({ runId: "run-retry" }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(result.payload.runId).toBe("run-active");
  expect(result.payload.reusedActiveRun).toBe(true);
  expect(queue.items).toEqual([]);
  expect(submitCalls).toEqual([]);
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
    "active:ws_1:conv-a",
  ]);
  expect(queue.items).toHaveLength(1);
  expect(submitCalls).toEqual([]);
});

test("submitRun reuses active run after register conflict when clientMessageId matches", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.activeResults = [
    null,
    {
      runId: "run-active-register",
      status: "running",
      stale: false,
      clientMessageId: "msg-a",
      origin: "composer",
    },
  ];
  lifecycle.registerError = new RunAlreadyActiveError("run-active-register");

  const result = await controller.submitRun(submitInput({ runId: "run-retry" }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(result.payload.runId).toBe("run-active-register");
  expect(result.payload.reusedActiveRun).toBe(true);
  expect(lifecycle.calls).toEqual([
    "active:ws_1:conv-a",
    "register:ws_1:conv-a:run-retry:sess-a:prompt",
    "active:ws_1:conv-a",
  ]);
  expect(queue.items).toEqual([]);
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
  expect(submitCalls).toHaveLength(1);
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

test("submitRun schedules accepted lifecycle reconciliation after successful OpenCode submit", async () => {
  const { controller, reconcileCalls, activeGatewayCalls, providerWatchCalls } = controllerHarness();

  const result = await controller.submitRun(submitInput());

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(reconcileCalls).toEqual([{
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "accepted",
    delayMs: 1_234,
  }]);
  expect(activeGatewayCalls).toEqual([]);
  expect(providerWatchCalls).toEqual([]);
});

test("submitRun marks lifecycle failed, schedules reconcile, and clears active gateway context on submit failure", async () => {
  const {
    controller,
    behavior,
    lifecycle,
    activeGatewayCalls,
    providerWatchCalls,
    reconcileCalls,
  } = controllerHarness();
  behavior.submitError = new Error("opencode submit failed");

  await expect(controller.submitRun(submitInput({ expectAiGatewayStart: true }))).rejects.toThrow(
    "opencode submit failed",
  );

  expect(lifecycle.calls).toContain("markFailed:ws_1:run-reserved:opencode submit failed");
  expect(reconcileCalls).toEqual([{
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "submit-failed",
    delayMs: 0,
  }]);
  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register", "unregister"]);
  expect(providerWatchCalls).toEqual([]);
});

test("submitRun provider-start timeout records diagnostics without failing or aborting OpenCode", async () => {
  const {
    controller,
    behavior,
    lifecycle,
    activeGatewayCalls,
    providerWatchCalls,
    abortCalls,
    reconcileCalls,
  } = controllerHarness();
  behavior.providerStartResult = { started: false, timeoutMs: 25 };

  const result = await controller.submitRun(submitInput({ expectAiGatewayStart: true }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  await flushMicrotasks();
  expect(lifecycle.calls.some((call) => call.startsWith("markFailed:"))).toBe(false);
  expect(reconcileCalls).toEqual([{
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "accepted",
    delayMs: 1_234,
  }, {
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "ai-gateway-provider-start-timeout",
    delayMs: 0,
  }]);
  expect(providerWatchCalls).toHaveLength(1);
  expect(typeof (providerWatchCalls[0] as { startedAt?: unknown }).startedAt).toBe("number");
  expect(abortCalls).toEqual([]);
  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register", "unregister"]);
});

test("submitRun provider-start success clears active gateway context without aborting", async () => {
  const {
    controller,
    activeGatewayCalls,
    providerWatchCalls,
    abortCalls,
    reconcileCalls,
  } = controllerHarness();

  const result = await controller.submitRun(submitInput({
    expectAiGatewayStart: true,
    runtimeAuthorizationActorTokenHash: "request-actor-hash",
  }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  await flushMicrotasks();
  expect(providerWatchCalls).toHaveLength(1);
  expect(abortCalls).toEqual([]);
  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register", "unregister"]);
  expect(activeGatewayCalls[0]?.input).toMatchObject({
    runtimeAuthorizationActorTokenHash: "request-actor-hash",
  });
  expect(reconcileCalls).toEqual([{
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "accepted",
    delayMs: 1_234,
  }]);
});

test("queue drain keeps pending work blocked while latest lifecycle is active", async () => {
  const { controller, lifecycle, queue, submitCalls, timers } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = { runId: "run-active", status: "running", stale: false };

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]?.state).toBe("pending");
  expect(submitCalls).toEqual([]);
  expect(lifecycle.calls).toEqual(["status:ws_1:conv-a:latest"]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500]);
});

test("lifecycle reconcile keeps polling stale status until terminal", async () => {
  const { controller, lifecycle, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = { runId: "run-stale", status: "running", stale: true };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-stale",
    reason: "accepted",
  });

  expect(lifecycle.calls).toEqual(["status:ws_1:conv-a:run-stale"]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([2_000]);
});

test("lifecycle reconcile trace includes active run diagnostics", async () => {
  const { controller, lifecycle, traceEntries, workspaces } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-active",
    status: "running",
    stale: false,
    clientMessageId: "msg-a",
    origin: "session:normal",
    activityKind: "unknown",
    waitReason: "assistant_message_open",
    noProgressSeconds: 17,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-active",
    reason: "accepted",
  });

  expect(
    traceEntries.find((entry) => entry.event === "server:conversation-run:lifecycle-reconcile"),
  ).toMatchObject({
    runId: "run-active",
    status: "running",
    stale: false,
    clientMessageId: "msg-a",
    origin: "session:normal",
    activityKind: "unknown",
    waitReason: "assistant_message_open",
    noProgressSeconds: 17,
  });
});

test("queue drain submits the next pending item after terminal latest lifecycle", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = { runId: "run-terminal", status: "completed", stale: false };

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]?.state).toBe("submitted");
  expect(submitCalls).toHaveLength(1);
  expect(lifecycle.calls).toEqual([
    "status:ws_1:conv-a:latest",
    "register:ws_1:conv-a:run-queued:sess-a:prompt",
  ]);
});

test("lifecycle reconcile marks missing aborted runs as aborted and wakes queue", async () => {
  const { controller, lifecycle, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = null;

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-abort",
    reason: "abort-requested",
    abortRequested: true,
  });

  expect(lifecycle.calls).toContain(
    "markAborted:ws_1:run-abort:user abort reconciled after missing lifecycle status",
  );
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);
});

test("lifecycle reconcile marks inactive abort-requested runs as aborted and wakes queue", async () => {
  const { controller, lifecycle, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = { runId: "run-abort", status: "completed", stale: false };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-abort",
    reason: "abort-requested",
    abortRequested: true,
  });

  expect(lifecycle.calls).toContain(
    "markAborted:ws_1:run-abort:user abort reconciled after engine became inactive",
  );
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);
});

test("queue drain re-pends items when lifecycle register sees another active run", async () => {
  const { controller, lifecycle, queue, submitCalls, timers } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = null;
  lifecycle.registerError = new RunAlreadyActiveError("run-active-register");

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]?.state).toBe("pending");
  expect(queue.items[0]?.activeRunId).toBe("run-active-register");
  expect(submitCalls).toEqual([]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500]);
});

test("queue drain marks pending items failed when accepted submit fails", async () => {
  const { controller, lifecycle, queue, behavior } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = null;
  behavior.submitError = new Error("accepted submit failed");

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]?.state).toBe("failed");
  expect(queue.items[0]?.error).toBe("accepted submit failed");
});

test("stop clears queued drain and lifecycle reconcile timers", () => {
  const { controller, timers, workspaces } = controllerHarness();

  controller.scheduleQueueDrain("ws_1", "conv-a", 500);
  controller.scheduleLifecycleReconcile({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-a",
    reason: "accepted",
    delayMs: 750,
  });

  expect(controller.snapshotForTests().activeTimerCount).toBe(2);

  controller.stop();

  expect(controller.snapshotForTests().activeTimerCount).toBe(0);
  expect(timers.activeTimers()).toEqual([]);
});

test("snapshot exposes pending lifecycle timer diagnostics", () => {
  const { controller, workspaces } = controllerHarness();

  controller.scheduleQueueDrain("ws_1", "conv-a", 500);
  controller.scheduleLifecycleReconcile({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-a",
    reason: "accepted",
    delayMs: 750,
  });

  expect(controller.snapshotForTests().lifecycle).toEqual({
    pendingQueueDrains: [{ workspaceId: "ws_1", conversationId: "conv-a" }],
    pendingLifecycleReconciles: [{ workspaceId: "ws_1", conversationId: "conv-a", runId: "run-a" }],
    inFlightQueueDrains: [],
    inFlightLifecycleReconciles: [],
  });
});

test("transcript wake-up reconciles latest lifecycle and wakes queue only when terminal", async () => {
  const { controller, lifecycle, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = { runId: "run-terminal", status: "completed", stale: false };

  await controller.handleTranscriptAppend({
    workspace: workspaces[0]!,
    conversationId: " conv-a ",
    sessionId: "sess-a",
    reason: "session.idle",
    shouldReconcile: true,
  });

  expect(lifecycle.calls).toEqual(["status:ws_1:conv-a:latest"]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);
});

test("transcript wake-up does not mark terminal or wake queue while latest lifecycle is active", async () => {
  const { controller, lifecycle, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = { runId: "run-active", status: "running", stale: false };

  await controller.handleTranscriptAppend({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    sessionId: "sess-a",
    reason: "assistant-finish",
    shouldReconcile: true,
  });

  expect(lifecycle.calls).toEqual(["status:ws_1:conv-a:latest"]);
  expect(lifecycle.calls.some((call) => call.startsWith("mark"))).toBe(false);
  expect(timers.activeTimers()).toEqual([]);
});

test("transcript wake-up trace includes latest active run diagnostics", async () => {
  const { controller, lifecycle, traceEntries, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-active",
    status: "running",
    stale: false,
    clientMessageId: "msg-a",
    origin: "session:normal",
    activityKind: "unknown",
    waitReason: "assistant_message_open",
    noProgressSeconds: 19,
  };

  await controller.handleTranscriptAppend({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    sessionId: "sess-a",
    reason: "session.idle",
    shouldReconcile: true,
  });

  expect(
    traceEntries.find((entry) => entry.event === "server:conversation-run:transcript-reconcile"),
  ).toMatchObject({
    runId: "run-active",
    status: "running",
    stale: false,
    clientMessageId: "msg-a",
    origin: "session:normal",
    activityKind: "unknown",
    waitReason: "assistant_message_open",
    noProgressSeconds: 19,
  });
  expect(timers.activeTimers()).toEqual([]);
});

test("transcript wake-up ignores non-terminal transcript signals", async () => {
  const { controller, lifecycle, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = { runId: "run-terminal", status: "completed", stale: false };

  await controller.handleTranscriptAppend({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    sessionId: "sess-a",
    reason: "message.append",
    shouldReconcile: false,
  });

  expect(lifecycle.calls).toEqual([]);
  expect(timers.activeTimers()).toEqual([]);
});

test("startup schedules queue drains for pending conversation keys", () => {
  const { controller, queue, timers } = controllerHarness();
  enqueuePendingRun(queue, { conversationId: "conv-a", reservedRunId: "run-a" });
  enqueuePendingRun(queue, { conversationId: "conv-b", reservedRunId: "run-b", clientMessageId: "msg-b" });

  controller.start();

  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500, 1_500]);
});

test("abortRun aborts gateway requests, calls OpenCode abort, marks requested, and schedules reconcile", async () => {
  const {
    controller,
    lifecycle,
    workspaces,
    activeProxyAbortCalls,
    abortCalls,
    reconcileCalls,
  } = controllerHarness();

  const result = await controller.abortRun({
    workspace: workspaces[0]!,
    target: {
      directory: "/repo",
      binding: null,
      opencodeSessionId: "sess-a",
      conversationId: "conv-a",
    },
    runId: "run-abort",
  });

  expect(result).toEqual({ upstream: { aborted: true }, abortedGatewayRequestCount: 1 });
  expect(activeProxyAbortCalls).toEqual([{
    workspaceId: "ws_1",
    runId: "run-abort",
    sessionId: "sess-a",
    reason: "conversation-abort",
  }]);
  expect(abortCalls).toHaveLength(1);
  expect(lifecycle.calls).toContain("markAbortRequested:ws_1:run-abort");
  expect(lifecycle.calls).toContain(
    "markAborted:ws_1:run-abort:user abort reconciled after OpenCode abort",
  );
  expect(reconcileCalls).toContainEqual({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-abort",
    reason: "abort-requested",
    delayMs: 0,
  });
});

test("abortRun records lifecycle intent when OpenCode abort fails", async () => {
  const {
    controller,
    lifecycle,
    workspaces,
    behavior,
    activeProxyAbortCalls,
    abortCalls,
    reconcileCalls,
  } = controllerHarness();
  behavior.abortError = new Error("opencode abort failed");

  const result = await controller.abortRun({
    workspace: workspaces[0]!,
    target: {
      directory: "/repo",
      binding: null,
      opencodeSessionId: "sess-a",
      conversationId: "conv-a",
    },
    runId: "run-abort",
  });

  expect(result).toEqual({
    upstream: {
      ok: false,
      error: "opencode_abort_failed",
      message: "opencode abort failed",
    },
    abortedGatewayRequestCount: 1,
  });
  expect(activeProxyAbortCalls).toHaveLength(1);
  expect(abortCalls).toHaveLength(1);
  expect(lifecycle.calls).toContain("markAbortRequested:ws_1:run-abort");
  expect(lifecycle.calls.some((call) => call.startsWith("markAborted:"))).toBe(false);
  expect(reconcileCalls).toContainEqual({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-abort",
    reason: "abort-requested",
    delayMs: 0,
  });
});
