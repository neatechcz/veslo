const normalize = (value: string | null | undefined) => value?.trim() ?? "";

export const scopedSessionStatusKey = (
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
) => {
  const workspace = normalize(workspaceId);
  const session = normalize(sessionId);
  return workspace && session ? `${workspace}\0${session}` : "";
};

const sessionStatusLookupKeys = (
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
) => {
  const session = normalize(sessionId);
  if (!session) return [];
  const scoped = scopedSessionStatusKey(workspaceId, session);
  return scoped ? [scoped, session] : [session];
};

export const readSessionStatus = (
  statuses: Record<string, string> | null | undefined,
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
  fallback = "idle",
) => {
  const map = statuses ?? {};
  for (const key of sessionStatusLookupKeys(workspaceId, sessionId)) {
    const status = map[key]?.trim();
    if (status) return status;
  }
  return fallback;
};

export const readScopedSessionStatus = (
  statuses: Record<string, string> | null | undefined,
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
  fallback = "idle",
) => {
  const key = scopedSessionStatusKey(workspaceId, sessionId);
  const status = key ? statuses?.[key]?.trim() : "";
  return status || fallback;
};

export const withSessionStatus = (
  current: Record<string, string>,
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
  status: string,
) => {
  const session = normalize(sessionId);
  if (!session) return current;
  const normalizedStatus = status.trim() || "idle";
  const scoped = scopedSessionStatusKey(workspaceId, session);
  // Keep both keys in sync for the legacy unscoped lookup, but do not publish a
  // new map when they already contain the exact compatible representation.
  // Session.status is emitted repeatedly while a run is active; allocating a
  // fresh map for the same status invalidates unrelated consumers.
  if (
    current[session] === normalizedStatus &&
    (!scoped || current[scoped] === normalizedStatus)
  ) {
    return current;
  }
  return {
    ...current,
    [session]: normalizedStatus,
    ...(scoped ? { [scoped]: normalizedStatus } : {}),
  };
};

export const withoutSessionStatus = (
  current: Record<string, string>,
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
) => {
  const session = normalize(sessionId);
  if (!session) return current;
  const scoped = scopedSessionStatusKey(workspaceId, session);
  const next = { ...current };
  if (scoped) delete next[scoped];
  const otherScopedKey = Object.keys(next).find((key) => key.endsWith(`\0${session}`));
  if (otherScopedKey) {
    next[session] = next[otherScopedKey] ?? next[session] ?? "idle";
  } else {
    delete next[session];
  }
  return next;
};

export const pickSessionStatusSnapshot = (
  statuses: Record<string, string>,
  workspaceId: string | null | undefined,
  sessionIds: ReadonlySet<string>,
) => {
  const next: Record<string, string> = {};
  for (const sessionId of sessionIds) {
    const session = normalize(sessionId);
    if (!session) continue;
    if (statuses[session] !== undefined) next[session] = statuses[session];
    const scoped = scopedSessionStatusKey(workspaceId, session);
    if (scoped && statuses[scoped] !== undefined) next[scoped] = statuses[scoped];
  }
  return next;
};
