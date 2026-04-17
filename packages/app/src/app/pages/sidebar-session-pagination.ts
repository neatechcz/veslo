export const SIDEBAR_SESSION_PAGE_SIZE = 20;

export const initialSidebarSessionLimit = () => SIDEBAR_SESSION_PAGE_SIZE;

const normalizeSidebarPageLimit = (value: number) =>
  Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : SIDEBAR_SESSION_PAGE_SIZE;

const normalizeSidebarSessionId = (value: string | null | undefined) => value?.trim() ?? "";

export const nextSidebarSessionLimit = (current: number, step = SIDEBAR_SESSION_PAGE_SIZE) => {
  const safeCurrent = normalizeSidebarPageLimit(current);
  const safeStep = normalizeSidebarPageLimit(step);
  return safeCurrent + safeStep;
};

export const deriveSidebarHasMore = (fetchedCount: number, requestedLimit: number) =>
  fetchedCount >= requestedLimit;

export const expandSidebarSessionSliceWithAncestors = <
  T extends { id: string; parentID?: string | null },
>(
  sortedSessions: readonly T[],
  limit: number,
): T[] => {
  const safeLimit = normalizeSidebarPageLimit(limit);
  if (sortedSessions.length <= safeLimit) return [...sortedSessions];

  const sessionById = new Map<string, T>();
  for (const session of sortedSessions) {
    const sessionId = normalizeSidebarSessionId(session.id);
    if (!sessionId || sessionById.has(sessionId)) continue;
    sessionById.set(sessionId, session);
  }

  const expanded: T[] = [];
  const includedIds = new Set<string>();
  const addSession = (session: T | undefined) => {
    if (!session) return;
    const sessionId = normalizeSidebarSessionId(session.id);
    if (!sessionId || includedIds.has(sessionId)) return;
    includedIds.add(sessionId);
    expanded.push(session);
  };

  for (const session of sortedSessions.slice(0, safeLimit)) {
    addSession(session);
    let parentId = normalizeSidebarSessionId(session.parentID);
    while (parentId) {
      const parent = sessionById.get(parentId);
      addSession(parent);
      if (!parent) break;
      parentId = normalizeSidebarSessionId(parent.parentID);
    }
  }

  return expanded;
};
