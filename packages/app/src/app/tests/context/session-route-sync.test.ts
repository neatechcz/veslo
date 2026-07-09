import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionRouteSync,
  sessionIdFromRoutePath,
} from "../../context/session-route-sync.js";
import { createUiConversationKey } from "../../lib/ui-conversation-scope.js";

function createHarness(overrides: Record<string, unknown> = {}) {
  let pathname = "/session/sess-a";
  let selectedSessionId: string | null = null;
  let messages: unknown[] = [{ id: "message-1" }];
  let todos: unknown[] = [{ id: "todo-1" }];
  let activePendingDraftReads = 0;
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const deps = {
    pathname: () => pathname,
    sidebarWorkspaceGroups: () => [
      { sessions: [{ id: "sidebar-session" }] },
    ],
    sessions: () => [{ id: "sess-a" }],
    scopedSessionIds: () => ["scoped-session"],
    resolveSelectedSessionBrowseScope: (sessionId: string) =>
      sessionId === "sess-a"
        ? {
          sessionId,
          workspaceId: "ws-a",
          workspaceRoot: "/repo",
          directory: "/repo",
          conversationId: "conv-a",
          opencodeSessionId: "open-a",
        }
        : null,
    activeWorkspaceId: () => "ws-a",
    activeWorkspaceRoot: () => "/repo",
    clientDirectory: () => "/repo",
    routedClient: () => ({}),
    connectedVersion: () => "v1",
    sessionsLoadedForActiveWorkspace: () => true,
    selectedSessionId: () => selectedSessionId,
    visibleMessages: () => messages,
    selectedSessionLoadingEarlierMessages: () => false,
    activePendingDraftKey: () => "pending-global-unpublished",
    activePendingDraftMeta: () => {
      activePendingDraftReads += 1;
      return { id: "pending-global-unpublished" };
    },
    isPendingSessionInstanceKey: (sessionId: string) => sessionId.startsWith("pending-"),
    visibleSelectedSessionStatus: () => "idle",
    setSelectedSessionId: (value: string | null) => {
      calls.push({ name: "setSelectedSessionId", args: [value] });
      selectedSessionId = value;
    },
    setMessages: (value: unknown[]) => {
      calls.push({ name: "setMessages", args: [value] });
      messages = value;
    },
    setTodos: (value: unknown[]) => {
      calls.push({ name: "setTodos", args: [value] });
      todos = value;
    },
    selectSession: async (sessionId: string) => {
      calls.push({ name: "selectSession", args: [sessionId] });
      selectedSessionId = sessionId;
    },
    navigate: (to: string, options?: { replace?: boolean }) => {
      calls.push({ name: "navigate", args: [to, options] });
      pathname = to;
    },
    ...overrides,
  };

  const sync = createSessionRouteSync(deps as never);
  return {
    sync,
    calls,
    setPathname(value: string) {
      pathname = value;
    },
    setSelectedSessionId(value: string | null) {
      selectedSessionId = value;
    },
    get selectedSessionId() {
      return selectedSessionId;
    },
    get messages() {
      return messages;
    },
    get todos() {
      return todos;
    },
    get activePendingDraftReads() {
      return activePendingDraftReads;
    },
  };
}

test("session route sync selects a known scoped route once and dedupes the same connection key", async () => {
  const harness = createHarness();

  await harness.sync.handleRouteResume();
  await harness.sync.handleRouteResume();

  assert.deepEqual(
    harness.calls.filter((call) => call.name === "selectSession").map((call) => call.args[0]),
    ["sess-a"],
  );
  assert.equal(harness.selectedSessionId, "sess-a");
});

test("session route sync normalizes encoded and raw scoped pending route ids", () => {
  const scopedPendingKey = createUiConversationKey({
    workspaceId: "ws-a",
    kind: "pending-session",
    id: "pending-session:abc",
  });

  assert.equal(
    sessionIdFromRoutePath(`/session/${encodeURIComponent(scopedPendingKey)}`),
    scopedPendingKey,
  );
  assert.equal(sessionIdFromRoutePath(`/session/${scopedPendingKey}`), scopedPendingKey);
});

test("session route sync consumes own navigation without selecting again", async () => {
  const harness = createHarness();
  harness.setSelectedSessionId("sess-new");
  harness.setPathname("/session/sess-new");
  harness.sync.markOwnNavigationSession("sess-new");

  await harness.sync.handleRouteResume();

  assert.equal(harness.calls.some((call) => call.name === "selectSession"), false);
  assert.equal(harness.sync.currentOwnNavigationSessionId(), "");
});

test("session route sync clears bare session route while preserving pending draft context", async () => {
  const harness = createHarness();
  harness.setSelectedSessionId("sess-a");

  await harness.sync.handleSessionRoute({ rawPath: "/session" });

  assert.equal(harness.selectedSessionId, null);
  assert.deepEqual(harness.messages, []);
  assert.deepEqual(harness.todos, []);
  assert.equal(harness.activePendingDraftReads, 1);
});

test("session route sync falls back from an unknown real session route", async () => {
  const harness = createHarness({
    sessions: () => [],
    sidebarWorkspaceGroups: () => [],
    scopedSessionIds: () => [],
    resolveSelectedSessionBrowseScope: () => null,
    visibleMessages: () => [],
  });
  harness.setSelectedSessionId("missing");

  await harness.sync.handleSessionRoute({ rawPath: "/session/missing" });

  assert.equal(harness.selectedSessionId, null);
  assert.deepEqual(
    harness.calls.find((call) => call.name === "navigate")?.args,
    ["/session", { replace: true }],
  );
});

test("session route sync detects known route sessions across store sidebar scoped ids and browse scope", () => {
  const harness = createHarness();

  assert.equal(harness.sync.routeSessionKnownFor("sess-a", null), true);
  assert.equal(harness.sync.routeSessionKnownFor("sidebar-session", null), true);
  assert.equal(harness.sync.routeSessionKnownFor("scoped-session", null), true);
  assert.equal(harness.sync.routeSessionKnownFor("unknown", { workspaceId: "ws-a" } as never), true);
  assert.equal(harness.sync.routeSessionKnownFor("unknown", null), false);
});
