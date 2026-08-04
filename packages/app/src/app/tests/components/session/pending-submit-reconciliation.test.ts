import assert from "node:assert/strict";
import test from "node:test";

import {
  createPendingSubmittedDraft,
  markPendingSubmittedAccepted,
  markPendingSubmittedFailed,
  markPendingSubmittedOutcomeUnknown,
  type PendingSubmittedDraft,
} from "../../../components/session/pending-submit-model.js";
import {
  decidePendingSubmittedTranscriptAdoption,
  describePendingSubmittedTranscriptReconciliation,
  resolvePendingSubmittedRenderReplacement,
} from "../../../components/session/pending-submit-reconciliation.js";
import {
  materializePendingSessionInstance,
  removePendingSubmittedDraftForKey,
  trySetPendingSubmittedDraftForKey,
  type PendingSubmittedDraftBySessionKey,
} from "../../../components/session/pending-session-instance-model.js";
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

const documentDraft = (name: string, mimeType: string): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text: "Review the document" }],
  attachments: [{
    id: `attachment-${name}`,
    name,
    mimeType,
    size: 16,
    kind: "file",
    dataUrl: `data:${mimeType};base64,REDACTED`,
  }],
  text: "Review the document",
  resolvedText: "Review the document",
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

const outcomeUnknown = (draft: ComposerDraft = textDraft("hello")) =>
  markPendingSubmittedOutcomeUnknown(
    createPendingSubmittedDraft({
      id: "pending-1",
      clientMessageId: "msg-1",
      sessionKey: "ws-a\0session-a",
      sessionId: "session-a",
      createdAt: 1,
      transcriptMessageIdsAtSubmit: ["baseline"],
      draft,
    }),
    "delivery unconfirmed",
  );

const followUp = (id = "pending-2") =>
  createPendingSubmittedDraft({
    id,
    clientMessageId: `msg-${id}`,
    sessionKey: "ws-a\0session-a",
    sessionId: "session-a",
    createdAt: 3,
    transcriptMessageIdsAtSubmit: ["baseline"],
    draft: textDraft("follow-up"),
  });

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

const canonicalDocumentMessage = (input: {
  id: string;
  stagedRelativePath: string;
  sessionID?: string;
  clientMessageId?: string;
}) => userMessage(input.id, {
  text: `Review the document\nAttached workspace file: ${input.stagedRelativePath}`,
  sessionID: input.sessionID,
  clientMessageId: input.clientMessageId,
});

const decide = (draft = pending(), messages: MessageWithParts[] = [userMessage("canonical", { text: "hello" })]) =>
  decidePendingSubmittedTranscriptAdoption({
    pending: draft,
    messages,
    sessionKey: "ws-a\0session-a",
    sessionId: "session-a",
  });

const applyAdoption = (
  draft: PendingSubmittedDraft,
  messages: MessageWithParts[],
  current: PendingSubmittedDraftBySessionKey = { [draft.sessionKey]: draft },
) => {
  const adoption = decide(draft, messages);
  return {
    adoption,
    draftsBySessionKey: adoption.kind === "adopt"
      ? removePendingSubmittedDraftForKey(current, draft.sessionKey, draft.id)
      : current,
  };
};

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

test("accepted existing-session PDF adopts its projected identity and releases the slot", () => {
  const draft = pending(documentDraft("existing.pdf", "application/pdf"));
  const canonical = canonicalDocumentMessage({
    id: "canonical-pdf",
    stagedRelativePath: "sessions/session-a/attachments/existing.pdf",
    clientMessageId: "msg-1",
  });
  const result = applyAdoption(draft, [canonical]);

  assert.deepEqual(canonical.parts.map((part) => part.type), ["text"]);
  assert.deepEqual(result.adoption, {
    kind: "adopt",
    messageId: "canonical-pdf",
    match: "identity",
    candidateCount: 1,
  });
  assert.equal(
    trySetPendingSubmittedDraftForKey(result.draftsBySessionKey, draft.sessionKey, followUp()).kind,
    "stored",
  );
});

