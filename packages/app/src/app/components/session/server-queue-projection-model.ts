import type { VesloConversationQueueItem } from "../../lib/veslo-server.js";

export type ServerQueuedRunProjection = VesloConversationQueueItem & {
  scopeKey: string;
  uiConversationKey: string;
  selectionGeneration: number;
};

export type ServerQueuedRunProjectionScope = {
  workspaceId: string;
  conversationId: string;
  uiConversationKey: string;
  /**
   * The UI scope key can recur after A -> B -> A. Keep the monotonic selection
   * generation with every read and rendered row so a response from the first
   * A cannot repaint the re-entered conversation.
   */
  selectionGeneration: number;
};

export type ServerQueuedRunVisibilityScope = {
  workspaceId: string;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
  uiConversationKey?: string | null;
  selectionGeneration?: number | null;
};

export const serverQueuedRunScopeKey = (workspaceId: string, conversationId: string) =>
  `${workspaceId.trim()}\0${conversationId.trim()}`;

const itemMatchesScope = (
  item: VesloConversationQueueItem,
  scope: Pick<ServerQueuedRunProjectionScope, "workspaceId" | "conversationId">,
) =>
  item.workspaceId === scope.workspaceId &&
  item.conversationId === scope.conversationId;

export const projectServerQueuedRun = (
  item: VesloConversationQueueItem,
  scope: Pick<ServerQueuedRunProjectionScope, "uiConversationKey" | "selectionGeneration">,
): ServerQueuedRunProjection => ({
  ...item,
  scopeKey: serverQueuedRunScopeKey(item.workspaceId, item.conversationId),
  uiConversationKey: scope.uiConversationKey.trim(),
  selectionGeneration: scope.selectionGeneration,
});

export const upsertServerQueuedRunProjection = (
  current: ServerQueuedRunProjection[],
  item: VesloConversationQueueItem,
  scope: ServerQueuedRunProjectionScope,
): ServerQueuedRunProjection[] => {
  // The route is scoped, but fail closed if a malformed or stale response is
  // ever routed here. Otherwise it could inherit the selected UI key.
  if (!itemMatchesScope(item, scope)) return current;
  const projected = projectServerQueuedRun(item, scope);
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
  const scoped = items
    .filter((item) => itemMatchesScope(item, scope))
    .map((item) => projectServerQueuedRun(item, scope));
  return [...outsideScope, ...scoped];
};

/**
 * Queue rows are a read-only presentation of one selected conversation, not a
 * client-side cache of the server queue. Keeping older selections made long
 * navigation sessions retain durable-looking rows that could only be refreshed
 * by revisiting their scope. Evict them at the selection boundary; a late fetch
 * is separately fenced by the controller and cannot republish the old scope.
 */
export const retainServerQueuedRunProjectionScope = (
  current: ServerQueuedRunProjection[],
  scope: ServerQueuedRunProjectionScope | null,
) => {
  if (!scope) return [];
  return current.filter(
    (item) =>
      item.scopeKey === serverQueuedRunScopeKey(scope.workspaceId, scope.conversationId) &&
      item.uiConversationKey === scope.uiConversationKey &&
      item.selectionGeneration === scope.selectionGeneration,
  );
};

export const serverQueuedRunsForScope = (
  current: ServerQueuedRunProjection[],
  scope: ServerQueuedRunProjectionScope,
) => current.filter(
  (item) =>
    item.scopeKey === serverQueuedRunScopeKey(scope.workspaceId, scope.conversationId) &&
    item.uiConversationKey === scope.uiConversationKey &&
    item.selectionGeneration === scope.selectionGeneration,
);

export const serverQueuedRunsForVisibleConversation = (
  current: ServerQueuedRunProjection[],
  scope: ServerQueuedRunVisibilityScope,
) => {
  const workspaceId = scope.workspaceId.trim();
  const conversationId = scope.conversationId?.trim() ?? "";
  const opencodeSessionId = scope.opencodeSessionId?.trim() ?? "";
  const uiConversationKey = scope.uiConversationKey?.trim() ?? "";
  const selectionGeneration = scope.selectionGeneration ?? null;
  return current.filter(
    (item) =>
      item.workspaceId === workspaceId &&
      item.selectionGeneration === selectionGeneration &&
      (conversationId !== ""
        ? item.conversationId === conversationId
        : item.uiConversationKey === uiConversationKey ||
          (opencodeSessionId !== "" && item.opencodeSessionId === opencodeSessionId)),
  );
};
