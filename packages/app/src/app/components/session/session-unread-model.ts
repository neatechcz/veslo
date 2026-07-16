export type UnreadSessionMap = Record<string, true>;

const normalizeSessionId = (value: string | null | undefined) => (value ?? "").trim();

export function markUnreadAfterAssistantResponse(
  current: UnreadSessionMap,
  input: {
    responseSessionId: string | null | undefined;
    selectedSessionId: string | null | undefined;
    appFocused: boolean;
  },
): UnreadSessionMap {
  const responseSessionId = normalizeSessionId(input.responseSessionId);
  if (!responseSessionId) return current;

  const selectedSessionId = normalizeSessionId(input.selectedSessionId);
  const activelyReading = input.appFocused && selectedSessionId === responseSessionId;
  if (activelyReading) return current;
  if (Object.hasOwn(current, responseSessionId)) return current;

  return {
    ...current,
    [responseSessionId]: true,
  };
}

export function clearUnreadSession(
  current: UnreadSessionMap,
  sessionId: string | null | undefined,
): UnreadSessionMap {
  const id = normalizeSessionId(sessionId);
  if (!id || !Object.hasOwn(current, id)) return current;

  const next = { ...current };
  delete next[id];
  return next;
}

export function pruneUnreadSessions(
  current: UnreadSessionMap,
  existingSessionIds: ReadonlySet<string>,
): UnreadSessionMap {
  let changed = false;
  const next: UnreadSessionMap = {};

  for (const sessionId of Object.keys(current)) {
    if (!existingSessionIds.has(sessionId)) {
      changed = true;
      continue;
    }
    next[sessionId] = true;
  }

  return changed ? next : current;
}
