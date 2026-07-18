import type { ComposerDraft, ComposerPart } from "../types";
import { isPendingDraftKey, resolveComposerStorageKey } from "../lib/pending-session-drafts";

type ComposerDraftStorageTarget =
  | string
  | null
  | undefined
  | {
    sessionId?: string | null;
    storageKey?: string | null;
  };

export type ComposerDraftStateEntry = {
  draft: ComposerDraft;
  revision: number;
};

/** The only owner of persisted composer draft state. */
export type ComposerDraftStateByStorageKey = Record<string, ComposerDraftStateEntry>;

export type ComposerDraftRemapResult =
  | { status: "moved"; state: ComposerDraftStateByStorageKey }
  | { status: "deduplicated"; state: ComposerDraftStateByStorageKey }
  | { status: "noop"; state: ComposerDraftStateByStorageKey }
  | { status: "conflict"; state: ComposerDraftStateByStorageKey };

/** Command boundary for draft mutations; consumers never receive the state updater. */
export type ComposerDraftStateCommands = {
  writeDraft: (storageKey: string, draft: ComposerDraft) => void;
  deleteDraft: (storageKey: string) => void;
  remapPendingDraft: (
    pendingDraftKey: string | null | undefined,
    sessionId: string | null | undefined,
  ) => ComposerDraftRemapResult;
  captureDraftRevision: (storageKey: string) => number;
  clearDraftIfRevision: (storageKey: string, expectedRevision: number) => boolean;
};

const resolveDraftStorageKey = (target: ComposerDraftStorageTarget) => {
  if (typeof target === "object" && target !== null) {
    const explicitStorageKey = (target.storageKey ?? "").trim();
    if (explicitStorageKey) {
      return isPendingDraftKey(explicitStorageKey)
        ? resolveComposerStorageKey({ pendingDraftKey: explicitStorageKey })
        : resolveComposerStorageKey({ sessionId: explicitStorageKey });
    }
    return resolveComposerStorageKey({ sessionId: target.sessionId });
  }

  return resolveComposerStorageKey({ sessionId: target });
};

const cloneComposerPart = (part: ComposerPart): ComposerPart => ({ ...part });

const cloneComposerDraft = (draft: ComposerDraft): ComposerDraft => ({
  mode: draft.mode,
  parts: draft.parts.map(cloneComposerPart),
  attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  text: draft.text,
  resolvedText: draft.resolvedText,
  command: draft.command ? { ...draft.command } : undefined,
});

const draftsEqual = (left: ComposerDraft, right: ComposerDraft) =>
  left.mode === right.mode
  && left.text === right.text
  && left.resolvedText === right.resolvedText
  && left.command?.name === right.command?.name
  && left.command?.arguments === right.command?.arguments
  && left.parts.length === right.parts.length
  && left.parts.every((part, index) => JSON.stringify(part) === JSON.stringify(right.parts[index]))
  && left.attachments.length === right.attachments.length
  && left.attachments.every((attachment, index) => JSON.stringify(attachment) === JSON.stringify(right.attachments[index]));

const nextEntry = (previous: ComposerDraftStateEntry | undefined, draft: ComposerDraft): ComposerDraftStateEntry | undefined => {
  if (previous && draftsEqual(previous.draft, draft)) return undefined;
  return {
    draft: cloneComposerDraft(draft),
    revision: (previous?.revision ?? 0) + 1,
  };
};

export const createEmptyComposerDraft = (text = ""): ComposerDraft => ({
  mode: "prompt",
  parts: text ? [{ type: "text", text }] : [],
  attachments: [],
  text,
  resolvedText: text,
});

export const getSessionComposerDraft = (
  draftsByStorageKey: ComposerDraftStateByStorageKey,
  target: ComposerDraftStorageTarget,
): ComposerDraft => draftsByStorageKey[resolveDraftStorageKey(target)]?.draft ?? createEmptyComposerDraft();

export const getSessionComposerDraftRevision = (
  draftsByStorageKey: ComposerDraftStateByStorageKey,
  target: ComposerDraftStorageTarget,
): number => draftsByStorageKey[resolveDraftStorageKey(target)]?.revision ?? 0;

/**
 * Select the one draft bucket that the mounted Composer must read. During the
 * first-session handoff the real session exists before route selection
 * finishes, so its target bucket must become visible immediately. Otherwise a
 * moved draft is briefly observed as an empty no-session bucket.
 */
