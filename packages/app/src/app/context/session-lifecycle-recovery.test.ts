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
  const selectedTranscriptRefreshes: Array<{ sessionId: string; workspaceId: string; reason: string }> = [];
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
    scheduleTranscriptIngestion: (sessionId, workspaceId, reason) => {
      transcriptIngestions.push({ sessionId, workspaceId, reason });
    },
    scheduleBackgroundTranscriptIngestion: (sessionId, workspaceId, reason) => {
      transcriptIngestions.push({ sessionId, workspaceId, reason });
    },
    refreshSelectedSessionTranscript: (sessionId, workspaceId, reason) => {
      selectedTranscriptRefreshes.push({ sessionId, workspaceId, reason });
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
  assert.deepEqual(transcriptIngestions, [
    { sessionId: "ses-a", workspaceId: "ws-a", reason: "lifecycle recovery" },
  ]);
  assert.deepEqual(selectedTranscriptRefreshes, [
    { sessionId: "ses-a", workspaceId: "ws-a", reason: "lifecycle recovery" },
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
  let selectedTranscriptRefreshCount = 0;

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
    scheduleTranscriptIngestion: () => {},
    scheduleBackgroundTranscriptIngestion: () => {},
    refreshSelectedSessionTranscript: () => {
      selectedTranscriptRefreshCount += 1;
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
  timers.shift()?.callback();
  await waitForAsyncPoll();

  assert.deepEqual(statusWrites, []);
  assert.equal(controller.activeWatchCount(), 1);
  assert.equal(timers.length, 1);

  timers.shift()?.callback();
  await waitForAsyncPoll();

  assert.deepEqual(statusWrites, ["ses-a:idle", "conv-a:idle"]);
  assert.equal(selectedTranscriptRefreshCount, 0);
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
    scheduleTranscriptIngestion: () => {},
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
