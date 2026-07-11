import assert from "node:assert/strict";
import test from "node:test";

import type { ComposerDraft } from "../../types";
import { createUiConversationKey } from "../../lib/ui-conversation-scope.js";
import {
  createPendingSessionInstance,
  createPendingSessionInstanceId,
  isPendingSessionInstanceId,
  isPendingSessionInstanceKey,
  materializePendingSessionInstance,
  pendingSessionKeyForInstance,
  removePendingSubmittedDraftForKey,
  selectPendingSubmittedDraft,
  setPendingSubmittedDraftForKey,
  trySetPendingSubmittedDraftForKey,
  type PendingSubmittedDraftBySessionKey,
} from "./pending-session-instance-model.js";
import { createPendingSubmittedDraft } from "./pending-submit-model.js";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text }],
  attachments: [],
  text,
  resolvedText: text,
});

test("pending session ids are distinct and renderable as pending session keys", () => {
  const first = createPendingSessionInstanceId(() => "one");
  const second = createPendingSessionInstanceId(() => "two");

  assert.equal(first, "pending-session:one");
  assert.equal(second, "pending-session:two");
  assert.notEqual(first, second);
  assert.equal(pendingSessionKeyForInstance(first), first);
});

test("pending session ids accept direct uuid strings and sanitize renderable keys", () => {
  assert.equal(createPendingSessionInstanceId("a.b_c-d"), "pending-session:ab_c-d");
});

test("pending session ids fall back when sanitized input has an empty suffix", () => {
  const id = createPendingSessionInstanceId(".");

  assert.notEqual(id, "pending-session:");
  assert.equal(isPendingSessionInstanceId(id), true);
  assert.notEqual(id.slice("pending-session:".length), "");
});

test("pending session id guard rejects prefix-only values", () => {
  assert.equal(isPendingSessionInstanceId("pending-session:"), false);
  assert.equal(isPendingSessionInstanceId(" pending-session: "), false);
});

test("pending session key guard accepts scoped pending session keys", () => {
  const pendingKey = createUiConversationKey({
    workspaceId: "ws-a",
    kind: "pending-session",
    id: "pending-session:abc",
  });

  assert.equal(isPendingSessionInstanceKey("pending-session:abc"), true);
  assert.equal(isPendingSessionInstanceKey(pendingKey), true);
  assert.equal(isPendingSessionInstanceId(pendingKey), false);
});

test("two pending sessions in the same workspace keep separate submitted drafts", () => {
  const first = createPendingSessionInstance({
    id: "pending-session:first",
    workspaceId: "workspace-a",
    workspaceRoot: "/tmp/project",
    title: "first",
    createdAt: 100,
  });
  const second = createPendingSessionInstance({
    id: "pending-session:second",
    workspaceId: "workspace-a",
    workspaceRoot: "/tmp/project",
    title: "second",
    createdAt: 101,
  });

  let submitted: PendingSubmittedDraftBySessionKey = {};
  submitted = setPendingSubmittedDraftForKey(
    submitted,
    first.sessionKey,
    createPendingSubmittedDraft({
      id: "optimistic:first",
      clientMessageId: "optimistic:first",
      sessionKey: first.sessionKey,
      sessionId: null,
      createdAt: 100,
      draft: draft("first message"),
    }),
  );
  submitted = setPendingSubmittedDraftForKey(
    submitted,
    second.sessionKey,
    createPendingSubmittedDraft({
      id: "optimistic:second",
      clientMessageId: "optimistic:second",
      sessionKey: second.sessionKey,
      sessionId: null,
      createdAt: 101,
      draft: draft("second message"),
    }),
  );

  assert.equal(selectPendingSubmittedDraft(submitted, first.sessionKey)?.draft.text, "first message");
  assert.equal(selectPendingSubmittedDraft(submitted, second.sessionKey)?.draft.text, "second message");
});

test("a second submitted draft cannot overwrite an unresolved session slot", () => {
  const first = createPendingSubmittedDraft({
    id: "optimistic:first",
    clientMessageId: "client:first",
    sessionKey: "session-a",
    sessionId: "session-a",
    createdAt: 100,
    draft: draft("first message"),
  });
  const second = createPendingSubmittedDraft({
    id: "optimistic:second",
    clientMessageId: "client:second",
    sessionKey: "session-a",
    sessionId: "session-a",
    createdAt: 101,
    draft: draft("second message"),
  });
  const current = { "session-a": first };

  const result = trySetPendingSubmittedDraftForKey(current, "session-a", second);

  assert.equal(result.kind, "occupied");
  assert.equal(result.pending.id, first.id);
  assert.equal(result.draftsBySessionKey, current);
  assert.equal(setPendingSubmittedDraftForKey(current, "session-a", second), current);
  assert.equal(selectPendingSubmittedDraft(result.draftsBySessionKey, "session-a")?.draft.text, "first message");
});

test("the same submitted id may update its existing session slot", () => {
  const first = createPendingSubmittedDraft({
    id: "optimistic:first",
    clientMessageId: "client:first",
    sessionKey: "session-a",
    sessionId: "session-a",
    createdAt: 100,
    draft: draft("first message"),
  });
  const updated = { ...first, state: "error" as const, error: "failed" };

  const result = trySetPendingSubmittedDraftForKey({ "session-a": first }, "session-a", updated);

  assert.equal(result.kind, "stored");
  assert.equal(result.pending.id, first.id);
  assert.equal(result.pending.state, "error");
  assert.equal(selectPendingSubmittedDraft(result.draftsBySessionKey, "session-a")?.error, "failed");
});

