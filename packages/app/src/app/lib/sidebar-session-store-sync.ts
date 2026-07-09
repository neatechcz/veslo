import type { Session } from "@opencode-ai/sdk/v2/client";

import { findSidebarSessionItemMergeIndex } from "./sidebar-session-identity";
import type { SidebarSessionItem } from "../types";

export type SidebarSessionStoreSyncInput = {
  incomingSessions: Session[];
  existingRows: SidebarSessionItem[];
  requestLimit: number;
  mapSession: (session: Session) => SidebarSessionItem;
  expandVisibleSessions: (sessions: Session[], requestLimit: number) => Session[];
};

const normalizeLimit = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const mergeSidebarSessionStoreRow = (
  existing: SidebarSessionItem,
  incoming: SidebarSessionItem,
): SidebarSessionItem => ({
  ...existing,
  ...incoming,
  title: incoming.title?.trim() ? incoming.title : existing.title,
  slug: incoming.slug ?? existing.slug,
  parentID: incoming.parentID ?? existing.parentID,
  directory: incoming.directory ?? existing.directory,
  conversationId: incoming.conversationId ?? existing.conversationId,
  opencodeSessionId: incoming.opencodeSessionId ?? existing.opencodeSessionId,
  parentConversationId: incoming.parentConversationId ?? existing.parentConversationId,
  branchId: incoming.branchId ?? existing.branchId,
  pendingSessionInstanceId: incoming.pendingSessionInstanceId ?? existing.pendingSessionInstanceId,
  time: incoming.time ?? existing.time,
});

export const deriveSidebarRowsFromSessionStore = (
  input: SidebarSessionStoreSyncInput,
): SidebarSessionItem[] => {
  const requestLimit = normalizeLimit(input.requestLimit);
  const consumedExistingIndexes = new Set<number>();
  const visibleRows = input
    .expandVisibleSessions(input.incomingSessions, requestLimit)
    .map(input.mapSession)
    .map((item) => {
      const existingIndex = findSidebarSessionItemMergeIndex(input.existingRows, item);
      if (existingIndex === -1) return item;
      const existing = input.existingRows[existingIndex];
      if (!existing) return item;
      consumedExistingIndexes.add(existingIndex);
      return mergeSidebarSessionStoreRow(existing, item);
    });
  if (input.existingRows.length === 0) return visibleRows;

  const retainedRows = input.existingRows.filter((item, index) => item.id.trim() && !consumedExistingIndexes.has(index));

  return [...visibleRows, ...retainedRows];
};
