import type { MessageWithParts } from "../../types";

import type { PendingSubmittedDraft } from "./pending-submit-model";

export type PendingSubmittedTranscriptAdoption =
  | { kind: "adopt"; messageId: string; match: "identity" | "fingerprint"; candidateCount: number }
  | {
      kind: "unresolved";
      reason:
        | "not-accepted"
        | "client-message-mismatch"
        | "scope-mismatch"
        | "no-match"
        | "ambiguous-identity"
        | "ambiguous-fingerprint";
      candidateCount: number;
    };

export type PendingSubmittedRenderReplacement =
  | { kind: "show-local" }
  | {
      kind: "show-canonical";
      messageId: string;
      match: "identity" | "fingerprint";
      candidateCount: number;
    };

export type PendingSubmittedTranscriptAdoptionEligibility =
  | "accepted-sending"
  | "outcome-unknown"
  | "ineligible";

export type PendingSubmittedTranscriptReconciliationTrace = {
  pendingState: PendingSubmittedDraft["state"];
  eligibility: PendingSubmittedTranscriptAdoptionEligibility;
  result: PendingSubmittedTranscriptAdoption["kind"];
  matchKind: "identity" | "fingerprint" | null;
  candidateCount: number;
  unresolvedReason: Extract<PendingSubmittedTranscriptAdoption, { kind: "unresolved" }>["reason"] | null;
};

type PendingSubmittedTranscriptMatch =
  | Extract<PendingSubmittedTranscriptAdoption, { kind: "adopt" }>
  | {
      kind: "unresolved";
      reason: Exclude<
        Extract<PendingSubmittedTranscriptAdoption, { kind: "unresolved" }>["reason"],
        "not-accepted"
      >;
      candidateCount: number;
    };

const normalizeText = (value: unknown) => typeof value === "string"
  ? value.replace(/\s+/g, " ").trim()
  : "";

const normalizeIdentity = (value: unknown) => normalizeText(value).toLowerCase();

const messageId = (message: MessageWithParts) => {
  const value = (message.info as { id?: unknown }).id;
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
};

const messageClientIds = (message: MessageWithParts) => {
  const info = message.info as { clientMessageId?: unknown };
  const ids = [info.clientMessageId];
  for (const part of message.parts as Array<{ clientMessageId?: unknown }>) {
    ids.push(part.clientMessageId);
  }
  return new Set(ids.map(normalizeText).filter(Boolean));
};

type FileFingerprint = {
  kind: "workspace" | "attachment" | "unknown";
  path: string;
  label: string;
  filename: string;
  mime: string;
};

const normalizePathIdentity = (value: unknown) => normalizeIdentity(value).replace(/\\/g, "/").replace(/\/+$/g, "");

const filenameFromPath = (value: unknown) => {
  const segments = normalizePathIdentity(value).split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
};

const fileUrlPath = (value: unknown) => {
  const url = normalizeText(value);
  if (!url.toLowerCase().startsWith("file:")) return "";
  try {
    return normalizePathIdentity(decodeURIComponent(new URL(url).pathname));
  } catch {
    return normalizePathIdentity(url.replace(/^file:\/\/+/, ""));
  }
};

const messageFileFingerprints = (message: MessageWithParts): FileFingerprint[] =>
  (message.parts as Array<{
    type?: unknown;
    path?: unknown;
    label?: unknown;
    filename?: unknown;
    mime?: unknown;
    url?: unknown;
  }>)
    .filter((part) => part.type === "file")
    .map((part) => {
      const url = normalizeText(part.url);
      const path = normalizePathIdentity(part.path) || fileUrlPath(url);
      return {
        kind: url.toLowerCase().startsWith("data:")
          ? "attachment"
          : path || url.toLowerCase().startsWith("file:")
            ? "workspace"
            : "unknown",
        path,
        label: normalizeIdentity(part.label),
        filename: normalizeIdentity(part.filename) || filenameFromPath(path),
        mime: normalizeIdentity(part.mime),
      };
    });

const pendingFileFingerprints = (pending: PendingSubmittedDraft): FileFingerprint[] => [
  ...pending.draft.parts
    .filter((part) => part.type === "file")
    .map((part) => ({
      kind: "workspace" as const,
      path: normalizePathIdentity(part.path),
      label: normalizeIdentity(part.label),
      filename: filenameFromPath(part.path),
      mime: "text/plain",
    })),
  ...pending.draft.attachments.map((attachment) => ({
    kind: "attachment" as const,
    path: "",
    label: "",
    filename: normalizeIdentity(attachment.name),
    mime: normalizeIdentity(attachment.mimeType),
  })),
];

const fileFingerprintMatches = (pending: FileFingerprint, message: FileFingerprint) => {
  if (pending.kind !== "unknown" && message.kind !== "unknown" && pending.kind !== message.kind) return false;
  if (pending.filename && message.filename !== pending.filename) return false;
  if (pending.mime && message.mime && message.mime !== pending.mime) return false;
  if (pending.label && message.label && message.label !== pending.label) return false;
  if (pending.kind !== "workspace" || !pending.path || !message.path) return true;
  return message.path === pending.path || message.path.endsWith(`/${pending.path}`);
};