test("materializing one pending session remaps only its submitted draft", () => {
  let submitted: PendingSubmittedDraftBySessionKey = {};
  submitted = setPendingSubmittedDraftForKey(
    submitted,
    "pending-session:first",
    createPendingSubmittedDraft({
      id: "optimistic:first",
      clientMessageId: "optimistic:first",
      sessionKey: "pending-session:first",
      sessionId: null,
      createdAt: 100,
      draft: draft("first message"),
    }),
  );
  submitted = setPendingSubmittedDraftForKey(
    submitted,
    "pending-session:second",
    createPendingSubmittedDraft({
      id: "optimistic:second",
      clientMessageId: "optimistic:second",
      sessionKey: "pending-session:second",
      sessionId: null,
      createdAt: 101,
      draft: draft("second message"),
    }),
  );

  const remapped = materializePendingSessionInstance(submitted, {
    pendingSessionKey: "pending-session:first",
    realSessionKey: "session-real-first",
    realSessionId: "session-real-first",
  });

  assert.equal(selectPendingSubmittedDraft(remapped, "session-real-first")?.draft.text, "first message");
  assert.equal(selectPendingSubmittedDraft(remapped, "session-real-first")?.id, "optimistic:first");
  assert.equal(selectPendingSubmittedDraft(remapped, "session-real-first")?.clientMessageId, "optimistic:first");
  assert.equal(selectPendingSubmittedDraft(remapped, "session-real-first")?.sessionId, "session-real-first");
  assert.equal(selectPendingSubmittedDraft(remapped, "pending-session:first"), null);
  assert.equal(selectPendingSubmittedDraft(remapped, "pending-session:second")?.draft.text, "second message");
});

test("materialization does not overwrite an occupied real-session slot", () => {
  const pending = createPendingSubmittedDraft({
    id: "optimistic:pending",
    clientMessageId: "client:pending",
    sessionKey: "pending-session:first",
    sessionId: null,
    createdAt: 100,
    draft: draft("pending message"),
  });
  const existing = createPendingSubmittedDraft({
    id: "optimistic:existing",
    clientMessageId: "client:existing",
    sessionKey: "session-real-first",
    sessionId: "session-real-first",
    createdAt: 101,
    draft: draft("existing message"),
  });
  const current = {
    "pending-session:first": pending,
    "session-real-first": existing,
  };

  const remapped = materializePendingSessionInstance(current, {
    pendingSessionKey: "pending-session:first",
    realSessionKey: "session-real-first",
    realSessionId: "session-real-first",
  });

  assert.equal(remapped, current);
  assert.equal(selectPendingSubmittedDraft(remapped, "pending-session:first")?.id, pending.id);
  assert.equal(selectPendingSubmittedDraft(remapped, "session-real-first")?.id, existing.id);
});

test("materializing a scoped pending session key preserves optimistic draft across workspace handoff", () => {
  const pendingKey = createUiConversationKey({
    workspaceId: "ws-a",
    kind: "pending-session",
    id: "pending-session:first",
  });
  const realKey = createUiConversationKey({
    workspaceId: "ws-a",
    kind: "session",
    id: "session-real-first",
  });
  const submitted = setPendingSubmittedDraftForKey(
    {},
    pendingKey,
    createPendingSubmittedDraft({
      id: "optimistic:first",
      clientMessageId: "optimistic:first",
      sessionKey: pendingKey,
      sessionId: null,
      createdAt: 100,
      draft: draft("first message"),
    }),
  );

  const remapped = materializePendingSessionInstance(submitted, {
    pendingSessionKey: pendingKey,
    realSessionKey: realKey,
    realSessionId: "session-real-first",
  });

  assert.equal(selectPendingSubmittedDraft(remapped, realKey)?.draft.text, "first message");
  assert.equal(selectPendingSubmittedDraft(remapped, realKey)?.sessionId, "session-real-first");
  assert.equal(selectPendingSubmittedDraft(remapped, pendingKey), null);
});

test("materializing ignores non-pending session keys", () => {
  const submitted: PendingSubmittedDraftBySessionKey = {
    "session-real-existing": createPendingSubmittedDraft({
      id: "optimistic:existing",
      clientMessageId: "optimistic:existing",
      sessionKey: "session-real-existing",
      sessionId: "session-real-existing",
      createdAt: 100,
      draft: draft("existing message"),
    }),
  };

  const remapped = materializePendingSessionInstance(submitted, {
    pendingSessionKey: "session-real-existing",
    realSessionKey: "session-remapped",
    realSessionId: "session-remapped",
  });

  assert.equal(selectPendingSubmittedDraft(remapped, "session-real-existing")?.id, "optimistic:existing");
  assert.equal(selectPendingSubmittedDraft(remapped, "session-remapped"), null);
});

test("removing a pending submitted draft removes only the matching key and id", () => {
  const pending = createPendingSubmittedDraft({
    id: "optimistic:first",
    clientMessageId: "optimistic:first",
    sessionKey: "pending-session:first",
    sessionId: null,
    createdAt: 100,
    draft: draft("first message"),
  });
  const unchanged = removePendingSubmittedDraftForKey(
    { "pending-session:first": pending },
    "pending-session:first",
    "other-id",
  );
  const removed = removePendingSubmittedDraftForKey(
    { "pending-session:first": pending },
    "pending-session:first",
    "optimistic:first",
  );

  assert.equal(selectPendingSubmittedDraft(unchanged, "pending-session:first")?.id, "optimistic:first");
  assert.equal(selectPendingSubmittedDraft(removed, "pending-session:first"), null);
});
