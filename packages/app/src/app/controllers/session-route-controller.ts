export type RouteResumeDecision =
  | { type: "ignore"; reason: "not-session-route" | "empty-session-id" | "pending-session" | "foreign-workspace" | "same-key" | "already-loaded" | "loading-earlier-messages" | "workspace-not-ready" | "route-session-not-ready" }
  | { type: "consume-own-navigation"; sessionId: string; connectionKey: string }
  | { type: "select-session"; sessionId: string; connectionKey: string };

export type ResolveRouteResumeDecisionInput = {
  path: string;
  routeSessionId?: string | null;
  isPendingSession: boolean;
  routeWorkspaceId?: string | null;
  activeWorkspaceId?: string | null;
  connectionKey: string;
  lastConnectionKey: string;
  routeConversationKey?: string | null;
  lastRouteConversationKey?: string | null;
  workspaceReady?: boolean;
  routeSessionKnown?: boolean;
  sessionsLoaded?: boolean;
  selectedSessionId?: string | null;
  hasBrowseScope: boolean;
  visibleMessageCount: number;
  selectedSessionLoadingEarlierMessages: boolean;
  ownNavigationSessionId?: string | null;
};

const trim = (value: string | null | undefined) => value?.trim() ?? "";

export function resolveRouteResumeDecision(input: ResolveRouteResumeDecisionInput): RouteResumeDecision {
  const path = trim(input.path).toLowerCase();
  if (!path.startsWith("/session/")) return { type: "ignore", reason: "not-session-route" };

  const sessionId = trim(input.routeSessionId);
  if (!sessionId) return { type: "ignore", reason: "empty-session-id" };
  if (input.isPendingSession) return { type: "ignore", reason: "pending-session" };

  const routeWorkspaceId = trim(input.routeWorkspaceId);
  const activeWorkspaceId = trim(input.activeWorkspaceId);
  const workspaceReady = input.workspaceReady ?? Boolean(routeWorkspaceId || activeWorkspaceId);
  if (!workspaceReady) return { type: "ignore", reason: "workspace-not-ready" };

  if (routeWorkspaceId && activeWorkspaceId && routeWorkspaceId !== activeWorkspaceId) {
    return { type: "ignore", reason: "foreign-workspace" };
  }

  if (input.connectionKey === input.lastConnectionKey) return { type: "ignore", reason: "same-key" };

  const selectedSessionId = trim(input.selectedSessionId);
  if (trim(input.ownNavigationSessionId) === sessionId && selectedSessionId === sessionId) {
    return { type: "consume-own-navigation", sessionId, connectionKey: input.connectionKey };
  }

  if (!input.hasBrowseScope && selectedSessionId === sessionId && input.visibleMessageCount > 0) {
    return { type: "ignore", reason: "already-loaded" };
  }

  if (!input.routeSessionKnown && input.sessionsLoaded === false) {
    return { type: "ignore", reason: "route-session-not-ready" };
  }

  const routeConversationKey = trim(input.routeConversationKey);
  const lastRouteConversationKey = trim(input.lastRouteConversationKey);
  if (
    input.hasBrowseScope &&
    selectedSessionId === sessionId &&
    input.visibleMessageCount > 0 &&
    routeConversationKey &&
    routeConversationKey === lastRouteConversationKey
  ) {
    return { type: "ignore", reason: "already-loaded" };
  }

  if (input.selectedSessionLoadingEarlierMessages) {
    return { type: "ignore", reason: "loading-earlier-messages" };
  }

  return { type: "select-session", sessionId, connectionKey: input.connectionKey };
}

export type SessionPathDecision =
  | { type: "clear-session-view"; preservePendingDraft: boolean }
  | { type: "select-pending-session"; sessionId: string }
  | { type: "fallback-to-session-list"; clearSelectedSession: boolean }
  | { type: "consume-own-navigation"; sessionId: string }
  | { type: "select-session"; sessionId: string }
  | { type: "ignore"; reason: "not-session-route" | "already-selected" | "empty-session-id" | "own-navigation-pending" | "workspace-not-ready" | "route-session-not-ready" };

export type ResolveSessionPathDecisionInput = {
  path: string;
  routeSessionId?: string | null;
  activePendingDraftKey?: string | null;
  selectedSessionId?: string | null;
  isPendingSession: boolean;
  shouldFallbackFromRoute: boolean;
  ownNavigationSessionId?: string | null;
  workspaceReady?: boolean;
  routeSessionKnown?: boolean;
  sessionsLoaded?: boolean;
};

export function resolveSessionPathDecision(input: ResolveSessionPathDecisionInput): SessionPathDecision {
  const path = trim(input.path).toLowerCase();
  if (!path.startsWith("/session")) return { type: "ignore", reason: "not-session-route" };

  const sessionId = trim(input.routeSessionId);
  const selectedSessionId = trim(input.selectedSessionId);
  if (!sessionId) {
    const ownNavigationSessionId = trim(input.ownNavigationSessionId);
    if (ownNavigationSessionId && selectedSessionId === ownNavigationSessionId) {
      return { type: "ignore", reason: "own-navigation-pending" };
    }
    if (!selectedSessionId) return { type: "ignore", reason: "empty-session-id" };
    return { type: "clear-session-view", preservePendingDraft: Boolean(trim(input.activePendingDraftKey)) };
  }

  if (input.isPendingSession) {
    if (selectedSessionId === sessionId) return { type: "ignore", reason: "already-selected" };
    return { type: "select-pending-session", sessionId };
  }

  if (input.workspaceReady === false) return { type: "ignore", reason: "workspace-not-ready" };
  if (!input.routeSessionKnown && input.sessionsLoaded === false) {
    return { type: "ignore", reason: "route-session-not-ready" };
  }

  if (input.shouldFallbackFromRoute) {
    return { type: "fallback-to-session-list", clearSelectedSession: selectedSessionId === sessionId };
  }

  if (trim(input.ownNavigationSessionId) === sessionId && selectedSessionId === sessionId) {
    return { type: "consume-own-navigation", sessionId };
  }

  if (selectedSessionId === sessionId) return { type: "ignore", reason: "already-selected" };
  return { type: "select-session", sessionId };
}
