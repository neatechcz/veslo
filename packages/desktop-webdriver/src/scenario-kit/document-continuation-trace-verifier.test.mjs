import assert from "node:assert/strict";
import test from "node:test";

import { verifyDocumentContinuationTrace } from "./document-continuation-trace-verifier.mjs";

const artifact = {
  scenario: "first-session-document-follow-up",
  startedAt: "2026-08-04T10:00:00.000Z",
  finishedAt: "2026-08-04T10:00:12.000Z",
  result: {
    sessionId: "session-a",
    identityAdoptionMatch: "identity",
    canonicalUserMessageId: "message-document",
    followUpSubmitCount: 1,
    followUpAssistantTurnCount: 1,
  },
  timeline: {
    steps: [{ name: "document.follow-up.submit", status: "passed", startedOffsetMs: 8_000 }],
  },
};

const traceEntries = [
  { at: "2026-08-04T10:00:08.010Z", event: "server:conversation-submit-run:start", workspaceId: "ws-a", conversationId: "conv-a", opencodeSessionId: "session-a", traceId: "trace-a" },
  { at: "2026-08-04T10:00:08.020Z", event: "server:conversation-run:admitted", workspaceId: "ws-a", conversationId: "conv-a", traceId: "trace-a", runId: "run-a", correlation: { causation: { queueItemId: null } } },
  { at: "2026-08-04T10:00:08.030Z", event: "server:conversation-run:opencode-submit", runId: "run-a", outcome: "ok" },
];

test("document continuation verifier proves one server submit and one direct OpenCode dispatch", () => {
  const summary = verifyDocumentContinuationTrace({ artifact, traceEntries });
  assert.equal(summary.outcome, "passed");
  assert.equal(summary.scope?.runId, "run-a");
  assert.equal(summary.evidence.serverFollowUpStarts, 1);
});

test("document continuation verifier accepts the existing-session scenario", () => {
  const summary = verifyDocumentContinuationTrace({
    artifact: { ...artifact, scenario: "existing-session-document-follow-up" },
    traceEntries,
  });
  assert.equal(summary.outcome, "passed");
});

test("document continuation verifier rejects duplicate submits and missing identity adoption", () => {
  const summary = verifyDocumentContinuationTrace({
    artifact: {
      ...artifact,
      result: { ...artifact.result, identityAdoptionMatch: null, followUpSubmitCount: 2 },
    },
    traceEntries: [...traceEntries, { ...traceEntries[0], traceId: "trace-b" }],
  });
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.failures.some((failure) => failure.code === "canonical_identity_adoption_missing"), true);
  assert.equal(summary.failures.some((failure) => failure.code === "server_follow_up_submit_not_unique"), true);
});
