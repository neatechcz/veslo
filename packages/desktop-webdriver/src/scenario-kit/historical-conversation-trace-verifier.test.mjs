import assert from "node:assert/strict";
import test from "node:test";

import {
  serverTraceSettlementWaitMs,
  verifyHistoricalConversationTrace,
} from "./historical-conversation-trace-verifier.mjs";

const artifact = {
  scenario: "historical-conversation-roundtrip",
  startedAt: "2026-08-03T10:00:00.000Z",
  finishedAt: "2026-08-03T10:00:10.000Z",
  result: { seedSessionId: "seed", interludeSessionId: "interlude" },
  timeline: { steps: [{ name: "historical.continuation.submit", status: "passed", startedOffsetMs: 4_000 }] },
};

const continuationTrace = [
  { at: "2026-08-03T10:00:04.010Z", event: "server:conversation-submit-run:start", workspaceId: "ws-a", conversationId: "conv-a", opencodeSessionId: "seed", traceId: "trace-a" },
  { at: "2026-08-03T10:00:04.020Z", event: "server:conversation-run:admitted", workspaceId: "ws-a", conversationId: "conv-a", traceId: "trace-a", runId: "run-a", correlation: { causation: { queueItemId: null } } },
  { at: "2026-08-03T10:00:04.030Z", event: "server:conversation-run:opencode-submit", runId: "run-a", outcome: "ok" },
  { at: "2026-08-03T10:00:04.040Z", event: "server:conversation-run:lifecycle-reconcile", runId: "run-a", status: "completed", runtimeReadyForSuccessor: true },
];

test("historical trace verifier proves one direct continuation while retaining out-of-scope failures", () => {
  const summary = verifyHistoricalConversationTrace({
    artifact,
    traceEntries: [
      ...continuationTrace,
      { at: "2026-08-03T10:00:05.000Z", event: "server:conversation-run:queue-drain-status-error", workspaceId: "ws-other" },
    ],
  });
  assert.equal(summary.outcome, "passed");
  assert.equal(summary.scope?.runId, "run-a");
  assert.deepEqual(summary.evidence.outOfScopeFailureCounts, [{ workspaceId: "ws-other", count: 1 }]);
});

test("historical trace verifier accepts one direct continuation of an already persisted chat", () => {
  const existingArtifact = {
    ...artifact,
    scenario: "historical-existing-conversation-continuation",
    result: { historicalSessionId: "seed" },
  };
  const summary = verifyHistoricalConversationTrace({ artifact: existingArtifact, traceEntries: continuationTrace });
  assert.equal(summary.outcome, "passed");
  assert.equal(summary.scenario, "historical-existing-conversation-continuation");
});

test("historical trace verifier proves direct idle-suspend generation recovery before one successor", () => {
  const idleArtifact = {
    ...artifact,
    scenario: "historical-idle-suspend-continuation",
    result: {
      seedSessionId: "seed",
      continuationSubmitCount: 1,
      continuationOutputCount: 1,
      suspendedChildKind: "direct",
      suspendedChildExitObserved: true,
    },
  };
  const recovery = [
    { at: "2026-08-03T10:00:04.012Z", event: "server:conversation-run:terminal-handoff-recovery:start", workspaceId: "ws-a", conversationId: "conv-a", unavailableReason: "no_current_engine" },
    { at: "2026-08-03T10:00:04.014Z", event: "server:conversation-run:terminal-handoff-recovery:result", workspaceId: "ws-a", conversationId: "conv-a", outcome: "lost_proven" },
    { at: "2026-08-03T10:00:04.018Z", event: "server:conversation-run:admission-decision", workspaceId: "ws-a", conversationId: "conv-a", runId: "run-a", decision: "registered-after-proven-handoff-recovery" },
  ];
  const summary = verifyHistoricalConversationTrace({
    artifact: idleArtifact,
    traceEntries: [...continuationTrace, ...recovery],
  });
  assert.equal(summary.outcome, "passed");
  assert.equal(summary.evidence.noCurrentEngineRecoveryStarts, 1);
  assert.equal(summary.evidence.lostProvenRecoveryResults, 1);
  assert.equal(summary.evidence.recoveredAdmissions, 1);
  assert.equal(summary.evidence.recoverySequenceProven, true);
});

