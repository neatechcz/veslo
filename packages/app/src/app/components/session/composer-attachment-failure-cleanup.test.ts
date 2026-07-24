import assert from "node:assert/strict";
import test from "node:test";

import type { ComposerAttachment, ComposerDraft } from "../../types";
import { resolveComposerAttachmentFailureCleanup } from "./composer-attachment-failure-cleanup";

const msgAttachment: ComposerAttachment = {
  id: "attachment-msg",
  name: "mail.msg",
  mimeType: "application/octet-stream",
  size: 512,
  kind: "file",
  dataUrl: "data:application/octet-stream;base64,0M8R4KGxGuE=",
};

const draft = (text: string, attachments = [msgAttachment]): ComposerDraft => ({
  mode: "prompt",
  parts: text ? [{ type: "text", text }] : [],
  attachments,
  text,
  resolvedText: text,
});

test("clears an unchanged attachment draft after its optimistic row owns a typed rejection", () => {
  const submitted = draft("Use this email");
  const result = resolveComposerAttachmentFailureCleanup({
    current: submitted,
    submitted,
    errorCode: "attachment_format_unsupported",
    transferAcknowledged: true,
  });

  assert.equal(result.kind, "replace");
  if (result.kind !== "replace") return;
  assert.equal(result.draft.text, "");
  assert.deepEqual(result.draft.attachments, []);
});

test("keeps text typed during the failed submit but removes the transferred attachment", () => {
  const submitted = draft("");
  const current = draft("follow-up after unsupported MSG");
  const result = resolveComposerAttachmentFailureCleanup({
    current,
    submitted,
    errorCode: "attachment_format_unsupported",
    transferAcknowledged: true,
  });

  assert.equal(result.kind, "replace");
  if (result.kind !== "replace") return;
  assert.equal(result.draft.text, "follow-up after unsupported MSG");
  assert.deepEqual(result.draft.attachments, []);
});

test("does not mutate drafts for generic failures or before ownership transfer", () => {
  const submitted = draft("");
  assert.deepEqual(
    resolveComposerAttachmentFailureCleanup({
      current: submitted,
      submitted,
      errorCode: "send_failed",
      transferAcknowledged: true,
    }),
    { kind: "none" },
  );
  assert.deepEqual(
    resolveComposerAttachmentFailureCleanup({
      current: submitted,
      submitted,
      errorCode: "attachment_format_unsupported",
      transferAcknowledged: false,
    }),
    { kind: "none" },
  );
});

test("preserves attachments added after the transferred snapshot", () => {
  const submitted = draft("");
  const newerAttachment: ComposerAttachment = {
    ...msgAttachment,
    id: "attachment-new",
    name: "notes.txt",
    mimeType: "text/plain",
  };
  const result = resolveComposerAttachmentFailureCleanup({
    current: draft("new text", [msgAttachment, newerAttachment]),
    submitted,
    errorCode: "attachment_processing_failed",
    transferAcknowledged: true,
  });

  assert.equal(result.kind, "replace");
  if (result.kind !== "replace") return;
  assert.deepEqual(result.draft.attachments.map((attachment) => attachment.id), ["attachment-new"]);
});
