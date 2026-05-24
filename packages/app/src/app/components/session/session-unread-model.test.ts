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

test("normalizes response ids before marking unread", () => {
  const next = markUnreadAfterAssistantResponse({}, {
    responseSessionId: " session-b ",
    selectedSessionId: " session-a ",
    appFocused: true,
  });
  assert.deepEqual(keys(next), ["session-b"]);
});

test("normalizes selected session ids before deciding focused unread state", () => {
  const current = { "session-z": true } satisfies UnreadSessionMap;
  const next = markUnreadAfterAssistantResponse(current, {
    responseSessionId: "session-a",
    selectedSessionId: " session-a ",
    appFocused: true,
  });
  assert.equal(next, current);
});

test("does not clone when the normalized response session is already unread", () => {
  const current = { "session-a": true } satisfies UnreadSessionMap;
  const next = markUnreadAfterAssistantResponse(current, {
    responseSessionId: " session-a ",
    selectedSessionId: "session-b",
    appFocused: true,
  });
  assert.equal(next, current);
});

test("does not mark empty or missing response ids unread", () => {
  const current = { "session-z": true } satisfies UnreadSessionMap;

  assert.equal(markUnreadAfterAssistantResponse(current, {
    responseSessionId: null,
    selectedSessionId: "session-a",
    appFocused: false,
  }), current);
  assert.equal(markUnreadAfterAssistantResponse(current, {
    responseSessionId: undefined,
    selectedSessionId: "session-a",
    appFocused: false,
  }), current);
  assert.equal(markUnreadAfterAssistantResponse(current, {
    responseSessionId: "",
    selectedSessionId: "session-a",
    appFocused: false,
  }), current);
  assert.equal(markUnreadAfterAssistantResponse(current, {
    responseSessionId: "   ",
    selectedSessionId: "session-a",
    appFocused: false,
  }), current);
});

test("clears only the opened or focused selected session", () => {
  const current = { "session-a": true, "session-b": true } satisfies UnreadSessionMap;
  assert.deepEqual(keys(clearUnreadSession(current, "session-a")), ["session-b"]);
  assert.equal(clearUnreadSession(current, "missing"), current);
});

test("normalizes session ids before clearing unread", () => {
  const current = { "session-a": true, "session-b": true } satisfies UnreadSessionMap;
  assert.deepEqual(keys(clearUnreadSession(current, " session-a ")), ["session-b"]);
});

test("does not clear empty or missing session ids", () => {
  const current = {
    "": true,
    "   ": true,
    null: true,
    "session-a": true,
    undefined: true,
  } satisfies UnreadSessionMap;

  assert.equal(clearUnreadSession(current, null), current);
  assert.equal(clearUnreadSession(current, undefined), current);
  assert.equal(clearUnreadSession(current, ""), current);
  assert.equal(clearUnreadSession(current, "   "), current);
});

test("prunes unread ids that no longer exist", () => {
  const current = { "session-a": true, "session-b": true, "session-c": true } satisfies UnreadSessionMap;
  assert.deepEqual(keys(pruneUnreadSessions(current, new Set(["session-b", "session-c"]))), [
    "session-b",
    "session-c",
  ]);
});

test("does not clone when no unread ids are pruned", () => {
  const current = { "session-a": true, "session-b": true } satisfies UnreadSessionMap;
  const next = pruneUnreadSessions(current, new Set(["session-a", "session-b", "session-c"]));
  assert.equal(next, current);
});