const fileFingerprintsMatch = (pending: FileFingerprint[], message: FileFingerprint[]) => {
  if (pending.length !== message.length) return false;
  const remaining = [...message];
  for (const expected of pending) {
    const index = remaining.findIndex((candidate) => fileFingerprintMatches(expected, candidate));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
};

const messageMatchesPendingFingerprint = (message: MessageWithParts, pending: PendingSubmittedDraft) => {
  const info = message.info as { mode?: unknown };
  const messageMode = normalizeIdentity(info.mode);
  const pendingMode = normalizeIdentity(pending.draft.mode);
  const text = (message.parts as Array<{ type?: unknown; text?: unknown }>)
    .filter((part) => part.type === "text")
    .map((part) => normalizeText(part.text))
    .filter(Boolean)
    .join("\n");
  return (!messageMode || !pendingMode || messageMode === pendingMode) &&
    text === normalizeText(pending.draft.resolvedText ?? pending.draft.text) &&
    fileFingerprintsMatch(pendingFileFingerprints(pending), messageFileFingerprints(message));
};

function findPendingSubmittedTranscriptMatch(input: {
  pending: PendingSubmittedDraft;
  messages: MessageWithParts[];
  sessionKey: string;
  sessionId?: string | null;
}): PendingSubmittedTranscriptMatch {
  const pending = input.pending;
  if (pending.admissionDiagnostic) {
    return { kind: "unresolved", reason: pending.admissionDiagnostic, candidateCount: 0 };
  }
  if (pending.sessionKey !== input.sessionKey.trim()) {
    return { kind: "unresolved", reason: "scope-mismatch", candidateCount: 0 };
  }

  const baselineIds = new Set(pending.transcriptMessageIdsAtSubmit ?? []);
  const scopedSessionId = input.sessionId?.trim() || pending.sessionId?.trim() || "";
  const candidates = input.messages.filter((message) => {
    const info = message.info as { role?: unknown; sessionID?: unknown };
    const id = messageId(message);
    const messageSessionId = normalizeText(info.sessionID);
    return info.role === "user" &&
      Boolean(id) &&
      !baselineIds.has(id) &&
      (!scopedSessionId || messageSessionId === scopedSessionId);
  });
  const acceptedClientMessageId = pending.acceptedClientMessageId?.trim() || pending.clientMessageId.trim();
  const identityMatches = acceptedClientMessageId
    ? candidates.filter((message) => messageClientIds(message).has(acceptedClientMessageId))
    : [];
  if (identityMatches.length === 1) {
    return { kind: "adopt", messageId: messageId(identityMatches[0]), match: "identity", candidateCount: 1 };
  }
  if (identityMatches.length > 1) {
    return { kind: "unresolved", reason: "ambiguous-identity", candidateCount: identityMatches.length };
  }

  const fingerprintMatches = candidates.filter((message) => messageMatchesPendingFingerprint(message, pending));
  if (fingerprintMatches.length === 1) {
    return { kind: "adopt", messageId: messageId(fingerprintMatches[0]), match: "fingerprint", candidateCount: 1 };
  }
  return fingerprintMatches.length > 1
    ? { kind: "unresolved", reason: "ambiguous-fingerprint", candidateCount: fingerprintMatches.length }
    : { kind: "unresolved", reason: "no-match", candidateCount: 0 };
}

export function resolvePendingSubmittedRenderReplacement(input: {
  pending: PendingSubmittedDraft;
  messages: MessageWithParts[];
  sessionKey: string;
  sessionId?: string | null;
}): PendingSubmittedRenderReplacement {
  if (input.pending.state === "error") return { kind: "show-local" };
  const match = findPendingSubmittedTranscriptMatch(input);
  return match.kind === "adopt"
    ? {
        kind: "show-canonical",
        messageId: match.messageId,
        match: match.match,
        candidateCount: match.candidateCount,
      }
    : { kind: "show-local" };
}

export function decidePendingSubmittedTranscriptAdoption(input: {
  pending: PendingSubmittedDraft;
  messages: MessageWithParts[];
  sessionKey: string;
  sessionId?: string | null;
}): PendingSubmittedTranscriptAdoption {
  const pending = input.pending;
  const eligibility = pendingSubmittedTranscriptAdoptionEligibility(pending);
  if (eligibility === "ineligible") {
    if (pending.admissionDiagnostic) {
      return { kind: "unresolved", reason: pending.admissionDiagnostic, candidateCount: 0 };
    }
    return { kind: "unresolved", reason: "not-accepted", candidateCount: 0 };
  }
  return findPendingSubmittedTranscriptMatch(input);
}

export function pendingSubmittedTranscriptAdoptionEligibility(
  pending: PendingSubmittedDraft,
): PendingSubmittedTranscriptAdoptionEligibility {
  if (pending.admissionDiagnostic) return "ineligible";
  if (pending.state === "sending" && pending.admission === "accepted") return "accepted-sending";
  if (pending.state === "outcome-unknown") return "outcome-unknown";
  return "ineligible";
}

export function describePendingSubmittedTranscriptReconciliation(
  pending: PendingSubmittedDraft,
  adoption: PendingSubmittedTranscriptAdoption,
): PendingSubmittedTranscriptReconciliationTrace {
  return {
    pendingState: pending.state,
    eligibility: pendingSubmittedTranscriptAdoptionEligibility(pending),
    result: adoption.kind,
    matchKind: adoption.kind === "adopt" ? adoption.match : null,
    candidateCount: adoption.candidateCount,
    unresolvedReason: adoption.kind === "unresolved" ? adoption.reason : null,
  };
}
