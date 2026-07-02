/**
 * Canonical join rules for the three id keyspaces a conversation can be
 * addressed by in the UI: the sidebar/session id, the Veslo conversation id,
 * and the OpenCode session id. Runtime state maps (status, busy) may be keyed
 * by any of them depending on which surface produced the entry, so every
 * lookup must consider the full candidate set. Keep this module the single
 * owner of that rule instead of re-implementing the join at call sites.
 */
export type SessionIdentityScope = {
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

export type SessionIdentityRecord = {
  id: string;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

/**
 * Ordered, de-duplicated, non-empty candidate ids for a session reference.
 * The primary id stays first so direct hits win before scope-derived aliases.
 */
export function sessionIdentityCandidates(
  sessionId: string | null | undefined,
  scope?: SessionIdentityScope | null,
): string[] {
  const ids = [
    sessionId?.trim() ?? "",
    scope?.opencodeSessionId?.trim() ?? "",
    scope?.conversationId?.trim() ?? "",
  ].filter(Boolean);
  return [...new Set(ids)];
}

/** True when `candidateId` addresses `session` through any of its id aliases. */
export function sessionIdentityMatches(
  candidateId: string | null | undefined,
  session: SessionIdentityRecord,
): boolean {
  const id = candidateId?.trim() ?? "";
  if (!id) return false;
  return sessionIdentityCandidates(session.id, session).includes(id);
}
