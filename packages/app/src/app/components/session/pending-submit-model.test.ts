import assert from "node:assert/strict";
import test from "node:test";

import {
  createPendingSubmittedDraft,
  markPendingSubmittedFailed,
  pendingSubmittedDraftToEditable,
  pendingSubmittedDraftToMessage,
  remapPendingSubmittedSession,
} from "./pending-submit-model.js";
import type { ComposerDraft } from "../../types";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text }],
  attachments: [],
  text,
  resolvedText: text,
});

test("pending submit creates a user message before a real session id exists", () => {
  const pending = createPendingSubmittedDraft({
    id: "pending-submit-1",
    sessionKey: "pending-draft:abc",
    sessionId: null,
    createdAt: 10,
    draft: draft("hello"),
  });

  const message = pendingSubmittedDraftToMessage(pending, "/tmp/workspace");

  assert.equal(message.info.id, "pending-submit-1");
  assert.equal(message.info.role, "user");
  assert.equal(message.info.sessionID, "");
  assert.equal(message.parts[0]?.type, "text");
});

test("pending submit failure preserves the message as editable state", () => {
  const pending = markPendingSubmittedFailed(
    createPendingSubmittedDraft({
      id: "pending-submit-1",
      sessionKey: "pending-draft:abc",
      sessionId: null,
      createdAt: 10,
      draft: draft("hello"),
    }),
    "Session failed",
  );

  assert.equal(pending.state, "error");
  assert.equal(pending.error, "Session failed");
  assert.deepEqual(pendingSubmittedDraftToEditable(pending), {
    messageId: "pending-submit-1",
    draft: draft("hello"),
  });
});

test("pending submit can be remapped to the real session id", () => {
  const pending = createPendingSubmittedDraft({
    id: "pending-submit-1",
    sessionKey: "pending-draft:abc",
    sessionId: null,
    createdAt: 10,
    draft: draft("hello"),
  });

  const remapped = remapPendingSubmittedSession(pending, "session-123");

  assert.equal(remapped.sessionId, "session-123");
  assert.equal(pendingSubmittedDraftToMessage(remapped, "/tmp/workspace").info.sessionID, "session-123");
});
