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

const cloneComposerPart = (part: ComposerPart): ComposerPart => {
  if (part.type === "text") return { ...part };
  if (part.type === "agent") return { ...part };
  if (part.type === "file") return { ...part };
  return { ...part };
};

const cloneComposerDraft = (draft: ComposerDraft): ComposerDraft => ({
  mode: draft.mode,
  parts: draft.parts.map(cloneComposerPart),
  attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  text: draft.text,
  resolvedText: draft.resolvedText,
  command: draft.command ? { ...draft.command } : undefined,
});

export const createEmptyComposerDraft = (text = ""): ComposerDraft => ({
  mode: "prompt",
  parts: text ? [{ type: "text", text }] : [],
  attachments: [],
  text,
  resolvedText: text,
});

export const getSessionComposerDraft = (
  draftsBySessionId: Record<string, ComposerDraft>,
  target: ComposerDraftStorageTarget,
): ComposerDraft => {
  const key = resolveDraftStorageKey(target);
  return cloneComposerDraft(draftsBySessionId[key] ?? createEmptyComposerDraft());
};

export const setSessionComposerDraft = (
  draftsBySessionId: Record<string, ComposerDraft>,
  target: ComposerDraftStorageTarget,
  draft: ComposerDraft,
): Record<string, ComposerDraft> => {
  const key = resolveDraftStorageKey(target);
  return {
    ...draftsBySessionId,
    [key]: cloneComposerDraft(draft),
  };
};

export const setSessionComposerPrompt = (
  draftsBySessionId: Record<string, ComposerDraft>,
  target: ComposerDraftStorageTarget,
  prompt: string,
): Record<string, ComposerDraft> => setSessionComposerDraft(
  draftsBySessionId,
  target,
  createEmptyComposerDraft(prompt),
);

export const deleteSessionComposerDraft = (
  draftsBySessionId: Record<string, ComposerDraft>,
  target: ComposerDraftStorageTarget,
): Record<string, ComposerDraft> => {
  const key = resolveDraftStorageKey(target);
  if (!(key in draftsBySessionId)) return draftsBySessionId;
  const next = { ...draftsBySessionId };
  delete next[key];
  return next;
};
