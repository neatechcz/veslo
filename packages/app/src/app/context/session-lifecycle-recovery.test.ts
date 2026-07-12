import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionLifecycleRecoveryController,
  type SessionLifecycleRecoveryStatus,
} from "./session-lifecycle-recovery.js";

type Timer = {
  delayMs: number;
  cleared: boolean;
  callback: () => void;
};

const waitForAsyncPoll = () => new Promise<void>((resolve) => setImmediate(resolve));

test("session lifecycle recovery clears local busy state after terminal backend status", async () => {
  const timers: Timer[] = [];
  const statuses = {
    "ws-a\0ses-a": "running",
    "ses-a": "running",
  };
  const statusWrites: Array<{ sessionId: string; status: string; workspaceId?: string | null }> = [];
  const busyWrites: Array<{ sessionId: string; status: string; workspaceId?: string }> = [];
  let readCount = 0;

  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => statuses,
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: (sessionId, workspaceIdHint) => ({
      sessionId,
      workspaceId: workspaceIdHint || "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "ses-a",
      directory: "/tmp/project-a",
      runId: "run-a",
    }),
    readConversationRunStatus: async () => {
      readCount += 1;
      return { runId: "run-a", status: "completed", stale: false };
    },
    setSessionStatusForWorkspace: (sessionId, status, workspaceId) => {
      statusWrites.push({ sessionId: sessionId ?? "", status, workspaceId });
    },
    notifySessionBusy: (sessionId, status, workspaceId) => {
      busyWrites.push({ sessionId, status, workspaceId });
    },
    scheduleTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as Timer).cleared = true;
    },
    initialDelayMs: 1,
    pollMs: 1,
  });

  controller.reconcile();
  assert.equal(timers.length, 1);
  const timer = timers.shift();
  assert.ok(timer);
  timer.callback();
  await waitForAsyncPoll();

  assert.equal(readCount, 1);
  assert.deepEqual(statusWrites.map((item) => [item.sessionId, item.status, item.workspaceId]), [
    ["ses-a", "idle", "ws-a"],
    ["conv-a", "idle", "ws-a"],
  ]);
  assert.deepEqual(busyWrites.map((item) => [item.sessionId, item.status, item.workspaceId]), [
    ["ses-a", "idle", "ws-a"],
    ["conv-a", "idle", "ws-a"],
  ]);
  assert.equal(controller.activeWatchCount(), 0);
});

test("session lifecycle recovery keeps polling stale backend statuses", async () => {
  const timers: Timer[] = [];
  const statuses = { "ws-a\0ses-a": "running" };
  const responses: SessionLifecycleRecoveryStatus[] = [
    { runId: "run-a", status: "completed", stale: true },
    { runId: "run-a", status: "completed", stale: false },
  ];
  const statusWrites: string[] = [];

  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => statuses,
    selectedSessionId: () => null,
    resolveConversationRunForSession: (sessionId, workspaceIdHint) => ({
      sessionId,
      workspaceId: workspaceIdHint || "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "ses-a",
      runId: "run-a",
    }),
    readConversationRunStatus: async () => responses.shift() ?? null,
    setSessionStatusForWorkspace: (sessionId, status) => {
      statusWrites.push(`${sessionId}:${status}`);
    },
    notifySessionBusy: () => {},
    scheduleTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as Timer).cleared = true;
    },
    initialDelayMs: 1,
    pollMs: 1,
  });

  controller.reconcile();
  timers.shift()?.callback();
  await waitForAsyncPoll();

  assert.deepEqual(statusWrites, []);
  assert.equal(controller.activeWatchCount(), 1);
  assert.equal(timers.length, 1);

  timers.shift()?.callback();
  await waitForAsyncPoll();

  assert.deepEqual(statusWrites, ["ses-a:idle", "conv-a:idle"]);
  assert.equal(controller.activeWatchCount(), 0);
});

