import assert from "node:assert/strict";
import test from "node:test";

import {
  createPendingSubmittedDraft,
  createPendingSubmittedMessageProjection,
  markPendingSubmittedAccepted,
  markPendingSubmittedFailed,
  pendingSubmittedDraftToEditable,
  pendingSubmittedDraftToMessage,
  remapPendingSubmittedSession,
} from "../../../components/session/pending-submit-model.js";
import type { ComposerDraft } from "../../../types";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text }],
  attachments: [],
  text,
  resolvedText: text,
});

const attachmentOnlyDraft = (): ComposerDraft => ({
  mode: "prompt",
  parts: [],
  attachments: [
    {
      id: "attachment-1",
      name: "screenshot.png",
      mimeType: "image/png",
      size: 10,
      kind: "image",
      dataUrl: "data:image/png;base64,AAAA",
    },
  ],
  text: "",
  resolvedText: "",
});

test("pending submit creates a user message before a real session id exists", () => {
  const pending = createPendingSubmittedDraft({
    id: "pending-submit-1",
    clientMessageId: "pending-submit-1",
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

test("pending local-echo projection keeps its message identity for the same pending draft", () => {
  const pending = createPendingSubmittedDraft({
    id: "pending-submit-1",
    clientMessageId: "pending-submit-1",
    sessionKey: "pending-draft:abc",
    sessionId: null,
    createdAt: 10,
    draft: draft("hello"),
  });
  const project = createPendingSubmittedMessageProjection();

  const first = project(pending, "/tmp/workspace");
  assert.strictEqual(project(pending, "/tmp/workspace"), first);
  assert.notStrictEqual(
    project({ ...pending, sessionId: "session-123" }, "/tmp/workspace"),
    first,
    "a changed pending draft must produce a fresh projection",
  );
});

test("pending submit failure preserves the message as editable state", () => {
  const pending = markPendingSubmittedFailed(
    createPendingSubmittedDraft({
      id: "pending-submit-1",
      clientMessageId: "pending-submit-1",
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
    clientMessageId: "pending-submit-1",
    sessionKey: "pending-draft:abc",
    sessionId: null,
    createdAt: 10,
    draft: draft("hello"),
  });

  const remapped = remapPendingSubmittedSession(pending, "session-123");

  assert.equal(remapped.sessionId, "session-123");
  assert.equal(pendingSubmittedDraftToMessage(remapped, "/tmp/workspace").info.sessionID, "session-123");
});

test("pending-session remap preserves accepted admission metadata", () => {
  const accepted = markPendingSubmittedAccepted(
    createPendingSubmittedDraft({
      id: "pending-submit-1",
      clientMessageId: "msg-1",
      sessionKey: "pending-draft:abc",
      sessionId: null,
      createdAt: 10,
      draft: draft("hello"),
    }),
    { runId: "run-1", clientMessageId: "msg-1" },
  );

  const remapped = remapPendingSubmittedSession(accepted, "session-123");
  assert.equal(remapped.admission, "accepted");
  assert.equal(remapped.acceptedRunId, "run-1");
  assert.equal(remapped.acceptedClientMessageId, "msg-1");
});

test("pending submit records accepted admission and fails closed on a mismatched client id", () => {
  const pending = createPendingSubmittedDraft({
    id: "pending-submit-1",
    clientMessageId: "msg-local",
    sessionKey: "session-key",
    sessionId: "session-123",
    createdAt: 10,
    draft: draft("hello"),
  });

  const accepted = markPendingSubmittedAccepted(pending, {
    runId: "run-accepted",
    clientMessageId: "msg-local",
  });
  const mismatch = markPendingSubmittedAccepted(pending, {
    runId: "run-foreign",
    clientMessageId: "msg-foreign",
  });

  assert.equal(accepted.admission, "accepted");
  assert.equal(accepted.acceptedRunId, "run-accepted");
  assert.equal(accepted.acceptedClientMessageId, "msg-local");
  assert.equal(mismatch.admission, "pending");
  assert.equal(mismatch.admissionDiagnostic, "client-message-mismatch");
});

test("pending submit creates a renderable text placeholder for attachment-only drafts", () => {
  const pending = createPendingSubmittedDraft({
    id: "pending-submit-1",
    clientMessageId: "pending-submit-1",
    sessionKey: "pending-draft:abc",
    sessionId: null,
    createdAt: 10,
    draft: attachmentOnlyDraft(),
  });

  const message = pendingSubmittedDraftToMessage(pending, "/tmp/workspace");
  const attachment = message.parts.find((part) => part.type === "file");
  const placeholder = message.parts.find((part) => part.type === "text");

  assert.equal(attachment?.type, "file");
  assert.equal((attachment as { filename?: string } | undefined)?.filename, "screenshot.png");
  assert.equal(placeholder?.type, "text");
  assert.notEqual(((placeholder as { text?: string } | undefined)?.text ?? "").trim(), "");
});
