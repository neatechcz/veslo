import type { MessageWithParts } from "../types";
import { uiEffectTrace } from "../lib/ui-effect-trace";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";

/**
 * Dev-only causal sidecar for transcript writes.
 *
 * It deliberately does not live in the Solid store: changing diagnostic state
 * must never itself invalidate the transcript projection we are measuring.
 */
export type TranscriptWriteOwner =
  | "sse.message.updated"
  | "sse.message.removed"
  | "sse.part.updated"
  | "sse.part.removed"
  | "transcript.snapshot-hydrate"
  | "transcript.set-messages";

export type TranscriptWriteTarget = "collection" | "message-info" | "parts" | "part";

export type TranscriptWriteCause = {
  causeId: string;
  revision: number;
  owner: TranscriptWriteOwner;
  target: TranscriptWriteTarget;
  sessionId: string;
  messageId: string;
  partId?: string;
};

export type TranscriptProjectionStage =
  | "canonical"
  | "visible"
  | "viewport-rendered"
  | "session-handoff";

export type TranscriptProjectionBoundary = {
  stage: TranscriptProjectionStage;
  sessionId: string;
  revision: number;
  arrayIdentity: number;
  messageCount: number;
  assistantMessageCount: number;
  assistantTextPartCount: number;
  assistantTextCharacterCount: number;
  assistantToolPartCount: number;
};

export type TranscriptViewportInputTuple = {
  canonicalArrayIdentity: number;
  localEchoIdentity: number | null;
  searchActive: boolean;
  windowExpanded: boolean;
  windowStart: number;
  selectedDisplaySession: string;
};

export type TranscriptViewportProjectionBoundary = TranscriptProjectionBoundary & {
  inputTuple: TranscriptViewportInputTuple;
  previousInputTuple: TranscriptViewportInputTuple | null;
  outputIdentityChanged: boolean;
};

export type MessageBlockMemoNoOpInput = {
  groupingInputFingerprint: string | null;
  previousGroupingInputFingerprint: string | null;
  blockShapeFingerprint: string;
  previousBlockShapeFingerprint: string | null;
  rowReferenceFingerprint: string;
  previousRowReferenceFingerprint: string | null;
  projectionBoundaryFingerprint: string;
  previousProjectionBoundaryFingerprint: string | null;
  writeRevisionStart: number;
  writeRevisionEnd: number;
};

export const isMessageBlockMemoNoOp = (input: MessageBlockMemoNoOpInput) =>
  input.groupingInputFingerprint !== null &&
  input.groupingInputFingerprint === input.previousGroupingInputFingerprint &&
  input.blockShapeFingerprint === input.previousBlockShapeFingerprint &&
  input.rowReferenceFingerprint === input.previousRowReferenceFingerprint &&
  input.projectionBoundaryFingerprint === input.previousProjectionBoundaryFingerprint &&
  input.writeRevisionEnd === input.writeRevisionStart;

export type TranscriptSurfaceIdentity = {
  messageId: string;
  messageIdentity: number;
  infoIdentity: number;
  partsIdentity: number;
  messageInfoCause: TranscriptWriteCause | null;
  partsCause: TranscriptWriteCause | null;
  partIdentities: Array<{
    partId: string;
    identity: number;
    cause: TranscriptWriteCause | null;
  }>;
};

const MAX_CAUSES = 512;
const objectIdentity = new WeakMap<object, number>();
const causeByTarget = new Map<string, TranscriptWriteCause>();
const causeOrder: Array<{ targetKey: string; causeId: string }> = [];
const projectionBoundaryByScope = new Map<string, TranscriptProjectionBoundary & { messages: MessageWithParts[] }>();
let nextObjectIdentity = 1;
let nextCauseIdentity = 1;
let nextWriteRevision = 0;
let diagnosticEnabledForTests: boolean | null = null;
const configuredDiagnosticEnabled = (() => {
  try {
    if (!import.meta.env?.DEV) return false;
    const value = import.meta.env?.VITE_VESLO_SESSION_UI_MUTATION_TRACE;
    return typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  } catch {
    return false;
  }
})();

