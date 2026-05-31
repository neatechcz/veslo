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

test("pending submit creates a renderable text placeholder for attachment-only drafts", () => {
  const pending = createPendingSubmittedDraft({
    id: "pending-submit-1",
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
