export type UnreadSessionMap = Record<string, true>;

type MarkUnreadAfterAssistantResponseInput = {
  responseSessionId: string;
  selectedSessionId: string | null;
  appFocused: boolean;
};

export const markUnreadAfterAssistantResponse = (
  current: UnreadSessionMap,
  input: MarkUnreadAfterAssistantResponseInput,
): UnreadSessionMap => {
  if (input.appFocused && input.responseSessionId === input.selectedSessionId) {
    return current;
  }

  if (current[input.responseSessionId]) {
    return current;
  }

  return {
    ...current,
    [input.responseSessionId]: true,
  };
};

export const clearUnreadSession = (
  current: UnreadSessionMap,
  sessionId: string,
): UnreadSessionMap => {
  if (!current[sessionId]) {
    return current;
  }

  const { [sessionId]: _removed, ...next } = current;
  return next;
};

export const pruneUnreadSessions = (
  current: UnreadSessionMap,
  existingSessionIds: ReadonlySet<string>,
): UnreadSessionMap => {
  let changed = false;
  const next: UnreadSessionMap = {};

  for (const sessionId of Object.keys(current)) {
    if (existingSessionIds.has(sessionId)) {
      next[sessionId] = true;
    } else {
      changed = true;
    }
  }

  return changed ? next : current;
};