export const transcriptWriteDiagnosticsEnabled = () => {
  if (diagnosticEnabledForTests !== null) return diagnosticEnabledForTests;
  return configuredDiagnosticEnabled || uiEffectTrace.isEnabled();
};

const normalize = (value: string | null | undefined) => value?.trim() ?? "";
const scopeKey = (sessionId: string, messageId: string, target: TranscriptWriteTarget, partId?: string) =>
  [normalize(sessionId), normalize(messageId), target, normalize(partId)].join("\0");
const projectionScopeKey = (stage: TranscriptProjectionStage, sessionId: string) =>
  [stage, normalize(sessionId)].join("\0");

const viewportTupleEquals = (left: TranscriptViewportInputTuple, right: TranscriptViewportInputTuple) =>
  left.canonicalArrayIdentity === right.canonicalArrayIdentity
  && left.localEchoIdentity === right.localEchoIdentity
  && left.searchActive === right.searchActive
  && left.windowExpanded === right.windowExpanded
  && left.windowStart === right.windowStart
  && left.selectedDisplaySession === right.selectedDisplaySession;

const identityOf = (value: object) => {
  const existing = objectIdentity.get(value);
  if (existing) return existing;
  const identity = nextObjectIdentity++;
  objectIdentity.set(value, identity);
  return identity;
};

const describeVisibleTranscriptShape = (messages: MessageWithParts[]) => {
  let assistantMessageCount = 0;
  let assistantTextPartCount = 0;
  let assistantTextCharacterCount = 0;
  let assistantToolPartCount = 0;
  for (const message of messages) {
    if ((message.info as { role?: unknown }).role !== "assistant") continue;
    assistantMessageCount += 1;
    for (const part of message.parts) {
      const record = part as { type?: unknown; text?: unknown };
      if (record.type === "text") {
        assistantTextPartCount += 1;
        if (typeof record.text === "string") assistantTextCharacterCount += record.text.length;
      }
      if (record.type === "tool") assistantToolPartCount += 1;
    }
  }
  return { assistantMessageCount, assistantTextPartCount, assistantTextCharacterCount, assistantToolPartCount };
};

const pruneCauses = () => {
  while (causeOrder.length > MAX_CAUSES) {
    const evicted = causeOrder.shift();
    if (!evicted) continue;
    const current = causeByTarget.get(evicted.targetKey);
    if (current?.causeId === evicted.causeId) causeByTarget.delete(evicted.targetKey);
  }
};

/** Records an actual store write immediately before it is applied. */
export const recordTranscriptStoreWrite = (
  owner: TranscriptWriteOwner,
  target: TranscriptWriteTarget,
  sessionId: string,
  messageId: string,
  partId?: string,
): TranscriptWriteCause | null => {
  if (!transcriptWriteDiagnosticsEnabled()) return null;
  const cause: TranscriptWriteCause = {
    revision: (nextWriteRevision += 1),
    owner,
    target,
    sessionId: normalize(sessionId),
    messageId: normalize(messageId),
    partId: normalize(partId) || undefined,
    causeId: `tw-${nextCauseIdentity++}`,
  };
  const key = scopeKey(cause.sessionId, cause.messageId, cause.target, cause.partId);
  causeByTarget.set(key, cause);
  // Keep the target key alongside the cause so a bounded sidecar cannot grow
  // with an indefinitely streaming session.
  causeOrder.push({ targetKey: key, causeId: cause.causeId });
  pruneCauses();
  uiEffectTrace.record("ui-transcript:store-write", {
    writeRevision: cause.revision,
    owner: cause.owner,
    target: cause.target,
    sessionId: cause.sessionId,
    messageId: cause.messageId,
    partId: cause.partId ?? null,
  });
  recordSendWorkflowTrace("session-transcript", "session-transcript:store-write", {
    writeRevision: cause.revision,
    owner: cause.owner,
    target: cause.target,
    sessionId: cause.sessionId,
    messageId: cause.messageId,
    partId: cause.partId ?? null,
  });
  return cause;
};

