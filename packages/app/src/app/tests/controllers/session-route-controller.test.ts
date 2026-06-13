import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveRouteResumeDecision,
  resolveSessionPathDecision,
} from "../../controllers/session-route-controller.js";

test("route resume consumes create-session navigation without selecting again", () => {
  assert.deepEqual(
    resolveRouteResumeDecision({
      path: "/session/sess-new",
      routeSessionId: "sess-new",
      isPendingSession: false,
      routeWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      connectionKey: "sess-new::live::ws-a",
      lastConnectionKey: "",
      selectedSessionId: "sess-new",
      hasBrowseScope: false,
      visibleMessageCount: 0,
      selectedSessionLoadingEarlierMessages: false,
      ownNavigationSessionId: "sess-new",
    }),
    { type: "consume-own-navigation", sessionId: "sess-new", connectionKey: "sess-new::live::ws-a" },
  );
});

test("route resume selects own navigation when create flow has not selected yet", () => {
  assert.deepEqual(
    resolveRouteResumeDecision({
      path: "/session/sess-new",
      routeSessionId: "sess-new",
      isPendingSession: false,
      routeWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      connectionKey: "sess-new::live::ws-a",
      lastConnectionKey: "",
      selectedSessionId: null,
      hasBrowseScope: false,
      visibleMessageCount: 0,
      selectedSessionLoadingEarlierMessages: false,
      ownNavigationSessionId: "sess-new",
    }),
    { type: "select-session", sessionId: "sess-new", connectionKey: "sess-new::live::ws-a" },
  );
});

test("route resume selects again when live/offline connection key changes", () => {
  assert.deepEqual(
    resolveRouteResumeDecision({
      path: "/session/sess-a",
      routeSessionId: "sess-a",
      isPendingSession: false,
      routeWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      connectionKey: "sess-a::live::ws-a",
      lastConnectionKey: "sess-a::offline::ws-a",
      selectedSessionId: "sess-a",
      hasBrowseScope: true,
      visibleMessageCount: 4,
      selectedSessionLoadingEarlierMessages: false,
      ownNavigationSessionId: "",
    }),
    { type: "select-session", sessionId: "sess-a", connectionKey: "sess-a::live::ws-a" },
  );
});

test("route resume ignores foreign workspace sessions instead of rewriting active UI", () => {
  assert.deepEqual(
    resolveRouteResumeDecision({
      path: "/session/sess-b",
      routeSessionId: "sess-b",
      isPendingSession: false,
      routeWorkspaceId: "ws-b",
      activeWorkspaceId: "ws-a",
      connectionKey: "sess-b::live::ws-b",
      lastConnectionKey: "",
      selectedSessionId: "sess-a",
      hasBrowseScope: true,
      visibleMessageCount: 1,
      selectedSessionLoadingEarlierMessages: false,
      ownNavigationSessionId: "",
    }),
    { type: "ignore", reason: "foreign-workspace" },
  );
});

test("route resume skips duplicate, already loaded, and pagination-driven selections", () => {
  assert.deepEqual(
    resolveRouteResumeDecision({
      path: "/session/sess-a",
      routeSessionId: "sess-a",
      isPendingSession: false,
      routeWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      connectionKey: "sess-a::live::ws-a",
      lastConnectionKey: "sess-a::live::ws-a",
      selectedSessionId: "sess-a",
      hasBrowseScope: true,
      visibleMessageCount: 4,
      selectedSessionLoadingEarlierMessages: false,
      ownNavigationSessionId: "",
    }),
    { type: "ignore", reason: "same-key" },
  );

  assert.deepEqual(
    resolveRouteResumeDecision({
      path: "/session/sess-a",
      routeSessionId: "sess-a",
      isPendingSession: false,
      routeWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      connectionKey: "sess-a::offline::ws-a",
      lastConnectionKey: "",
      selectedSessionId: "sess-a",
      hasBrowseScope: false,
      visibleMessageCount: 4,
      selectedSessionLoadingEarlierMessages: false,
      ownNavigationSessionId: "",
    }),
    { type: "ignore", reason: "already-loaded" },
  );

  assert.deepEqual(
    resolveRouteResumeDecision({
      path: "/session/sess-a",
      routeSessionId: "sess-a",
      isPendingSession: false,
      routeWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      connectionKey: "sess-a::offline::ws-a",
      lastConnectionKey: "",
      selectedSessionId: "sess-b",
      hasBrowseScope: true,
      visibleMessageCount: 4,
      selectedSessionLoadingEarlierMessages: true,
      ownNavigationSessionId: "",
    }),
    { type: "ignore", reason: "loading-earlier-messages" },
  );
});

