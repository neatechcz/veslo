import assert from "node:assert/strict";
import test from "node:test";

import { summarizeTranscriptTrace } from "./transcript-trace-summary.mjs";

test("transcript trace summary retains only causal counts and terminal classifications", () => {
  const result = summarizeTranscriptTrace([
    { ts: 10, source: "session-sse", event: "session-sse:assistant-part-updated", text: "must not appear" },
    { ts: 11, source: "session-sse", event: "session-sse:part-committed" },
    { ts: 12, source: "session-transcript", event: "session-transcript:store-write" },
    { ts: 13, source: "session-lifecycle-recovery", event: "session-lifecycle-recovery:terminal-transcript-hydrated", outcome: "hydrated", status: "completed" },
    { ts: 1, source: "session-sse", event: "session-sse:message-ignored" },
    { ts: 14, source: "other", event: "unrelated", prompt: "must not appear" },
  ], "1970-01-01T00:00:00.005Z");

  assert.equal(result.relevantEventCount, 4);
  assert.equal(result.ladder.assistantTextPartEvents, 1);
  assert.equal(result.ladder.committedPartEvents, 1);
  assert.equal(result.ladder.transcriptStoreWrites, 1);
  assert.deepEqual(result.ladder.terminalEvents, [{
    event: "session-lifecycle-recovery:terminal-transcript-hydrated",
    outcome: "hydrated",
    status: "completed",
    errorType: null,
  }]);
  assert.equal(JSON.stringify(result).includes("must not appear"), false);
});