/** Monotonic only while the explicit dev diagnostic is enabled. */
export const transcriptWriteRevision = () =>
  transcriptWriteDiagnosticsEnabled() ? nextWriteRevision : 0;

/**
 * Records an allocation boundary once per changed array reference. The event is
 * kept in the UI-effect ring; MessageList markers carry only its revision.
 */
export const observeTranscriptProjectionBoundary = (
  stage: TranscriptProjectionStage,
  sessionId: string | null | undefined,
  messages: MessageWithParts[],
): TranscriptProjectionBoundary | null => {
  if (!transcriptWriteDiagnosticsEnabled()) return null;
  const normalizedSessionId = normalize(sessionId);
  const key = projectionScopeKey(stage, normalizedSessionId);
  const previous = projectionBoundaryByScope.get(key);
  if (previous?.messages === messages) {
    return {
      stage,
      sessionId: normalizedSessionId,
      revision: previous.revision,
      arrayIdentity: previous.arrayIdentity,
      messageCount: previous.messageCount,
      assistantMessageCount: previous.assistantMessageCount,
      assistantTextPartCount: previous.assistantTextPartCount,
      assistantTextCharacterCount: previous.assistantTextCharacterCount,
      assistantToolPartCount: previous.assistantToolPartCount,
    };
  }
  const transcriptShape = describeVisibleTranscriptShape(messages);
  const boundary = {
    stage,
    sessionId: normalizedSessionId,
    revision: (previous?.revision ?? 0) + 1,
    arrayIdentity: identityOf(messages),
    messageCount: messages.length,
    ...transcriptShape,
    messages,
  };
  projectionBoundaryByScope.set(key, boundary);
  const snapshot: TranscriptProjectionBoundary = {
    stage,
    sessionId: normalizedSessionId,
    revision: boundary.revision,
    arrayIdentity: boundary.arrayIdentity,
    messageCount: boundary.messageCount,
    assistantMessageCount: boundary.assistantMessageCount,
    assistantTextPartCount: boundary.assistantTextPartCount,
    assistantTextCharacterCount: boundary.assistantTextCharacterCount,
    assistantToolPartCount: boundary.assistantToolPartCount,
  };
  uiEffectTrace.record("ui-transcript:projection-boundary", snapshot);
  recordSendWorkflowTrace("session-transcript", "session-transcript:projection-boundary", snapshot);
  return snapshot;
};

/**
 * Records the viewport's exact identity inputs alongside its output boundary.
 * The tuple is content-free and lets a trace distinguish a real projection
 * change from allocation churn caused by unrelated reactive work.
 */
export const observeTranscriptViewportProjectionBoundary = (input: {
  sessionId: string | null | undefined;
  canonicalMessages: MessageWithParts[];
  localSubmittedMessage: MessageWithParts | null;
  searchActive: boolean;
  windowExpanded: boolean;
  windowStart: number;
  renderedMessages: MessageWithParts[];
}): TranscriptViewportProjectionBoundary | null => {
  if (!transcriptWriteDiagnosticsEnabled()) return null;
  const sessionId = normalize(input.sessionId);
  const key = projectionScopeKey("viewport-rendered", sessionId);
  const previous = projectionBoundaryByScope.get(key);
  const inputTuple: TranscriptViewportInputTuple = {
    canonicalArrayIdentity: identityOf(input.canonicalMessages),
    localEchoIdentity: input.localSubmittedMessage ? identityOf(input.localSubmittedMessage) : null,
    searchActive: input.searchActive,
    windowExpanded: input.windowExpanded,
    windowStart: input.windowStart,
    selectedDisplaySession: sessionId,
  };
  const previousInputTuple = previous && "inputTuple" in previous
    ? (previous.inputTuple as TranscriptViewportInputTuple)
    : null;
  const outputIdentityChanged = previous?.messages !== input.renderedMessages;
  const tupleChanged = !previousInputTuple || !viewportTupleEquals(previousInputTuple, inputTuple);
  const boundary = observeTranscriptProjectionBoundary("viewport-rendered", sessionId, input.renderedMessages);
  if (!boundary) return null;
  const stored = projectionBoundaryByScope.get(key);
  if (stored) Object.assign(stored, { inputTuple });
  const snapshot: TranscriptViewportProjectionBoundary = {
    ...boundary,
    inputTuple,
    previousInputTuple,
    outputIdentityChanged,
  };
  if (tupleChanged || outputIdentityChanged) {
    uiEffectTrace.record("ui-transcript:viewport-projection", snapshot);
  }
  return snapshot;
};

