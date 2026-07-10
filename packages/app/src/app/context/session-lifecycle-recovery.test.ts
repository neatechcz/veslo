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
  const transcriptIngestions: Array<{ sessionId: string; workspaceId?: string; reason: string }> = [];
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
    scheduleBackgroundTranscriptIngestion: (sessionId, workspaceId, reason) => {
      transcriptIngestions.push({ sessionId, workspaceId, reason });
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
  assert.deepEqual(transcriptIngestions, []);
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
    scheduleBackgroundTranscriptIngestion: () => {},
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
    scheduleBackgroundTranscriptIngestion: () => {},
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
    scheduleBackgroundTranscriptIngestion: () => {},
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
    scheduleBackgroundTranscriptIngestion: () => {},
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
  const transcriptRecoveries: Array<{ sessionId: string; workspaceId: string; reason: string; delayMs?: number }> = [];
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
    scheduleBackgroundTranscriptIngestion: (sessionId, workspaceId, reason, delayMs) => {
      transcriptRecoveries.push({ sessionId, workspaceId, reason, delayMs });
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
    reason: "lifecycle latest recovery",
    delayMs: 0,
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
    scheduleBackgroundTranscriptIngestion: () => {},
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
    scheduleBackgroundTranscriptIngestion: () => {},
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
