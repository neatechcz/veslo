import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeCausalGapFrames,
  findCausalGapTrace,
  summarizeTurnContinuityFrames,
} from "./turn-continuity-capture.mjs";

test("turn continuity summary remains content-free and reports queue and transcript ownership", () => {
  const frames = [
    { sequence: 1, transcript: [{ role: "assistant", messageId: "a" }], queue: [{ clientMessageId: "client-b" }] },
    { sequence: 2, transcript: [{ role: "assistant", messageId: "a" }, { role: "assistant", messageId: "b" }], queue: [] },
    { sequence: 3, transcript: [{ role: "assistant", messageId: "a" }, { role: "user", messageId: "u", clientMessageId: "client-b" }, { role: "assistant", messageId: "b" }], queue: [] },
  ];
  assert.deepEqual(summarizeTurnContinuityFrames(frames, "client-b"), {
    frameCount: 3,
    targetClientMessageId: "client-b",
    targetQueueFrameCount: 1,
    targetTranscriptFrameCount: 1,
    consecutiveAssistantFrameCount: 1,
    firstTargetQueueSequence: 1,
    firstTargetTranscriptSequence: 3,
    consecutiveAssistantSequences: [2],
  });
});

test("causal gap trace binds part-first assistant metadata to its exact later parent user", () => {
  const entries = [
    { ts: 10, at: "part", workspaceId: "ws-a", event: "session-sse:part-committed", messageID: "assistant-b", hasMessageBefore: false },
    { ts: 20, at: "assistant", workspaceId: "ws-a", event: "session-sse:message-updated", role: "assistant", messageID: "assistant-b", parentMessageID: "user-b", parentPresent: false },
    { ts: 30, at: "user", workspaceId: "ws-a", event: "session-sse:message-updated", role: "user", messageID: "user-b" },
  ];
  assert.deepEqual(findCausalGapTrace(entries, { afterTs: 5, workspaceId: "ws-a" }), {
    assistantMessageId: "assistant-b",
    parentUserMessageId: "user-b",
    partFirstAt: "part",
    assistantMetadataAt: "assistant",
    userMetadataAt: "user",
    gapMs: 10,
  });
});

test("causal gap analysis requires both consecutive assistant presentation and loss of the exact user owner", () => {
  const frames = [
    {
      sequence: 1,
      at: "2026-08-04T10:00:00.000Z",
      transcript: [{ role: "assistant", messageId: "a" }],
      queue: [{ clientMessageId: "client-b" }],
    },
    {
      sequence: 2,
      at: "2026-08-04T10:00:01.000Z",
      transcript: [{ role: "assistant", messageId: "a" }, { role: "assistant", messageId: "b" }],
      queue: [],
    },
    {
      sequence: 3,
      at: "2026-08-04T10:00:02.000Z",
      transcript: [{ role: "assistant", messageId: "a" }, { role: "user", messageId: "u" }, { role: "assistant", messageId: "b" }],
      queue: [],
    },
  ];
  assert.deepEqual(analyzeCausalGapFrames(frames, {
    assistantMessageId: "b",
    parentUserMessageId: "u",
    clientMessageId: "client-b",
  }), {
    assistantMessageId: "b",
    parentUserMessageId: "u",
    targetClientMessageId: "client-b",
    invalidVisibleFrameCount: 1,
    invalidVisibleSequences: [2],
    firstInvalidVisibleAt: "2026-08-04T10:00:01.000Z",
  });
});