test("session lifecycle recovery reports active no-progress diagnostics", async () => {
  const timers: Timer[] = [];
  const diagnostics: Array<{
    scopeSessionId: string;
    status: SessionLifecycleRecoveryStatus | null;
  }> = [];

  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => ({ "ws-a\0ses-a": "running" }),
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: (sessionId, workspaceIdHint) => ({
      sessionId,
      workspaceId: workspaceIdHint || "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "ses-a",
      runId: "run-a",
    }),
    readConversationRunStatus: async () => ({
      runId: "run-a",
      status: "running",
      stale: false,
      activityKind: "model_retry",
      waitReason: "model_retry_no_output",
      lastUsefulProgressAt: 1_000,
      retrySince: 2_000,
      noProgressSeconds: 12,
    }),
    onConversationRunStatus: (scope, status) => {
      diagnostics.push({ scopeSessionId: scope.sessionId, status });
    },
    setSessionStatusForWorkspace: () => {},
    notifySessionBusy: () => {},
    scheduleTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as Timer).cleared = true;
    },
    initialDelayMs: 1,
    pollMs: 1,
  });

  controller.reconcile();
  timers.shift()?.callback();
  await waitForAsyncPoll();

  assert.equal(controller.activeWatchCount(), 1);
  assert.deepEqual(diagnostics, [{
    scopeSessionId: "ses-a",
    status: {
      runId: "run-a",
      status: "running",
      stale: false,
      activityKind: "model_retry",
      waitReason: "model_retry_no_output",
      lastUsefulProgressAt: 1_000,
      retrySince: 2_000,
      noProgressSeconds: 12,
    },
  }]);
});

test("session lifecycle recovery keeps an admitted watch after engine idle and waits for durable failure", async () => {
  const timers: Timer[] = [];
  const statuses = { "ws-a\0ses-a": "running" };
  const responses: SessionLifecycleRecoveryStatus[] = [
    { runId: "run-a", status: "running", stale: false },
    { runId: "run-a", status: "failed", stale: false, error: "sanitized failure" },
  ];
  const terminals: SessionLifecycleRecoveryStatus[] = [];
  const statusWrites: string[] = [];

  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => statuses,
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: (sessionId, workspaceIdHint) => ({
      sessionId,
      workspaceId: workspaceIdHint || "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "ses-a",
      runId: "run-a",
    }),
    readConversationRunStatus: async () => responses.shift() ?? null,
    onConversationRunTerminal: (_scope, status) => terminals.push(status),
    setSessionStatusForWorkspace: (sessionId, status) => statusWrites.push(`${sessionId}:${status}`),
    notifySessionBusy: () => {},
    scheduleTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as Timer).cleared = true;
    },
    initialDelayMs: 50,
    pollMs: 50,
  });

  controller.reconcile();
  assert.equal(controller.activeWatchCount(), 1);
  statuses["ws-a\0ses-a"] = "idle";
  controller.reconcile();
  assert.equal(controller.activeWatchCount(), 1);

  assert.equal(controller.observeSessionLifecycleEvent("ses-a", "ws-a", "session.error"), true);
  await waitForAsyncPoll();
  assert.equal(controller.activeWatchCount(), 1);
  assert.equal(terminals.length, 0);

  assert.equal(controller.observeSessionLifecycleEvent("ses-a", "ws-a", "session.error"), true);
  await waitForAsyncPoll();
  assert.deepEqual(terminals, [{
    runId: "run-a",
    status: "failed",
    stale: false,
    error: "sanitized failure",
  }]);
  assert.deepEqual(statusWrites, ["ses-a:idle", "conv-a:idle"]);
  assert.equal(controller.activeWatchCount(), 0);
});

test("session lifecycle recovery keeps a durable queued run submitted through engine idle", async () => {
  const statuses: Record<string, string> = { "ws-a\0ses-a": "running" };
  const statusWrites: string[] = [];
  const busyWrites: string[] = [];
  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => statuses,
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: (sessionId, workspaceIdHint) => ({
      sessionId,
      workspaceId: workspaceIdHint || "ws-a",
      conversationId: "conv-a",
      opencodeSessionId: "ses-a",
      runId: "run-queued",
    }),
    readConversationRunStatus: async () => ({ runId: "run-queued", status: "queued", stale: false }),
    setSessionStatusForWorkspace: (sessionId, status, workspaceId) => {
      const key = `${workspaceId || "ws-a"}\0${sessionId}`;
      statuses[key] = status;
      statusWrites.push(`${sessionId}:${status}`);
    },
    notifySessionBusy: (sessionId, status) => busyWrites.push(`${sessionId}:${status}`),
  });

  controller.reconcile();
  statuses["ws-a\0ses-a"] = "idle";
  controller.reconcile();

  assert.equal(controller.observeSessionLifecycleEvent("ses-a", "ws-a", "session.idle"), true);
  await waitForAsyncPoll();

  assert.deepEqual(statusWrites, ["ses-a:submitted", "conv-a:submitted"]);
  assert.deepEqual(busyWrites, ["ses-a:submitted", "conv-a:submitted"]);
  assert.equal(statuses["ws-a\0ses-a"], "submitted");
  assert.equal(controller.activeWatchCount(), 1);
});