export const resolveActiveComposerDraftStorageKey = ({
  selectedSessionId,
  pendingDraftKey,
  materializingSessionId,
}: {
  selectedSessionId?: string | null;
  pendingDraftKey?: string | null;
  materializingSessionId?: string | null;
}) => {
  const selected = selectedSessionId?.trim() ?? "";
  if (selected) return resolveComposerStorageKey({ sessionId: selected });

  const materializing = materializingSessionId?.trim() ?? "";
  if (materializing) return resolveComposerStorageKey({ sessionId: materializing });

  return resolveComposerStorageKey({ pendingDraftKey });
};

export const setSessionComposerDraft = (
  draftsByStorageKey: ComposerDraftStateByStorageKey,
  target: ComposerDraftStorageTarget,
  draft: ComposerDraft,
): ComposerDraftStateByStorageKey => {
  const key = resolveDraftStorageKey(target);
  const entry = nextEntry(draftsByStorageKey[key], draft);
  if (!entry) return draftsByStorageKey;
  return { ...draftsByStorageKey, [key]: entry };
};

export const setSessionComposerPrompt = (
  draftsByStorageKey: ComposerDraftStateByStorageKey,
  target: ComposerDraftStorageTarget,
  prompt: string,
): ComposerDraftStateByStorageKey => setSessionComposerDraft(
  draftsByStorageKey,
  target,
  createEmptyComposerDraft(prompt),
);

/**
 * Clear only the exact draft revision submitted by this Composer. A delayed
 * completion must never erase text typed after the send started or after a
 * pending draft was moved to its materialized session.
 */
export const clearSessionComposerDraftIfRevision = (
  draftsByStorageKey: ComposerDraftStateByStorageKey,
  target: ComposerDraftStorageTarget,
  expectedRevision: number,
): { cleared: boolean; state: ComposerDraftStateByStorageKey } => {
  const key = resolveDraftStorageKey(target);
  const previous = draftsByStorageKey[key];
  if (!previous || previous.revision !== expectedRevision) {
    return { cleared: false, state: draftsByStorageKey };
  }
  const entry = nextEntry(previous, createEmptyComposerDraft());
  if (!entry) return { cleared: false, state: draftsByStorageKey };
  return { cleared: true, state: { ...draftsByStorageKey, [key]: entry } };
};

/**
 * Move the global unpublished bucket before the real session is selected.
 * The moved entry keeps its revision: a conditional clear captured against the
 * old pending key will then fail safely because that key no longer exists.
 */
export const remapPendingComposerDraftToSession = (
  draftsByStorageKey: ComposerDraftStateByStorageKey,
  pendingDraftKey: string | null | undefined,
  sessionId: string | null | undefined,
): ComposerDraftRemapResult => {
  const pendingKey = pendingDraftKey?.trim() ?? "";
  const targetSessionId = sessionId?.trim() ?? "";
  if (!targetSessionId) return { status: "noop", state: draftsByStorageKey };

  // Before an explicit pending draft is selected, the first Composer owns the
  // no-session bucket. A first send materializes that same draft into a real
  // session, so it must transfer this entry rather than silently no-op.
  const sourceKey = pendingKey
    ? resolveComposerStorageKey({ pendingDraftKey: pendingKey })
    : resolveComposerStorageKey({ sessionId: null });
  const targetKey = resolveComposerStorageKey({ sessionId: targetSessionId });
  if (sourceKey === targetKey) return { status: "noop", state: draftsByStorageKey };

  const source = draftsByStorageKey[sourceKey];
  if (!source) return { status: "noop", state: draftsByStorageKey };
  const target = draftsByStorageKey[targetKey];
  if (target) {
    if (!draftsEqual(source.draft, target.draft)) {
      return { status: "conflict", state: draftsByStorageKey };
    }
    const state = { ...draftsByStorageKey };
    delete state[sourceKey];
    return { status: "deduplicated", state };
  }

  const state = { ...draftsByStorageKey, [targetKey]: source };
  delete state[sourceKey];
  return { status: "moved", state };
};

export const deleteSessionComposerDraft = (
  draftsByStorageKey: ComposerDraftStateByStorageKey,
  target: ComposerDraftStorageTarget,
): ComposerDraftStateByStorageKey => {
  const key = resolveDraftStorageKey(target);
  if (!(key in draftsByStorageKey)) return draftsByStorageKey;
  const next = { ...draftsByStorageKey };
  delete next[key];
  return next;
};