export const describeTranscriptProjectionBoundary = (
  stage: TranscriptProjectionStage,
  sessionId: string | null | undefined,
) => {
  if (!transcriptWriteDiagnosticsEnabled()) return null;
  const boundary = projectionBoundaryByScope.get(projectionScopeKey(stage, normalize(sessionId)));
  if (!boundary) return null;
  return {
    stage: boundary.stage,
    sessionId: boundary.sessionId,
    revision: boundary.revision,
    arrayIdentity: boundary.arrayIdentity,
    messageCount: boundary.messageCount,
    assistantMessageCount: boundary.assistantMessageCount,
    assistantTextPartCount: boundary.assistantTextPartCount,
    assistantTextCharacterCount: boundary.assistantTextCharacterCount,
    assistantToolPartCount: boundary.assistantToolPartCount,
  } satisfies TranscriptProjectionBoundary;
};

const latestCause = (
  sessionId: string,
  messageId: string,
  target: TranscriptWriteTarget,
  partId?: string,
) => causeByTarget.get(scopeKey(sessionId, messageId, target, partId)) ?? null;

/**
 * Content-free object identities for the existing MessageList marker. This is
 * intentionally a pull API; reading it cannot create a Solid dependency.
 */
export const describeTranscriptSurfaceIdentities = (messages: MessageWithParts[]): TranscriptSurfaceIdentity[] =>
  !transcriptWriteDiagnosticsEnabled()
    ? []
    :
  messages.map((message) => {
    const messageId = normalize(String((message.info as { id?: unknown }).id ?? ""));
    const sessionId = normalize(String((message.info as { sessionID?: unknown }).sessionID ?? ""));
    return {
      messageId,
      messageIdentity: identityOf(message),
      infoIdentity: identityOf(message.info),
      partsIdentity: identityOf(message.parts),
      messageInfoCause: latestCause(sessionId, messageId, "message-info"),
      partsCause: latestCause(sessionId, messageId, "parts"),
      partIdentities: message.parts.map((part) => ({
        partId: normalize(String((part as { id?: unknown }).id ?? "")),
        identity: identityOf(part),
        cause: latestCause(sessionId, messageId, "part", String((part as { id?: unknown }).id ?? "")),
      })),
    };
  });

export const describeTranscriptCollectionCause = (messages: MessageWithParts[]): TranscriptWriteCause | null => {
  if (!transcriptWriteDiagnosticsEnabled()) return null;
  const first = messages.at(0);
  const sessionId = first ? normalize(String((first.info as { sessionID?: unknown }).sessionID ?? "")) : "";
  return sessionId ? latestCause(sessionId, "", "collection") : null;
};

export const resetTranscriptWriteDiagnosticsForTests = () => {
  causeByTarget.clear();
  causeOrder.splice(0, causeOrder.length);
  projectionBoundaryByScope.clear();
  nextObjectIdentity = 1;
  nextCauseIdentity = 1;
  nextWriteRevision = 0;
};

export const setTranscriptWriteDiagnosticsEnabledForTests = (enabled: boolean | null) => {
  diagnosticEnabledForTests = enabled;
};
