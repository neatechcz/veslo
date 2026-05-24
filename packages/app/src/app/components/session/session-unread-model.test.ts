import assert from "node:assert/strict";
import test from "node:test";

import {
  clearUnreadSession,
  markUnreadAfterAssistantResponse,
  pruneUnreadSessions,
  type UnreadSessionMap,
} from "./session-unread-model.js";

const keys = (value: UnreadSessionMap) => Object.keys(value).sort();

test("marks a different session unread even while the app is focused", () => {
  const next = markUnreadAfterAssistantResponse({}, {
    responseSessionId: "session-b",
    selectedSessionId: "session-a",
    appFocused: true,
  });
  assert.deepEqual(keys(next), ["session-b"]);
});

test("marks the selected session unread while the app is blurred", () => {
  const next = markUnreadAfterAssistantResponse({}, {
    responseSessionId: "session-a",
    selectedSessionId: "session-a",
    appFocused: false,
  });
  assert.deepEqual(keys(next), ["session-a"]);
});

test("does not mark the selected session unread while the app is focused", () => {
  const current = { "session-z": true } satisfies UnreadSessionMap;
  const next = markUnreadAfterAssistantResponse(current, {
    responseSessionId: "session-a",
    selectedSessionId: "session-a",
    appFocused: true,
  });
  assert.equal(next, current);
});

test("clears only the opened or focused selected session", () => {
  const current = { "session-a": true, "session-b": true } satisfies UnreadSessionMap;
  assert.deepEqual(keys(clearUnreadSession(current, "session-a")), ["session-b"]);
  assert.equal(clearUnreadSession(current, "missing"), current);
});

test("prunes unread ids that no longer exist", () => {
  const current = { "session-a": true, "session-b": true, "session-c": true } satisfies UnreadSessionMap;
  assert.deepEqual(keys(pruneUnreadSessions(current, new Set(["session-b", "session-c"]))), [
    "session-b",
    "session-c",
  ]);
});
