import { expect, test } from "bun:test";

import { createConversationRunCorrelation } from "../operation-correlation.js";

test("admitted conversation correlation makes only the durable run authoritative", () => {
  expect(createConversationRunCorrelation({
    admittedRunId: " run-1 ",
    clientMessageId: " msg-1 ",
    queueItemId: " queue-1 ",
    workspaceId: " ws-1 ",
    conversationId: " conv-1 ",
    origin: " session:queue-drain ",
    phase: " submitting ",
  })).toEqual({
    version: 1,
    authoritativeOperation: { kind: "conversation-run", id: "run-1" },
    causation: { clientMessageId: "msg-1", queueItemId: "queue-1" },
    scope: { workspaceId: "ws-1", conversationId: "conv-1" },
    origin: "session:queue-drain",
    phase: "submitting",
    outcome: null,
    reason: null,
  });
});

test("pre-admission queue correlation cannot promote a client or reserved run id", () => {
  expect(createConversationRunCorrelation({
    clientMessageId: "msg-1",
    queueItemId: "queue-1",
    workspaceId: "ws-1",
    conversationId: "conv-1",
    phase: "queued",
  })).toMatchObject({
    authoritativeOperation: null,
    causation: { clientMessageId: "msg-1", queueItemId: "queue-1" },
    phase: "queued",
  });
});

test("correlation drops blank and unbounded values instead of carrying arbitrary payloads", () => {
  const tooLong = "x".repeat(257);
  expect(createConversationRunCorrelation({
    admittedRunId: tooLong,
    clientMessageId: " ",
    workspaceId: "ws-1",
    origin: "x".repeat(129),
  })).toMatchObject({
    authoritativeOperation: null,
    causation: { clientMessageId: null, queueItemId: null },
    scope: { workspaceId: "ws-1", conversationId: null },
    origin: null,
  });
});
