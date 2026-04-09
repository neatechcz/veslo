type SessionRouteSelectionGuardInput = {
  sessionsLoaded: boolean;
  routeSessionId: string;
  sessionIdsInStore: string[];
  sessionIdsInSidebar: string[];
};

const includesNormalizedId = (ids: string[], sessionId: string) => {
  const target = sessionId.trim();
  if (!target) return false;
  return ids.some((id) => id.trim() === target);
};

export const shouldFallbackFromSessionRoute = (
  input: SessionRouteSelectionGuardInput,
) => {
  if (!input.sessionsLoaded) return false;
  const routeSessionId = input.routeSessionId.trim();
  if (!routeSessionId) return false;
  if (includesNormalizedId(input.sessionIdsInStore, routeSessionId)) return false;
  if (includesNormalizedId(input.sessionIdsInSidebar, routeSessionId)) return false;
  return true;
};
