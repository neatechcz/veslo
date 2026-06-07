import type { Session } from "@opencode-ai/sdk/v2/client";

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

export const deriveSidebarRowsFromSessionStore = (
  input: SidebarSessionStoreSyncInput,
): SidebarSessionItem[] => {
  const requestLimit = normalizeLimit(input.requestLimit);
  const visibleRows = input
    .expandVisibleSessions(input.incomingSessions, requestLimit)
    .map(input.mapSession);
  if (input.existingRows.length === 0) return visibleRows;

  const incomingIds = new Set(visibleRows.map((item) => item.id.trim()).filter(Boolean));
  const retainedRows = input.existingRows.filter((item) => {
    const id = item.id.trim();
    return id && !incomingIds.has(id);
  });

  return [...visibleRows, ...retainedRows];
};
