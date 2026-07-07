export type UiConversationScope = {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  directory: string;
  conversationId?: string;
  opencodeSessionId?: string;
  updatedAt: number;
};

export type UiConversationScopeInput = {
  sessionId?: string | null;
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
  updatedAt?: number | null;
};

export type UiConversationScopeMap = Record<string, UiConversationScope[]>;

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

const optionalText = (value: string | null | undefined) => {
  const normalized = normalizeText(value);
  return normalized || undefined;
};

const scopeKey = (scope: UiConversationScope) =>
  [
    scope.workspaceId,
    scope.directory,
    scope.conversationId ?? "",
    scope.opencodeSessionId ?? "",
  ].join("\0");

const matchesScopeIdentity = (left: UiConversationScope, right: UiConversationScope) => {
  if (left.workspaceId !== right.workspaceId || left.directory !== right.directory) return false;
  if (left.sessionId === right.sessionId) return true;
  if (left.conversationId && right.conversationId && left.conversationId === right.conversationId) {
    return true;
  }
  if (left.opencodeSessionId && right.opencodeSessionId && left.opencodeSessionId === right.opencodeSessionId) {
    return true;
  }
  return false;
};

export function normalizeUiConversationScope(
  input: UiConversationScopeInput,
): UiConversationScope | null {
  const sessionId = normalizeText(input.sessionId);
  const workspaceId = normalizeText(input.workspaceId);
  if (!sessionId || !workspaceId) return null;

  const workspaceRoot = normalizeText(input.workspaceRoot) || normalizeText(input.directory);
  const directory = normalizeText(input.directory) || workspaceRoot;
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? Math.floor(input.updatedAt)
      : Date.now();

  return {
    sessionId,
    workspaceId,
    workspaceRoot,
    directory,
    ...(optionalText(input.conversationId) ? { conversationId: optionalText(input.conversationId) } : {}),
    ...(optionalText(input.opencodeSessionId) ? { opencodeSessionId: optionalText(input.opencodeSessionId) } : {}),
    updatedAt,
  };
}

export function upsertUiConversationScope(
  current: UiConversationScopeMap,
  input: UiConversationScopeInput,
): UiConversationScopeMap {
  const normalized = normalizeUiConversationScope(input);
  if (!normalized) return current;

  const keys = new Set<string>();
  keys.add(normalized.sessionId);
  if (normalized.opencodeSessionId) keys.add(normalized.opencodeSessionId);
  if (normalized.conversationId) keys.add(normalized.conversationId);

  let changed = false;
  const next: UiConversationScopeMap = { ...current };

  for (const key of keys) {
    const existingList = current[key] ?? [];
    const keyedScope: UiConversationScope = {
      ...normalized,
      sessionId: key,
    };
    const targetKey = scopeKey(keyedScope);
    const index = existingList.findIndex(
      (scope) => scopeKey(scope) === targetKey || matchesScopeIdentity(scope, keyedScope),
    );
    let list: UiConversationScope[];
    if (index === -1) {
      list = [...existingList, keyedScope];
    } else {
      const previous = existingList[index];
      const merged: UiConversationScope = {
        ...previous,
        ...keyedScope,
        workspaceRoot: keyedScope.workspaceRoot || previous.workspaceRoot,
        directory: keyedScope.directory || previous.directory,
        conversationId: keyedScope.conversationId ?? previous.conversationId,
        opencodeSessionId: keyedScope.opencodeSessionId ?? previous.opencodeSessionId,
        updatedAt: Math.max(previous.updatedAt, keyedScope.updatedAt),
      };
      list = existingList.slice();
      list[index] = merged;
    }
    next[key] = list
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
    changed = true;
  }

  return changed ? next : current;
}

export function resolveUiConversationScope(
  current: UiConversationScopeMap,
  sessionId: string | null | undefined,
  options?: {
    activeWorkspaceId?: string | null;
    selectedScope?: UiConversationScopeInput | null;
  },
): UiConversationScope | null {
  const id = normalizeText(sessionId);
  if (!id) return null;

  const selected = normalizeUiConversationScope(options?.selectedScope ?? {});
  if (selected?.sessionId === id) return selected;
  if (selected?.opencodeSessionId === id || selected?.conversationId === id) {
    return { ...selected, sessionId: id };
  }

  const candidates = current[id] ?? [];
  if (candidates.length === 0) return null;

  const activeWorkspaceId = normalizeText(options?.activeWorkspaceId);
  const activeMatches = activeWorkspaceId
    ? candidates.filter((scope) => scope.workspaceId === activeWorkspaceId)
    : [];
  if (activeMatches.length === 1) return activeMatches[0] ?? null;
  if (candidates.length === 1) return candidates[0] ?? null;

  return null;
}