test("selected exact conversation probes latest once after reload and restores durable failure", async () => {
  let reads = 0;
  const terminals: Array<{ runId: string; status: string; error?: string | null }> = [];
  const transcriptRecoveries: Array<{ sessionId: string; workspaceId: string; directory?: string | null; expectedRunId?: string | null }> = [];
  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => ({ "ws-a\0ses-a": "idle" }),
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: (_sessionId, _workspaceIdHint, options) => options?.allowLatest
      ? {
          sessionId: "ses-a",
          workspaceId: "ws-a",
          conversationId: "conv-a",
          opencodeSessionId: "ses-a",
          runId: "latest",
        }
      : null,
    readConversationRunStatus: async () => {
      reads += 1;
      return { runId: "run-failed", status: "failed", stale: false, error: "restored failure" };
    },
    onConversationRunTerminal: (scope, status) => terminals.push({
      runId: scope.runId,
      status: status.status,
      error: status.error,
    }),
    setSessionStatusForWorkspace: () => {},
    notifySessionBusy: () => {},
    recoverConversationTranscript: async (input) => {
      transcriptRecoveries.push(input);
      return {
        workspaceId: "ws-a",
        sessionId: "ses-a",
        limit: 140,
        messages: [],
        partsByMessageId: {},
        source: "sqlite",
      };
    },
  });

  assert.equal(await controller.probeSelectedConversationLatestRun(), true);
  assert.equal(await controller.probeSelectedConversationLatestRun(), false);
  assert.equal(reads, 1);
  assert.deepEqual(terminals, [{
    runId: "run-failed",
    status: "failed",
    error: "restored failure",
  }]);
  assert.deepEqual(transcriptRecoveries, [{
    sessionId: "ses-a",
    workspaceId: "ws-a",
    directory: undefined,
    expectedRunId: "run-failed",
  }]);
});

test("terminal lifecycle truth remains available after its watch is released", async () => {
  const timers: Timer[] = [];
  const diagnostics: Array<SessionLifecycleRecoveryStatus | null> = [];
  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => ({ "ws-a\0ses-a": "running" }),
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: () => ({
      sessionId: "ses-a",
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: "run-a",
    }),
    readConversationRunStatus: async () => ({
      runId: "run-a",
      status: "failed",
      stale: false,
      error: "durable failure",
    }),
    onConversationRunStatus: (_scope, status) => diagnostics.push(status),
    setSessionStatusForWorkspace: () => {},
    notifySessionBusy: () => {},
    scheduleTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as Timer).cleared = true;
    },
    initialDelayMs: 0,
  });

  controller.reconcile();
  timers.shift()?.callback();
  await waitForAsyncPoll();

  assert.equal(controller.activeWatchCount(), 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.status, "failed");
});

test("a superseded in-flight lifecycle poll cannot terminalize its replacement", async () => {
  const timers: Timer[] = [];
  const terminals: string[] = [];
  const statusWrites: string[] = [];
  let currentRunId = "run-old";
  let resolveOldPoll!: (status: SessionLifecycleRecoveryStatus) => void;
  const oldPoll = new Promise<SessionLifecycleRecoveryStatus>((resolve) => {
    resolveOldPoll = resolve;
  });
  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => ({ "ws-a\0ses-a": "running" }),
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: () => ({
      sessionId: "ses-a",
      workspaceId: "ws-a",
      conversationId: "conv-a",
      runId: currentRunId,
    }),
    readConversationRunStatus: (scope) => scope.runId === "run-old"
      ? oldPoll
      : Promise.resolve({ runId: "run-new", status: "running", stale: false }),
    onConversationRunTerminal: (scope) => terminals.push(scope.runId),
    setSessionStatusForWorkspace: (sessionId, status) => statusWrites.push(`${sessionId}:${status}`),
    notifySessionBusy: () => {},
    scheduleTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as Timer).cleared = true;
    },
    initialDelayMs: 0,
  });

  controller.reconcile();
  timers.shift()?.callback();
  currentRunId = "run-new";
  controller.reconcile();
  const settleOldPoll = resolveOldPoll as unknown as (status: SessionLifecycleRecoveryStatus) => void;
  settleOldPoll({ runId: "run-old", status: "failed", stale: false, error: "old failure" });
  await waitForAsyncPoll();

  assert.deepEqual(terminals, []);
  assert.deepEqual(statusWrites, []);
  assert.equal(controller.activeWatchCount(), 1);
});

