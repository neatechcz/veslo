import type { ComposerDraft, ComposerPart } from "../types";

const NO_SESSION_DRAFT_KEY = "__no-session__";

const normalizeDraftSessionKey = (sessionId: string | null | undefined) => {
  const trimmed = (sessionId ?? "").trim();
  return trimmed || NO_SESSION_DRAFT_KEY;
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
  sessionId: string | null | undefined,
): ComposerDraft => {
  const key = normalizeDraftSessionKey(sessionId);
  return cloneComposerDraft(draftsBySessionId[key] ?? createEmptyComposerDraft());
};

export const setSessionComposerDraft = (
  draftsBySessionId: Record<string, ComposerDraft>,
  sessionId: string | null | undefined,
  draft: ComposerDraft,
): Record<string, ComposerDraft> => {
  const key = normalizeDraftSessionKey(sessionId);
  return {
    ...draftsBySessionId,
    [key]: cloneComposerDraft(draft),
  };
};

export const setSessionComposerPrompt = (
  draftsBySessionId: Record<string, ComposerDraft>,
  sessionId: string | null | undefined,
  prompt: string,
): Record<string, ComposerDraft> => setSessionComposerDraft(
  draftsBySessionId,
  sessionId,
  createEmptyComposerDraft(prompt),
);

export const deleteSessionComposerDraft = (
  draftsBySessionId: Record<string, ComposerDraft>,
  sessionId: string | null | undefined,
): Record<string, ComposerDraft> => {
  const key = normalizeDraftSessionKey(sessionId);
  if (!(key in draftsBySessionId)) return draftsBySessionId;
  const next = { ...draftsBySessionId };
  delete next[key];
  return next;
};
