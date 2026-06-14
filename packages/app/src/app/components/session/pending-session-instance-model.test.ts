import assert from "node:assert/strict";
import test from "node:test";

import type { ComposerDraft } from "../../types";
import {
  createPendingSessionInstance,
  createPendingSessionInstanceId,
  isPendingSessionInstanceId,
  materializePendingSessionInstance,
  pendingSessionKeyForInstance,
  removePendingSubmittedDraftForKey,
  selectPendingSubmittedDraft,
  setPendingSubmittedDraftForKey,
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
  assert.equal(selectPendingSubmittedDraft(remapped, "session-real-first")?.sessionId, "session-real-first");
  assert.equal(selectPendingSubmittedDraft(remapped, "pending-session:first"), null);
  assert.equal(selectPendingSubmittedDraft(remapped, "pending-session:second")?.draft.text, "second message");
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