test("accepted run admission watches idle UI state and hydrates the selected terminal transcript", async () => {
  const statuses: string[] = [];
  const recoveries: string[] = [];
  const hydrated: string[] = [];
  let reads = 0;
  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => ({ "ws-a\0ses-ui": "idle" }),
    selectedSessionId: () => "ses-ui",
    resolveConversationRunForSession: () => null,
    readConversationRunStatus: async (scope) => {
      reads += 1;
      assert.equal(scope.runId, "run-a");
      return { runId: "run-a", status: "completed", stale: false, clientMessageId: "msg-a" };
    },
    recoverConversationTranscript: async (scope) => {
      recoveries.push(`${scope.workspaceId}:${scope.sessionId}:${scope.expectedRunId}`);
      return {
        workspaceId: "ws-a",
        sessionId: "ses-open",
        limit: 140,
        messages: [],
        partsByMessageId: {},
        source: "sqlite",
      };
    },
    hydrateConversationTranscript: (snapshot) => hydrated.push(snapshot.sessionId),
    setSessionStatusForWorkspace: (sessionId, status) => statuses.push(`${sessionId}:${status}`),
    notifySessionBusy: () => {},
  });

  assert.equal(controller.admitAcceptedConversationRun({
    sessionId: "ses-ui",
    workspaceId: "ws-a",
    conversationId: "conv-a",
    opencodeSessionId: "ses-open",
    directory: "/tmp/a",
    runId: "run-a",
    clientMessageId: "msg-a",
  }), true);
  await waitForAsyncPoll();
  await waitForAsyncPoll();

  assert.equal(reads, 1);
  assert.deepEqual(recoveries, ["ws-a:ses-open:run-a"]);
  assert.deepEqual(hydrated, ["ses-ui"]);
  assert.ok(statuses.includes("ses-ui:submitted"));
  assert.ok(statuses.includes("ses-ui:idle"));
  assert.equal(controller.activeWatchCount(), 0);

  controller.admitAcceptedConversationRun({
    sessionId: "ses-ui",
    workspaceId: "ws-a",
    conversationId: "conv-a",
    opencodeSessionId: "ses-open",
    directory: "/tmp/a",
    runId: "run-a",
    clientMessageId: "msg-a",
  });
  await waitForAsyncPoll();
  assert.equal(reads, 1);
  assert.deepEqual(hydrated, ["ses-ui"]);
});

test("terminal transcript recovery failure is traced and can retry through the existing latest probe", async () => {
  const traces: string[] = [];
  const hydrated: string[] = [];
  let recoveries = 0;
  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => ({}),
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: (_sessionId, _workspaceId, options) => options?.allowLatest
      ? {
          sessionId: "ses-a",
          workspaceId: "ws-a",
          conversationId: "conv-a",
          opencodeSessionId: "ses-a",
          directory: "/tmp/a",
          runId: "latest",
        }
      : null,
    readConversationRunStatus: async () => ({ runId: "run-a", status: "completed", stale: false }),
    recoverConversationTranscript: async () => {
      recoveries += 1;
      if (recoveries === 1) throw new Error("transient recovery failure");
      return {
        workspaceId: "ws-a",
        sessionId: "ses-a",
        limit: 140,
        messages: [],
        partsByMessageId: {},
        source: "sqlite",
      };
    },
    hydrateConversationTranscript: (snapshot) => hydrated.push(snapshot.sessionId),
    setSessionStatusForWorkspace: () => {},
    notifySessionBusy: () => {},
    trace: (event) => traces.push(event),
  });

  controller.admitAcceptedConversationRun({
    sessionId: "ses-a",
    workspaceId: "ws-a",
    conversationId: "conv-a",
    opencodeSessionId: "ses-a",
    directory: "/tmp/a",
    runId: "run-a",
    clientMessageId: "msg-a",
  });
  await waitForAsyncPoll();
  await waitForAsyncPoll();

  assert.equal(recoveries, 1);
  assert.ok(traces.includes("session-lifecycle-recovery:terminal-transcript-error"));
  assert.equal(await controller.probeSelectedConversationLatestRun(), true);
  await waitForAsyncPoll();

  assert.equal(recoveries, 2);
  assert.deepEqual(hydrated, ["ses-a"]);
});

test("latest probe releases its dedupe after a transient status failure", async () => {
  let reads = 0;
  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => ({}),
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: (_sessionId, _workspaceId, options) => options?.allowLatest
      ? {
          sessionId: "ses-a",
          workspaceId: "ws-a",
          conversationId: "conv-a",
          runId: "latest",
        }
      : null,
    readConversationRunStatus: async () => {
      reads += 1;
      if (reads === 1) throw new Error("runtime still starting");
      return null;
    },
    setSessionStatusForWorkspace: () => {},
    notifySessionBusy: () => {},
  });

  assert.equal(await controller.probeSelectedConversationLatestRun(), true);
  assert.equal(await controller.probeSelectedConversationLatestRun(), true);
  assert.equal(reads, 2);
});