test("outcome-unknown document with exact projected identity adopts without resend and releases the slot", () => {
  const draft = outcomeUnknown(documentDraft(
    "uncertain.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ));
  const result = applyAdoption(
    draft,
    [canonicalDocumentMessage({
      id: "canonical",
      stagedRelativePath: "sessions/session-a/attachments/uncertain.docx",
      clientMessageId: "msg-1",
    })],
  );

  assert.deepEqual(result.adoption, {
    kind: "adopt",
    messageId: "canonical",
    match: "identity",
    candidateCount: 1,
  });
  assert.equal(
    trySetPendingSubmittedDraftForKey(result.draftsBySessionKey, draft.sessionKey, followUp()).kind,
    "stored",
  );
});

test("accepted first-session DOCX adopts its projected identity and releases the remapped slot", () => {
  const pendingSessionKey = "pending-session:first-document";
  const realSessionKey = "ws-a\0session-first";
  const submitted = markPendingSubmittedAccepted(
    createPendingSubmittedDraft({
      id: "pending-first-document",
      clientMessageId: "msg-first-document",
      sessionKey: pendingSessionKey,
      sessionId: null,
      createdAt: 1,
      transcriptMessageIdsAtSubmit: ["baseline"],
      draft: documentDraft(
        "first-session.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    }),
    { runId: "run-first-document", clientMessageId: "msg-first-document" },
  );
  const remappedDrafts = materializePendingSessionInstance(
    { [pendingSessionKey]: submitted },
    {
      pendingSessionKey,
      realSessionKey,
      realSessionId: "session-first",
    },
  );
  const remapped = remappedDrafts[realSessionKey];
  assert.ok(remapped);
  const canonical = canonicalDocumentMessage({
    id: "canonical-first-document",
    stagedRelativePath: "sessions/session-first/attachments/first-session.docx",
    sessionID: "session-first",
    clientMessageId: "msg-first-document",
  });
  const adoption = decidePendingSubmittedTranscriptAdoption({
    pending: remapped,
    messages: [canonical],
    sessionKey: realSessionKey,
    sessionId: "session-first",
  });
  const released = adoption.kind === "adopt"
    ? removePendingSubmittedDraftForKey(remappedDrafts, realSessionKey, remapped.id)
    : remappedDrafts;

  assert.equal(remappedDrafts[pendingSessionKey], undefined);
  assert.deepEqual(canonical.parts.map((part) => part.type), ["text"]);
  assert.deepEqual(adoption, {
    kind: "adopt",
    messageId: "canonical-first-document",
    match: "identity",
    candidateCount: 1,
  });
  assert.equal(
    trySetPendingSubmittedDraftForKey(released, realSessionKey, followUp("after-first-document")).kind,
    "stored",
  );
});

test("outcome-unknown with unique content fingerprint adopts and releases the slot", () => {
  const draft = outcomeUnknown();
  const result = applyAdoption(draft, [userMessage("canonical", { text: "hello" })]);

  assert.deepEqual(result.adoption, {
    kind: "adopt",
    messageId: "canonical",
    match: "fingerprint",
    candidateCount: 1,
  });
  assert.equal(
    trySetPendingSubmittedDraftForKey(result.draftsBySessionKey, draft.sessionKey, followUp()).kind,
    "stored",
  );
});

test("outcome-unknown with no match remains occupied", () => {
  const draft = outcomeUnknown();
  const result = applyAdoption(draft, [userMessage("canonical", { text: "different" })]);

  assert.deepEqual(result.adoption, { kind: "unresolved", reason: "no-match", candidateCount: 0 });
  assert.equal(
    trySetPendingSubmittedDraftForKey(result.draftsBySessionKey, draft.sessionKey, followUp()).kind,
    "occupied",
  );
});

test("outcome-unknown with an ambiguous match remains occupied", () => {
  const draft = outcomeUnknown();
  const result = applyAdoption(
    draft,
    [userMessage("one", { text: "hello" }), userMessage("two", { text: "hello" })],
  );

  assert.deepEqual(result.adoption, {
    kind: "unresolved",
    reason: "ambiguous-fingerprint",
    candidateCount: 2,
  });
  assert.equal(
    trySetPendingSubmittedDraftForKey(result.draftsBySessionKey, draft.sessionKey, followUp()).kind,
    "occupied",
  );
});

test("document rows left unannotated by missing, duplicate, or conflicting mappings remain occupied", () => {
  const draft = outcomeUnknown(documentDraft("unmapped.pdf", "application/pdf"));
  // The server projection represents all three fail-closed mapping outcomes as
  // this same text-only canonical row with no clientMessageId.
  const unannotated = applyAdoption(
    draft,
    [canonicalDocumentMessage({
      id: "canonical-unannotated",
      stagedRelativePath: "sessions/arbitrary/attachments/unmapped.pdf",
    })],
  );
  const duplicate = applyAdoption(
    draft,
    [
      canonicalDocumentMessage({
        id: "canonical-duplicate-a",
        stagedRelativePath: "sessions/a/attachments/unmapped.pdf",
        clientMessageId: "msg-1",
      }),
      canonicalDocumentMessage({
        id: "canonical-duplicate-b",
        stagedRelativePath: "sessions/b/attachments/unmapped.pdf",
        clientMessageId: "msg-1",
      }),
    ],
  );

  assert.deepEqual(unannotated.adoption, { kind: "unresolved", reason: "no-match", candidateCount: 0 });
  assert.deepEqual(duplicate.adoption, {
    kind: "unresolved",
    reason: "ambiguous-identity",
    candidateCount: 2,
  });
  assert.equal(
    trySetPendingSubmittedDraftForKey(unannotated.draftsBySessionKey, draft.sessionKey, followUp()).kind,
    "occupied",
  );
  assert.equal(
    trySetPendingSubmittedDraftForKey(duplicate.draftsBySessionKey, draft.sessionKey, followUp()).kind,
    "occupied",
  );
});

test("outcome-unknown identity attached to the wrong session or message remains occupied", () => {
  const draft = outcomeUnknown();
  const wrongSession = applyAdoption(
    draft,
    [userMessage("canonical", {
      text: "rewritten by engine",
      clientMessageId: "msg-1",
      sessionID: "session-b",
    })],
  );
  const wrongMessage = applyAdoption(
    draft,
    [userMessage("baseline", { text: "rewritten by engine", clientMessageId: "msg-1" })],
  );

  assert.deepEqual(wrongSession.adoption, { kind: "unresolved", reason: "no-match", candidateCount: 0 });
  assert.deepEqual(wrongMessage.adoption, { kind: "unresolved", reason: "no-match", candidateCount: 0 });
  assert.equal(
    trySetPendingSubmittedDraftForKey(wrongSession.draftsBySessionKey, draft.sessionKey, followUp()).kind,
    "occupied",
  );
  assert.equal(
    trySetPendingSubmittedDraftForKey(wrongMessage.draftsBySessionKey, draft.sessionKey, followUp()).kind,
    "occupied",
  );
});

test("failed and diagnostic-mismatched rows never adopt", () => {
  const canonical = [userMessage("canonical", { text: "rewritten by engine", clientMessageId: "msg-1" })];
  const failed = markPendingSubmittedFailed(pending(), "submit failed");
  const diagnosticMismatch = markPendingSubmittedOutcomeUnknown(
    markPendingSubmittedAccepted(
      createPendingSubmittedDraft({
        id: "pending-1",
        clientMessageId: "msg-1",
        sessionKey: "ws-a\0session-a",
        sessionId: "session-a",
        createdAt: 1,
        transcriptMessageIdsAtSubmit: ["baseline"],
        draft: textDraft("hello"),
      }),
      { clientMessageId: "foreign" },
    ),
    "delivery unconfirmed",
  );

  assert.deepEqual(decide(failed, canonical), {
    kind: "unresolved",
    reason: "not-accepted",
    candidateCount: 0,
  });
  assert.deepEqual(decide(diagnosticMismatch, canonical), {
    kind: "unresolved",
    reason: "client-message-mismatch",
    candidateCount: 0,
  });
  const mismatchedResult = applyAdoption(diagnosticMismatch, canonical);
  assert.equal(
    trySetPendingSubmittedDraftForKey(
      mismatchedResult.draftsBySessionKey,
      diagnosticMismatch.sessionKey,
      followUp(),
    ).kind,
    "occupied",
  );
});

test("a late cleanup after first-session remap removes only the exact pending id it evaluated", () => {
  const pendingSessionKey = "pending-session:late-cleanup";
  const realSessionKey = "ws-a\0session-remapped";
  const initial = markPendingSubmittedOutcomeUnknown(
    createPendingSubmittedDraft({
      id: "pending-remapped-document",
      clientMessageId: "msg-remapped-document",
      sessionKey: pendingSessionKey,
      sessionId: null,
      createdAt: 1,
      transcriptMessageIdsAtSubmit: ["baseline"],
      draft: documentDraft("late.pdf", "application/pdf"),
    }),
    "delivery unconfirmed",
  );
  const remapped = materializePendingSessionInstance(
    { [pendingSessionKey]: initial },
    { pendingSessionKey, realSessionKey, realSessionId: "session-remapped" },
  );
  const evaluated = remapped[realSessionKey];
  assert.ok(evaluated);
  const adoption = decidePendingSubmittedTranscriptAdoption({
    pending: evaluated,
    messages: [canonicalDocumentMessage({
      id: "canonical-remapped-document",
      stagedRelativePath: "sessions/session-remapped/attachments/late.pdf",
      sessionID: "session-remapped",
      clientMessageId: "msg-remapped-document",
    })],
    sessionKey: realSessionKey,
    sessionId: "session-remapped",
  });
  const replacement = { ...followUp("replacement"), sessionKey: realSessionKey };
  const current = { [realSessionKey]: replacement };

  assert.equal(adoption.kind, "adopt");
  assert.equal(removePendingSubmittedDraftForKey(current, realSessionKey, evaluated.id), current);
  assert.equal(current[realSessionKey]?.id, replacement.id);
});

test("after adoption a follow-up submit is permitted exactly once", () => {
  const draft = outcomeUnknown();
  const firstFollowUp = followUp("follow-up-1");
  const secondFollowUp = followUp("follow-up-2");
  const current = { [draft.sessionKey]: draft };

  assert.equal(
    trySetPendingSubmittedDraftForKey(current, draft.sessionKey, firstFollowUp).kind,
    "occupied",
  );
  const adopted = applyAdoption(
    draft,
    [userMessage("canonical", { text: "rewritten by engine", clientMessageId: "msg-1" })],
    current,
  );
  const firstWrite = trySetPendingSubmittedDraftForKey(
    adopted.draftsBySessionKey,
    draft.sessionKey,
    firstFollowUp,
  );
  assert.equal(firstWrite.kind, "stored");
  assert.equal(
    trySetPendingSubmittedDraftForKey(
      firstWrite.draftsBySessionKey,
      draft.sessionKey,
      secondFollowUp,
    ).kind,
    "occupied",
  );
});

test("render replacement and adoption use the same matcher for outcome-unknown rows", () => {
  const draft = outcomeUnknown();
  const messages = [userMessage("canonical", {
    text: "rewritten by engine",
    clientMessageId: "msg-1",
  })];

  assert.deepEqual(
    resolvePendingSubmittedRenderReplacement({
      pending: draft,
      messages,
      sessionKey: draft.sessionKey,
      sessionId: draft.sessionId,
    }),
    { kind: "show-canonical", messageId: "canonical", match: "identity", candidateCount: 1 },
  );
  assert.deepEqual(decide(draft, messages), {
    kind: "adopt",
    messageId: "canonical",
    match: "identity",
    candidateCount: 1,
  });
});

test("reconciliation diagnostics are finite and content-free", () => {
  const draft = outcomeUnknown(documentDraft("private-report.pdf", "application/pdf"));
  const adoption = decide(
    draft,
    [canonicalDocumentMessage({
      id: "canonical",
      stagedRelativePath: "sessions/private/attachments/private-report.pdf",
      clientMessageId: "msg-1",
    })],
  );
  const event = describePendingSubmittedTranscriptReconciliation(draft, adoption);

  assert.deepEqual(event, {
    pendingState: "outcome-unknown",
    eligibility: "outcome-unknown",
    result: "adopt",
    matchKind: "identity",
    candidateCount: 1,
    unresolvedReason: null,
  });
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("Review the document"), false);
  assert.equal(serialized.includes("private-report.pdf"), false);
  assert.equal(serialized.includes("sessions/private"), false);
  assert.equal(serialized.includes("Attached workspace file"), false);

  assert.deepEqual(
    describePendingSubmittedTranscriptReconciliation(
      draft,
      decide(draft, [userMessage("canonical", { text: "different" })]),
    ),
    {
      pendingState: "outcome-unknown",
      eligibility: "outcome-unknown",
      result: "unresolved",
      matchKind: null,
      candidateCount: 0,
      unresolvedReason: "no-match",
    },
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
