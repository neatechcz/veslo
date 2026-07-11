import assert from "node:assert/strict";
import test from "node:test";

import { markPendingSubmittedAccepted, createPendingSubmittedDraft, markPendingSubmittedFailed } from "../../../components/session/pending-submit-model.js";
import { decidePendingSubmittedTranscriptAdoption } from "../../../components/session/pending-submit-reconciliation.js";
import type { ComposerDraft, MessageWithParts } from "../../../types";

const textDraft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text }],
  attachments: [],
  text,
  resolvedText: text,
});

const attachmentDraft = (): ComposerDraft => ({
  mode: "prompt",
  parts: [],
  attachments: [{ id: "a-1", name: "screen.png", mimeType: "image/png", size: 1, kind: "image", dataUrl: "data:image/png;base64,AAAA" }],
  text: "",
  resolvedText: "",
});

const workspaceFileDraft = (): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "file", path: "notes/fixture.txt", label: "fixture.txt" }],
  attachments: [],
  text: "",
  resolvedText: "",
});

const pending = (draft: ComposerDraft = textDraft("hello")) => markPendingSubmittedAccepted(
  createPendingSubmittedDraft({
    id: "pending-1",
    clientMessageId: "msg-1",
    sessionKey: "ws-a\0session-a",
    sessionId: "session-a",
    createdAt: 1,
    transcriptMessageIdsAtSubmit: ["baseline"],
    draft,
  }),
  { runId: "run-1", clientMessageId: "msg-1" },
);

const userMessage = (id: string, input: { text?: string; sessionID?: string; clientMessageId?: string; filename?: string; mime?: string; url?: string; mode?: string | null } = {}): MessageWithParts => ({
  info: {
    id,
    sessionID: input.sessionID ?? "session-a",
    role: "user",
    ...(input.mode === null ? {} : { mode: input.mode ?? "prompt" }),
    time: { created: 2 },
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
  } as unknown as MessageWithParts["info"],
  parts: [
    ...(input.text === undefined ? [] : [{ id: `${id}-text`, messageID: id, sessionID: input.sessionID ?? "session-a", type: "text", text: input.text }]),
    ...(input.filename ? [{ id: `${id}-file`, messageID: id, sessionID: input.sessionID ?? "session-a", type: "file", filename: input.filename, mime: input.mime, url: input.url ?? "file:///redacted" }] : []),
  ] as MessageWithParts["parts"],
});

const decide = (draft = pending(), messages: MessageWithParts[] = [userMessage("canonical", { text: "hello" })]) =>
  decidePendingSubmittedTranscriptAdoption({
    pending: draft,
    messages,
    sessionKey: "ws-a\0session-a",
    sessionId: "session-a",
  });

test("adopts one accepted post-baseline text candidate", () => {
  assert.deepEqual(decide(), { kind: "adopt", messageId: "canonical", match: "fingerprint", candidateCount: 1 });
});

test("adopts a unique canonical message when OpenCode omits the optional mode field", () => {
  assert.deepEqual(
    decide(pending(), [userMessage("canonical", { text: "hello", mode: null })]),
    { kind: "adopt", messageId: "canonical", match: "fingerprint", candidateCount: 1 },
  );
});

test("ignores matching pre-baseline messages and fails visibly on duplicate candidates", () => {
  assert.deepEqual(
    decide(pending(), [userMessage("baseline", { text: "hello" })]),
    { kind: "unresolved", reason: "no-match", candidateCount: 0 },
  );
  assert.deepEqual(
    decide(pending(), [userMessage("one", { text: "hello" }), userMessage("two", { text: "hello" })]),
    { kind: "unresolved", reason: "ambiguous-fingerprint", candidateCount: 2 },
  );
});

test("adopts attachment-only messages by filename and MIME without inspecting data URLs", () => {
  assert.deepEqual(
    decide(pending(attachmentDraft()), [userMessage("file", { filename: "screen.png", mime: "image/png", url: "data:image/png;base64,REDACTED" })]),
    { kind: "adopt", messageId: "file", match: "fingerprint", candidateCount: 1 },
  );
  assert.deepEqual(
    decide(pending(attachmentDraft()), [userMessage("wrong", { filename: "screen.jpg", mime: "image/jpeg", url: "data:image/jpeg;base64,REDACTED" })]),
    { kind: "unresolved", reason: "no-match", candidateCount: 0 },
  );
});

test("adopts workspace file-only messages after the server resolves path parts", () => {
  assert.deepEqual(
    decide(pending(workspaceFileDraft()), [userMessage("file", {
      filename: "fixture.txt",
      mime: "text/plain",
      url: "file:///repo/notes/fixture.txt",
    })]),
    { kind: "adopt", messageId: "file", match: "fingerprint", candidateCount: 1 },
  );
  assert.deepEqual(
    decide(pending(workspaceFileDraft()), [userMessage("wrong", {
      filename: "fixture.txt",
      mime: "text/plain",
      url: "file:///repo/other/fixture.txt",
    })]),
    { kind: "unresolved", reason: "no-match", candidateCount: 0 },
  );
});

test("strong client identity wins even when display text differs", () => {
  assert.deepEqual(
    decide(pending(), [userMessage("canonical", { text: "rewritten by engine", clientMessageId: "msg-1" })]),
    { kind: "adopt", messageId: "canonical", match: "identity", candidateCount: 1 },
  );
});

test("OpenCode message ids are not treated as Veslo client correlation", () => {
  assert.deepEqual(
    decide(pending(), [userMessage("msg-1", { text: "different canonical content" })]),
    { kind: "unresolved", reason: "no-match", candidateCount: 0 },
  );
});

test("pre-admission, failed, mismatched, or out-of-scope rows cannot adopt", () => {
  const preAdmission = createPendingSubmittedDraft({
    id: "pending-1",
    clientMessageId: "msg-1",
    sessionKey: "ws-a\0session-a",
    sessionId: "session-a",
    createdAt: 1,
    transcriptMessageIdsAtSubmit: ["baseline"],
    draft: textDraft("hello"),
  });
  const failed = markPendingSubmittedFailed(pending(), "submit failed");
  const mismatched = markPendingSubmittedAccepted(
    createPendingSubmittedDraft({
      id: "pending-1", clientMessageId: "msg-1", sessionKey: "ws-a\0session-a", sessionId: "session-a", createdAt: 1, draft: textDraft("hello"),
    }),
    { clientMessageId: "foreign" },
  );

  assert.equal(decide(preAdmission).kind, "unresolved");
  assert.equal(decide(failed).kind, "unresolved");
  assert.equal(decide(mismatched).kind, "unresolved");
  assert.deepEqual(
    decide(pending(), [userMessage("foreign", { text: "hello", sessionID: "session-b" })]),
    { kind: "unresolved", reason: "no-match", candidateCount: 0 },
  );
});
