import type { VesloConversationQueueItem } from "../../lib/veslo-server.js";

export type ServerQueuedRunProjection = VesloConversationQueueItem & {
  scopeKey: string;
  uiConversationKey: string;
};

export type ServerQueuedRunProjectionScope = {
  workspaceId: string;
  conversationId: string;
  uiConversationKey: string;
};

export type ServerQueuedRunVisibilityScope = {
  workspaceId: string;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
  uiConversationKey?: string | null;
};

export const serverQueuedRunScopeKey = (workspaceId: string, conversationId: string) =>
  `${workspaceId.trim()}\0${conversationId.trim()}`;

export const projectServerQueuedRun = (
  item: VesloConversationQueueItem,
  uiConversationKey: string,
): ServerQueuedRunProjection => ({
  ...item,
  scopeKey: serverQueuedRunScopeKey(item.workspaceId, item.conversationId),
  uiConversationKey: uiConversationKey.trim(),
});

export const upsertServerQueuedRunProjection = (
  current: ServerQueuedRunProjection[],
  item: VesloConversationQueueItem,
  uiConversationKey: string,
): ServerQueuedRunProjection[] => {
  const projected = projectServerQueuedRun(item, uiConversationKey);
  const index = current.findIndex((candidate) => candidate.queueItemId === projected.queueItemId);
  if (index === -1) return [...current, projected];
  const next = [...current];
  next[index] = projected;
  return next;
};

export const replaceServerQueuedRunScope = (
  current: ServerQueuedRunProjection[],
  scope: ServerQueuedRunProjectionScope,
  items: VesloConversationQueueItem[],
): ServerQueuedRunProjection[] => {
  const scopeKey = serverQueuedRunScopeKey(scope.workspaceId, scope.conversationId);
  const outsideScope = current.filter((item) => item.scopeKey !== scopeKey);
  const scoped = items.map((item) => projectServerQueuedRun(item, scope.uiConversationKey));
  return [...outsideScope, ...scoped];
};

export const serverQueuedRunsForScope = (
  current: ServerQueuedRunProjection[],
  workspaceId: string,
  conversationId: string,
) => current.filter((item) => item.scopeKey === serverQueuedRunScopeKey(workspaceId, conversationId));

export const serverQueuedRunsForVisibleConversation = (
  current: ServerQueuedRunProjection[],
  scope: ServerQueuedRunVisibilityScope,
) => {
  const workspaceId = scope.workspaceId.trim();
  const conversationId = scope.conversationId?.trim() ?? "";
  const opencodeSessionId = scope.opencodeSessionId?.trim() ?? "";
  const uiConversationKey = scope.uiConversationKey?.trim() ?? "";
  return current.filter(
    (item) =>
      item.workspaceId === workspaceId &&
      (item.uiConversationKey === uiConversationKey ||
        (conversationId !== "" && item.conversationId === conversationId) ||
        (opencodeSessionId !== "" && item.opencodeSessionId === opencodeSessionId)),
  );
};
