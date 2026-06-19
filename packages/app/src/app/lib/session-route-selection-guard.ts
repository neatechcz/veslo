type SessionRouteSelectionGuardInput = {
  sessionsLoaded: boolean;
  routeSessionId: string;
  routeWorkspaceId?: string | null;
  activeWorkspaceId?: string | null;
  sessionIdsInStore: string[];
  sessionIdsInSidebar: string[];
  scopedSessionIds?: string[];
  selectedSessionId?: string | null;
  visibleMessageCount?: number;
  selectedSessionStatus?: string | null;
  selectedSessionLoadingEarlierMessages?: boolean;
};

const includesNormalizedId = (ids: string[], sessionId: string) => {
  const target = sessionId.trim();
  if (!target) return false;
  return ids.some((id) => id.trim() === target);
};

export const shouldFallbackFromSessionRoute = (
  input: SessionRouteSelectionGuardInput,
) => {
  const routeSessionId = input.routeSessionId.trim();
  if (!routeSessionId) return false;
  const routeWorkspaceId = input.routeWorkspaceId?.trim() ?? "";
  const activeWorkspaceId = input.activeWorkspaceId?.trim() ?? "";
  if (includesNormalizedId(input.sessionIdsInStore, routeSessionId)) return false;
  if (includesNormalizedId(input.sessionIdsInSidebar, routeSessionId)) return false;
  if (includesNormalizedId(input.scopedSessionIds ?? [], routeSessionId)) return false;

  const selectedSessionId = input.selectedSessionId?.trim() ?? "";
  if (selectedSessionId === routeSessionId) {
    const visibleMessageCount = Math.max(0, Math.floor(input.visibleMessageCount ?? 0));
    const selectedSessionStatus = input.selectedSessionStatus?.trim() || "idle";
    if (
      visibleMessageCount > 0 ||
      selectedSessionStatus !== "idle" ||
      input.selectedSessionLoadingEarlierMessages === true
    ) {
      return false;
    }
  }

  if (routeWorkspaceId && activeWorkspaceId && routeWorkspaceId !== activeWorkspaceId) return true;
  if (!input.sessionsLoaded) return false;
  return true;
};
