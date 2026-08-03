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
