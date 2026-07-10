import assert from "node:assert/strict";
import test from "node:test";

import type { Part, Session } from "@opencode-ai/sdk/v2/client";

import {
  applyCommandDisplayAlias,
  appendSessionErrorTurnModel,
  createPlaceholderMessage,
  formatSlashCommandDisplay,
  readSessionErrorTurnsForScope,
  removeMessageInfo,
  removePartInfo,
  removeSession,
  scopedSessionAliasKeys,
  sessionErrorTurnScopeKey,
  sortMessagesByActivity,
  sortSessionsByActivity,
  upsertMessageInfo,
  upsertPartInfo,
  upsertSession,
} from "../../context/session-store-model.js";
import type { MessageInfo } from "../../types";

const makeSession = (id: string, created: number, updated?: number): Session =>
  ({
    id,
    title: id,
    time: { created, updated },
  }) as Session;

const makeMessage = (id: string, created: number, sessionID = "sess-a"): MessageInfo =>
  ({
    id,
    sessionID,
    role: "assistant",
    time: { created },
    parentID: "",
    modelID: "",
    providerID: "",
    mode: "",
    agent: "",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as MessageInfo;

test("lifecycle diagnostics and error turns use workspace-scoped keys", () => {
  assert.deepEqual(
    scopedSessionAliasKeys("ws-a", ["sess-a", "open-a", "sess-a", "conv-a"]),
    ["ws-a\0sess-a", "ws-a\0open-a", "ws-a\0conv-a"],
  );
  assert.equal(sessionErrorTurnScopeKey("ws-a", "sess-a"), "ws-a\0sess-a");
  assert.equal(sessionErrorTurnScopeKey("ws-b", "sess-a"), "ws-b\0sess-a");

  const legacyUnscoped = [{ id: "legacy", sessionID: "sess-a", text: "legacy", afterMessageID: null, time: 1 }];
  const workspaceA = [{ id: "a", sessionID: "sess-a", text: "a", afterMessageID: null, time: 2 }];
  const turns = {
    "sess-a": legacyUnscoped,
    "ws-a\0sess-a": workspaceA,
  };
  assert.deepEqual(readSessionErrorTurnsForScope(turns, "ws-a", "sess-a"), workspaceA);
  assert.deepEqual(readSessionErrorTurnsForScope(turns, "ws-b", "sess-a"), []);
  assert.deepEqual(readSessionErrorTurnsForScope(turns, null, "sess-a"), legacyUnscoped);
});

const makeUserMessage = (id: string, created: number, sessionID = "sess-a"): MessageInfo =>
  ({
    ...makeMessage(id, created, sessionID),
    role: "user",
  }) as MessageInfo;

const makeTextPart = (id: string, messageID = "msg-a", text = "original"): Part =>
  ({
    id,
    sessionID: "sess-a",
    messageID,
    type: "text",
    text,
    synthetic: false,
    ignored: false,
  }) as Part;

const makeToolPart = (id: string, messageID = "msg-a"): Part =>
  ({
    id,
    sessionID: "sess-a",
    messageID,
    type: "tool",
    tool: "read",
    state: {},
  }) as unknown as Part;

test("session and message upserts preserve deterministic activity ordering", () => {
  const sessions = [
    makeSession("old", 1),
    makeSession("newer", 2),
  ];
  assert.deepEqual(sortSessionsByActivity(sessions).map((session) => session.id), ["newer", "old"]);

  const withUpdated = upsertSession(sessions, makeSession("old", 1, 5));
  assert.deepEqual(withUpdated.map((session) => session.id), ["old", "newer"]);
  assert.deepEqual(removeSession(withUpdated, "newer").map((session) => session.id), ["old"]);

  const messages = [makeMessage("later", 2), makeMessage("earlier", 1)];
  assert.deepEqual(sortMessagesByActivity(messages).map((message) => message.id), ["earlier", "later"]);

  const withMessage = upsertMessageInfo(messages, makeMessage("middle", 1.5));
  assert.deepEqual(withMessage.map((message) => message.id), ["earlier", "middle", "later"]);
  assert.deepEqual(removeMessageInfo(withMessage, "middle").map((message) => message.id), ["earlier", "later"]);
});

test("part upserts preserve deterministic id ordering", () => {
  const parts = [makeTextPart("part-b"), makeTextPart("part-d")];
  const withInserted = upsertPartInfo(parts, makeTextPart("part-a"));
  assert.deepEqual(withInserted.map((part) => part.id), ["part-a", "part-b", "part-d"]);

  const withUpdated = upsertPartInfo(withInserted, makeTextPart("part-b", "msg-a", "updated"));
  assert.deepEqual(withUpdated.map((part) => part.id), ["part-a", "part-b", "part-d"]);
  assert.equal((withUpdated[1] as Part & { text?: string }).text, "updated");

  assert.deepEqual(removePartInfo(withUpdated, "part-a").map((part) => part.id), ["part-b", "part-d"]);
});

test("command display alias replaces only the first user text part and preserves non-text parts", () => {
  assert.equal(formatSlashCommandDisplay(" /review ", " --quick "), "/review --quick");
  assert.equal(formatSlashCommandDisplay("/", "ignored"), "");

  const user = makeUserMessage("msg-a", 1);
  const text = makeTextPart("text-a", "msg-a", "expanded backend prompt");
  const followupText = makeTextPart("text-b", "msg-a", "kept follow-up text");
  const tool = makeToolPart("tool-a", "msg-a");
  const aliased = applyCommandDisplayAlias(user, [text, tool, followupText], "/review --quick");

  assert.deepEqual(aliased.parts.map((part) => part.id), ["text-a", "tool-a", "text-b"]);
  assert.equal((aliased.parts[0] as Part & { text?: string }).text, "/review --quick");
  assert.equal(aliased.parts[1], tool);
  assert.equal(aliased.parts[2], followupText);

  const assistant = makeMessage("msg-b", 2);
  const assistantResult = applyCommandDisplayAlias(assistant, [text], "/ignored");
  assert.equal(assistantResult.parts[0], text);

  const noText = applyCommandDisplayAlias(user, [tool], "/review");
  assert.equal(noText.parts[0].id, "command-display:msg-a");
  assert.equal(noText.parts[1], tool);
});

test("placeholder messages and session error turns are modeled without store side effects", () => {
  const part = makeTextPart("text-a", "msg-a");
  const placeholder = createPlaceholderMessage(part);
  assert.equal(placeholder.id, "msg-a");
  assert.equal(placeholder.sessionID, "sess-a");
  assert.equal(placeholder.role, "assistant");

  const messages = [makeMessage("msg-a", 1)];
  const first = appendSessionErrorTurnModel({
    current: [],
    sessionID: "sess-a",
    message: "boom",
    messages,
    now: 100,
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].afterMessageID, "msg-a");

  const duplicate = appendSessionErrorTurnModel({
    current: first,
    sessionID: "sess-a",
    message: "boom",
    messages,
    now: 200,
  });
  assert.equal(duplicate, first);

  const next = appendSessionErrorTurnModel({
    current: duplicate,
    sessionID: "sess-a",
    message: "different",
    messages,
    now: 300,
  });
  assert.equal(next.length, 2);
  assert.match(next[1].id, /^session-error:sess-a:300:1$/);

  const durable = appendSessionErrorTurnModel({
    current: next,
    sessionID: "sess-a",
    message: "durable failure",
    messages,
    runId: "run-failed",
    now: 400,
  });
  const duplicateDurable = appendSessionErrorTurnModel({
    current: durable,
    sessionID: "sess-a",
    message: "durable failure repeated after reload",
    messages,
    runId: "run-failed",
    now: 500,
  });
  assert.equal(durable.length, 3);
  assert.equal(durable[2]?.durableRunId, "run-failed");
  assert.equal(duplicateDurable, durable);
});
