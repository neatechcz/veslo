import { batch, createEffect } from "solid-js";

import {
  resolveRouteResumeDecision,
  resolveSessionPathDecision,
} from "../controllers/session-route-controller";
import { shouldFallbackFromSessionRoute } from "../lib/session-route-selection-guard";
import type {
  MessageWithParts,
  TodoItem,
  WorkspaceSessionGroup,
} from "../types";

export type SessionRouteBrowseScope = {
  sessionId?: string | null;
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

export type SessionRouteSyncDeps = {
  pathname: () => string;
  sidebarWorkspaceGroups: () => WorkspaceSessionGroup[];
  sessions: () => Array<{ id: string }>;
  scopedSessionIds: () => string[];
  resolveSelectedSessionBrowseScope: (sessionId: string) => SessionRouteBrowseScope | null;
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  clientDirectory: () => string;
  routedClient: (workspaceId?: string) => unknown;
  connectedVersion: () => string | number | null | undefined;
  sessionsLoadedForActiveWorkspace: () => boolean;
  selectedSessionId: () => string | null | undefined;
  visibleMessages: () => MessageWithParts[];
  selectedSessionLoadingEarlierMessages: () => boolean;
  activePendingDraftKey: () => string | null | undefined;
  activePendingDraftMeta: () => unknown;
  isPendingSessionInstanceId: (sessionId: string) => boolean;
  visibleSelectedSessionStatus: () => string | null | undefined;
  setSelectedSessionId: (sessionId: string | null) => void;
  setMessages: (messages: MessageWithParts[]) => void;
  setTodos: (todos: TodoItem[]) => void;
  selectSession: (sessionId: string) => Promise<void> | void;
  navigate: (to: string, options?: { replace?: boolean }) => void;
};

const routeSessionIdMatches = (ids: string[], sessionId: string) => {
  const id = sessionId.trim();
  if (!id) return false;
  return ids.some((item) => item.trim() === id);
};

export function createSessionRouteSync(deps: SessionRouteSyncDeps) {
  let lastRouteClientResumeKey = "";
  let lastRouteConversationKey = "";
  let routeResumeSelectionAlreadyHandledForSession = "";

  const routeSessionIdsInSidebar = () =>
    deps.sidebarWorkspaceGroups().flatMap((group) => group.sessions.map((session) => session.id));

  const routeSessionKnownFor = (
    sessionId: string,
    routeBrowseScope: SessionRouteBrowseScope | null,
    sessionIdsInStore = deps.sessions().map((session) => session.id),
    sessionIdsInSidebar = routeSessionIdsInSidebar(),
  ) => {
    const id = sessionId.trim();
    if (!id) return false;
    return Boolean(routeBrowseScope) ||
      routeSessionIdMatches(sessionIdsInStore, id) ||
      routeSessionIdMatches(sessionIdsInSidebar, id) ||
      routeSessionIdMatches(deps.scopedSessionIds(), id);
  };

  const routeConversationIdentityKeyFor = (
    sessionId: string,
    routeBrowseScope: SessionRouteBrowseScope | null,
  ) => {
    const id = sessionId.trim();
    if (!id) return "";
    const routeWorkspaceId =
      routeBrowseScope?.workspaceId?.trim() ||
      deps.activeWorkspaceId().trim();
    return [
      id,
      routeWorkspaceId,
      routeBrowseScope?.conversationId?.trim() || "",
      routeBrowseScope?.opencodeSessionId?.trim() || "",
    ].join("::");
  };

  const isRouteSelectedSession = (sessionId: string) => {
    const [, , sessionSegment] = deps.pathname().trim().split("/");
    return Boolean(sessionSegment?.trim() && sessionSegment.trim() === sessionId.trim());
  };

  const clearDisplayedSessionForBareRoute = () => {
    batch(() => {
      deps.setSelectedSessionId(null);
      deps.setMessages([]);
      deps.setTodos([]);
    });
  };

  const markOwnNavigationSession = (sessionId: string) => {
    routeResumeSelectionAlreadyHandledForSession = sessionId.trim();
  };

  const clearOwnNavigationSessionIf = (sessionId: string) => {
    if (routeResumeSelectionAlreadyHandledForSession === sessionId.trim()) {
      routeResumeSelectionAlreadyHandledForSession = "";
    }
  };

  const currentOwnNavigationSessionId = () => routeResumeSelectionAlreadyHandledForSession;

  const handleRouteResume = async () => {
    const rawPath = deps.pathname().trim();
    const path = rawPath.toLowerCase();
    if (!path.startsWith("/session/")) return;

    const [, , sessionSegment] = rawPath.split("/");
    const id = (sessionSegment ?? "").trim();

    const routeBrowseScope = deps.resolveSelectedSessionBrowseScope(id);
    const routeWorkspaceId = routeBrowseScope?.workspaceId?.trim() || undefined;
    const routeSessionKnown = routeSessionKnownFor(id, routeBrowseScope);
    const workspaceReady = Boolean(routeWorkspaceId || deps.activeWorkspaceId().trim());
    const routeWorkspaceRoot =
      routeBrowseScope?.workspaceRoot?.trim() ||
      deps.clientDirectory() ||
      deps.activeWorkspaceRoot().trim();
    const connectionKey = [
      id,
      deps.routedClient(routeWorkspaceId) ? "live" : "offline",
      routeWorkspaceId ?? "",
      routeWorkspaceRoot,
      routeBrowseScope?.directory?.trim() || "",
      routeBrowseScope?.conversationId?.trim() || "",
      routeBrowseScope?.opencodeSessionId?.trim() || "",
      deps.connectedVersion() ?? "",
    ].join("::");
    const routeConversationKey = routeConversationIdentityKeyFor(id, routeBrowseScope);
    const routeResumeDecision = resolveRouteResumeDecision({
      path: rawPath,
      routeSessionId: id,
      isPendingSession: deps.isPendingSessionInstanceId(id),
      routeWorkspaceId,
      activeWorkspaceId: deps.activeWorkspaceId().trim(),
      connectionKey,
      lastConnectionKey: lastRouteClientResumeKey,
      routeConversationKey,
      lastRouteConversationKey,
      workspaceReady,
      routeSessionKnown,
      sessionsLoaded: deps.sessionsLoadedForActiveWorkspace(),
      selectedSessionId: deps.selectedSessionId(),
      hasBrowseScope: Boolean(routeBrowseScope),
      visibleMessageCount: deps.visibleMessages().length,
      selectedSessionLoadingEarlierMessages: deps.selectedSessionLoadingEarlierMessages(),
      ownNavigationSessionId: routeResumeSelectionAlreadyHandledForSession,
    });

    switch (routeResumeDecision.type) {
      case "ignore":
        if (routeResumeDecision.reason === "foreign-workspace") {
          lastRouteClientResumeKey = "";
          lastRouteConversationKey = "";
        }
        if (routeResumeDecision.reason === "already-loaded") {
          lastRouteClientResumeKey = connectionKey;
          lastRouteConversationKey = routeConversationKey;
        }
        return;
      case "consume-own-navigation":
        routeResumeSelectionAlreadyHandledForSession = "";
        lastRouteClientResumeKey = routeResumeDecision.connectionKey;
        lastRouteConversationKey = routeConversationKey;
        return;
      case "select-session":
        lastRouteClientResumeKey = routeResumeDecision.connectionKey;
        lastRouteConversationKey = routeConversationKey;
        await deps.selectSession(routeResumeDecision.sessionId);
        return;
    }
  };

  const handleSessionRoute = async ({ rawPath }: { rawPath: string }) => {
    const [, , sessionSegment] = rawPath.split("/");
    const id = (sessionSegment ?? "").trim();
    const routeBrowseScope = id ? deps.resolveSelectedSessionBrowseScope(id) : null;
    const routeWorkspaceId = routeBrowseScope?.workspaceId ?? null;
    const routeConversationKey = routeConversationIdentityKeyFor(id, routeBrowseScope);
    const sessionIdsInStore = deps.sessions().map((session) => session.id);
    const sessionIdsInSidebar = routeSessionIdsInSidebar();
    const routeSessionKnown = routeSessionKnownFor(id, routeBrowseScope, sessionIdsInStore, sessionIdsInSidebar);
    const workspaceReady = Boolean(routeWorkspaceId?.trim() || deps.activeWorkspaceId().trim());
    const shouldFallbackFromRoute = id
      ? shouldFallbackFromSessionRoute({
        sessionsLoaded: deps.sessionsLoadedForActiveWorkspace(),
        routeSessionId: id,
        routeWorkspaceId,
        activeWorkspaceId: deps.activeWorkspaceId(),
        sessionIdsInStore,
        sessionIdsInSidebar,
        scopedSessionIds: deps.scopedSessionIds(),
        selectedSessionId: deps.selectedSessionId(),
        visibleMessageCount: deps.visibleMessages().length,
        selectedSessionStatus: deps.visibleSelectedSessionStatus(),
        selectedSessionLoadingEarlierMessages: deps.selectedSessionLoadingEarlierMessages(),
      })
      : false;
    const sessionPathDecision = resolveSessionPathDecision({
      path: rawPath,
      routeSessionId: id,
      activePendingDraftKey: deps.activePendingDraftKey(),
      selectedSessionId: deps.selectedSessionId(),
      isPendingSession: deps.isPendingSessionInstanceId(id),
      shouldFallbackFromRoute,
      ownNavigationSessionId: routeResumeSelectionAlreadyHandledForSession,
      workspaceReady,
      routeSessionKnown,
      sessionsLoaded: deps.sessionsLoadedForActiveWorkspace(),
    });

    switch (sessionPathDecision.type) {
      case "ignore":
        if (sessionPathDecision.reason === "already-selected" && routeConversationKey) {
          lastRouteConversationKey = routeConversationKey;
        }
        return;
      case "clear-session-view":
        if (sessionPathDecision.preservePendingDraft) {
          void deps.activePendingDraftMeta();
        }
        if (deps.selectedSessionId()) {
          clearDisplayedSessionForBareRoute();
        }
        return;
      case "select-pending-session":
        deps.setSelectedSessionId(sessionPathDecision.sessionId);
        return;
      case "fallback-to-session-list":
        if (sessionPathDecision.clearSelectedSession) {
          deps.setSelectedSessionId(null);
        }
        deps.navigate("/session", { replace: true });
        return;
      case "consume-own-navigation":
        routeResumeSelectionAlreadyHandledForSession = "";
        if (routeConversationKey) {
          lastRouteConversationKey = routeConversationKey;
        }
        return;
      case "select-session":
        if (routeConversationKey) {
          lastRouteConversationKey = routeConversationKey;
        }
        await deps.selectSession(sessionPathDecision.sessionId);
        return;
    }
  };

  const startRouteResumeEffect = () => {
    createEffect(() => {
      void handleRouteResume();
    });
  };

  return {
    startRouteResumeEffect,
    handleRouteResume,
    handleSessionRoute,
    isRouteSelectedSession,
    routeSessionIdsInSidebar,
    routeSessionKnownFor,
    routeConversationIdentityKeyFor,
    clearDisplayedSessionForBareRoute,
    markOwnNavigationSession,
    clearOwnNavigationSessionIf,
    currentOwnNavigationSessionId,
  };
}