test("accepted run exhaustion stays explicit and resumes only on a relevant trigger", async () => {
  const diagnostics: Array<SessionLifecycleRecoveryStatus | null> = [];
  const readScopes: string[] = [];
  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => ({ "ws-a\0ses-a": "idle" }),
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: () => null,
    readConversationRunStatus: async (scope) => {
      readScopes.push(`${scope.workspaceId}:${scope.runId}`);
      return { runId: "run-a", status: "running", stale: false };
    },
    onConversationRunStatus: (_scope, status) => diagnostics.push(status),
    setSessionStatusForWorkspace: () => {},
    notifySessionBusy: () => {},
    maxAttempts: 1,
  });

  controller.admitAcceptedConversationRun({
    sessionId: "ses-a",
    workspaceId: "ws-a",
    conversationId: "conv-a",
    opencodeSessionId: "ses-a",
    runId: "run-a",
    clientMessageId: "msg-a",
  });
  await waitForAsyncPoll();

  assert.deepEqual(readScopes, ["ws-a:run-a"]);
  assert.equal(controller.activeWatchCount(), 0);
  assert.equal(diagnostics.at(-1)?.status, "running");
  assert.equal(diagnostics.at(-1)?.recoveryState, "exhausted");

  assert.equal(controller.resumeExhaustedWatchForSession("ses-b", "ws-a"), 0);
  assert.deepEqual(readScopes, ["ws-a:run-a"]);

  controller.admitAcceptedConversationRun({
    sessionId: "ses-a",
    workspaceId: "ws-b",
    conversationId: "conv-b",
    opencodeSessionId: "ses-a",
    runId: "run-b",
    clientMessageId: "msg-b",
  });
  await waitForAsyncPoll();
  assert.deepEqual(readScopes, ["ws-a:run-a", "ws-b:run-b"]);

  assert.equal(controller.resumeExhaustedWatchForSession("ses-a", "ws-a"), 1);
  await waitForAsyncPoll();
  assert.deepEqual(readScopes, ["ws-a:run-a", "ws-b:run-b", "ws-a:run-a"]);
});

test("a newer admitted run fences late transcript hydration from the old run", async () => {
  let resolveOldRecovery!: (snapshot: {
    workspaceId: string;
    sessionId: string;
    limit: number;
    messages: [];
    partsByMessageId: {};
    source: "sqlite";
  }) => void;
  const oldRecovery = new Promise<{
    workspaceId: string;
    sessionId: string;
    limit: number;
    messages: [];
    partsByMessageId: {};
    source: "sqlite";
  }>((resolve) => {
    resolveOldRecovery = resolve;
  });
  const hydrated: string[] = [];
  const controller = createSessionLifecycleRecoveryController({
    sessionStatusById: () => ({}),
    selectedSessionId: () => "ses-a",
    resolveConversationRunForSession: () => null,
    readConversationRunStatus: async (scope) => ({
      runId: scope.runId,
      status: scope.runId === "run-old" ? "completed" : "running",
      stale: false,
    }),
    recoverConversationTranscript: async (scope) => scope.expectedRunId === "run-old"
      ? oldRecovery
      : null,
    hydrateConversationTranscript: (snapshot) => hydrated.push(snapshot.sessionId),
    setSessionStatusForWorkspace: () => {},
    notifySessionBusy: () => {},
  });

  controller.admitAcceptedConversationRun({
    sessionId: "ses-a",
    workspaceId: "ws-a",
    conversationId: "conv-a",
    opencodeSessionId: "ses-a",
    runId: "run-old",
    clientMessageId: "msg-old",
  });
  await waitForAsyncPoll();
  controller.admitAcceptedConversationRun({
    sessionId: "ses-a",
    workspaceId: "ws-a",
    conversationId: "conv-a",
    opencodeSessionId: "ses-a",
    runId: "run-new",
    clientMessageId: "msg-new",
  });
  resolveOldRecovery({
    workspaceId: "ws-a",
    sessionId: "ses-old",
    limit: 140,
    messages: [],
    partsByMessageId: {},
    source: "sqlite",
  });
  await waitForAsyncPoll();

  assert.deepEqual(hydrated, []);
  assert.equal(controller.activeWatchCount(), 1);
});