test("idle-suspend trace verifier rejects recovery evidence in the wrong order", () => {
  const idleArtifact = {
    ...artifact,
    scenario: "historical-idle-suspend-continuation",
    result: {
      seedSessionId: "seed",
      continuationSubmitCount: 1,
      continuationOutputCount: 1,
      suspendedChildKind: "direct",
      suspendedChildExitObserved: true,
    },
  };
  const reversedRecovery = [
    { at: "2026-08-03T10:00:04.018Z", event: "server:conversation-run:terminal-handoff-recovery:start", workspaceId: "ws-a", conversationId: "conv-a", unavailableReason: "no_current_engine" },
    { at: "2026-08-03T10:00:04.014Z", event: "server:conversation-run:terminal-handoff-recovery:result", workspaceId: "ws-a", conversationId: "conv-a", outcome: "lost_proven" },
    { at: "2026-08-03T10:00:04.012Z", event: "server:conversation-run:admission-decision", workspaceId: "ws-a", conversationId: "conv-a", runId: "run-a", decision: "registered-after-proven-handoff-recovery" },
  ];
  const summary = verifyHistoricalConversationTrace({
    artifact: idleArtifact,
    traceEntries: [...continuationTrace, ...reversedRecovery],
  });
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failures.some((failure) =>
    failure.code === "no_current_engine_recovery_sequence_not_proven"), true);
});

test("idle-suspend trace verifier rejects missing direct exit and recovery proof", () => {
  const idleArtifact = {
    ...artifact,
    scenario: "historical-idle-suspend-continuation",
    result: { seedSessionId: "seed", suspendedChildKind: "wsl", suspendedChildExitObserved: false },
  };
  const summary = verifyHistoricalConversationTrace({ artifact: idleArtifact, traceEntries: continuationTrace });
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failures.some((failure) => failure.code === "idle_suspend_child_was_not_direct"), true);
});

const provenIdleArtifact = {
  ...artifact,
  scenario: "historical-idle-suspend-continuation",
  result: {
    seedSessionId: "seed",
    continuationSubmitCount: 1,
    continuationOutputCount: 1,
    suspendedChildKind: "direct",
    suspendedChildExitObserved: true,
  },
};

const recoveryStartEntry = {
  at: "2026-08-03T10:00:04.012Z",
  event: "server:conversation-run:terminal-handoff-recovery:start",
  workspaceId: "ws-a",
  conversationId: "conv-a",
  unavailableReason: "no_current_engine",
};

test("idle-suspend trace verifier accepts a successor admitted without any recovery", () => {
  // A completed seed run can release its owner before the follow-up, so no
  // recovery is required. The stopped-engine precondition is proven separately
  // by the scenario, and the single-submit contract still applies.
  const summary = verifyHistoricalConversationTrace({
    artifact: provenIdleArtifact,
    traceEntries: [
      ...continuationTrace,
      { at: "2026-08-03T10:00:04.025Z", event: "server:conversation-run:admission-decision", workspaceId: "ws-a", conversationId: "conv-a", runId: "run-a", decision: "registered" },
    ],
  });
  assert.equal(summary.outcome, "passed");
  assert.equal(summary.evidence.recoveryAttempted, false);
});

test("idle-suspend trace verifier rejects a recovery that started but was never proven", () => {
  const summary = verifyHistoricalConversationTrace({
    artifact: provenIdleArtifact,
    traceEntries: [
      ...continuationTrace,
      recoveryStartEntry,
      { at: "2026-08-03T10:00:04.025Z", event: "server:conversation-run:admission-decision", workspaceId: "ws-a", conversationId: "conv-a", runId: "run-a", decision: "registered" },
    ],
  });
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.evidence.recoveryAttempted, true);
  assert.equal(summary.failures.some((failure) => failure.code === "terminal_handoff_recovery_not_proven"), true);
  assert.equal(summary.failures.some((failure) => failure.code === "no_current_engine_recovery_sequence_not_proven"), true);
});

test("historical trace verifier fails closed for a queued or ambiguous continuation", () => {
  const summary = verifyHistoricalConversationTrace({
    artifact,
    traceEntries: continuationTrace.map((entry) => entry.event === "server:conversation-run:admitted"
      ? { ...entry, correlation: { causation: { queueItemId: "queue-a" } } }
      : entry),
  });
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failures.some((failure) => failure.code === "continuation_was_not_directly_admitted"), true);
});

test("historical trace verifier rejects duplicate continuation submits", () => {
  const summary = verifyHistoricalConversationTrace({
    artifact,
    traceEntries: [...continuationTrace, { ...continuationTrace[0], traceId: "trace-b" }],
  });
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failures.some((failure) => failure.code === "continuation_submit_not_unique"), true);
});

test("historical trace verifier writes a failed evidence result when the server trace is unavailable", () => {
  const summary = verifyHistoricalConversationTrace({ artifact, traceEntries: [], traceReadError: true });
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failures.some((failure) => failure.code === "server_trace_unavailable"), true);
});

test("historical trace verifier waits only for the remaining bounded server settlement grace", () => {
  assert.equal(
    serverTraceSettlementWaitMs(artifact, Date.parse(artifact.finishedAt)),
    10_000,
  );
  assert.equal(
    serverTraceSettlementWaitMs(artifact, Date.parse(artifact.finishedAt) + 3_000),
    7_000,
  );
  assert.equal(
    serverTraceSettlementWaitMs(artifact, Date.parse(artifact.finishedAt) + 12_000),
    0,
  );
  assert.equal(serverTraceSettlementWaitMs({ finishedAt: "invalid" }), 0);
});
