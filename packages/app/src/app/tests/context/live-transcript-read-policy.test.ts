import assert from "node:assert/strict";
import test from "node:test";

import { createLiveTranscriptReadPolicy } from "../../context/live-transcript-read-policy.js";

test("live transcript read policy does not allow reads before a send event", () => {
  const policy = createLiveTranscriptReadPolicy({
    activeWorkspaceId: () => "ws-active",
  });

  assert.equal(policy.isAllowedForWorkspace("ws-active"), false);
  assert.equal(policy.allowanceForWorkspace("ws-active"), null);
  assert.deepEqual([...policy.allowedWorkspaceIds()], []);
});

test("live transcript read policy records why a workspace became allowed", () => {
  const records: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  let now = 100;
  const policy = createLiveTranscriptReadPolicy({
    activeWorkspaceId: () => "ws-active",
    now: () => now,
    record: (event, payload) => records.push({ event, payload }),
  });

  policy.emit({
    type: "conversation-run.succeeded",
    reason: "sendPrompt:success",
    workspaceId: " ws-target ",
    sessionId: " sess-a ",
    traceId: " trace-a ",
  });
  now = 200;
  policy.emit({
    type: "conversation-compact.succeeded",
    reason: "sendPrompt:compact-success",
    workspaceId: "ws-target",
    sessionId: "sess-a",
    traceId: "trace-b",
  });

  assert.equal(policy.isAllowedForWorkspace("ws-target"), true);
  assert.deepEqual(policy.allowanceForWorkspace("ws-target"), {
    workspaceId: "ws-target",
    reason: "sendPrompt:success",
    eventType: "conversation-run.succeeded",
    sessionId: "sess-a",
    traceId: "trace-a",
    allowedAt: 100,
  });
  assert.deepEqual(records, [
    {
      event: "live-transcript-read:allowed",
      payload: {
        workspaceId: "ws-target",
        reason: "sendPrompt:success",
        eventType: "conversation-run.succeeded",
        sessionId: "sess-a",
        traceId: "trace-a",
        allowedAt: 100,
      },
    },
  ]);
});

test("live transcript read policy falls back to the active workspace and scopes by workspace", () => {
  let activeWorkspaceId = "ws-a";
  const policy = createLiveTranscriptReadPolicy({
    activeWorkspaceId: () => activeWorkspaceId,
    now: () => 50,
  });

  policy.emit({
    type: "conversation-compact.succeeded",
    reason: "sendPrompt:compact-success",
    workspaceId: null,
    sessionId: "sess-a",
    traceId: "trace-a",
  });
  activeWorkspaceId = "ws-b";

  assert.equal(policy.isAllowedForWorkspace("ws-a"), true);
  assert.equal(policy.isAllowedForWorkspace("ws-b"), false);
  assert.deepEqual([...policy.allowedWorkspaceIds()], ["ws-a"]);
  assert.deepEqual(policy.allowanceForWorkspace("ws-a"), {
    workspaceId: "ws-a",
    reason: "sendPrompt:compact-success",
    eventType: "conversation-compact.succeeded",
    sessionId: "sess-a",
    traceId: "trace-a",
    allowedAt: 50,
  });
});