test("route resume still consumes own navigation while earlier messages are loading", () => {
  assert.deepEqual(
    resolveRouteResumeDecision({
      path: "/session/sess-new",
      routeSessionId: "sess-new",
      isPendingSession: false,
      routeWorkspaceId: "ws-a",
      activeWorkspaceId: "ws-a",
      connectionKey: "sess-new::live::ws-a",
      lastConnectionKey: "",
      selectedSessionId: "sess-new",
      hasBrowseScope: true,
      visibleMessageCount: 4,
      selectedSessionLoadingEarlierMessages: true,
      ownNavigationSessionId: "sess-new",
    }),
    { type: "consume-own-navigation", sessionId: "sess-new", connectionKey: "sess-new::live::ws-a" },
  );
});

test("bare session route clears real transcript state but preserves pending draft context", () => {
  assert.deepEqual(
    resolveSessionPathDecision({
      path: "/session",
      routeSessionId: "",
      activePendingDraftKey: "pending:ws-a:123",
      selectedSessionId: "sess-a",
      isPendingSession: false,
      shouldFallbackFromRoute: false,
      ownNavigationSessionId: "",
    }),
    { type: "clear-session-view", preservePendingDraft: true },
  );
});

test("session path controller separates pending ids, fallback, own navigation, and select", () => {
  assert.deepEqual(
    resolveSessionPathDecision({
      path: "/session/pending-1",
      routeSessionId: "pending-1",
      selectedSessionId: null,
      activePendingDraftKey: null,
      isPendingSession: true,
      shouldFallbackFromRoute: false,
      ownNavigationSessionId: "",
    }),
    { type: "select-pending-session", sessionId: "pending-1" },
  );

  assert.deepEqual(
    resolveSessionPathDecision({
      path: "/session/missing",
      routeSessionId: "missing",
      selectedSessionId: "missing",
      activePendingDraftKey: null,
      isPendingSession: false,
      shouldFallbackFromRoute: true,
      ownNavigationSessionId: "",
    }),
    { type: "fallback-to-session-list", clearSelectedSession: true },
  );

  assert.deepEqual(
    resolveSessionPathDecision({
      path: "/session/sess-new",
      routeSessionId: "sess-new",
      selectedSessionId: "sess-new",
      activePendingDraftKey: null,
      isPendingSession: false,
      shouldFallbackFromRoute: false,
      ownNavigationSessionId: "sess-new",
    }),
    { type: "consume-own-navigation", sessionId: "sess-new" },
  );

  assert.deepEqual(
    resolveSessionPathDecision({
      path: "/session/sess-new",
      routeSessionId: "sess-new",
      selectedSessionId: null,
      activePendingDraftKey: null,
      isPendingSession: false,
      shouldFallbackFromRoute: false,
      ownNavigationSessionId: "sess-new",
    }),
    { type: "select-session", sessionId: "sess-new" },
  );

  assert.deepEqual(
    resolveSessionPathDecision({
      path: "/session/sess-a",
      routeSessionId: "sess-a",
      selectedSessionId: "sess-b",
      activePendingDraftKey: null,
      isPendingSession: false,
      shouldFallbackFromRoute: false,
      ownNavigationSessionId: "",
    }),
    { type: "select-session", sessionId: "sess-a" },
  );
});
