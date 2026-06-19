import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCreatedSidebarSessionItem,
  resolveCreatedSessionWorkspaceId,
  shouldRouteCreatedSessionAfterSelect,
  type CreatedSession,
} from "../../controllers/session-creation-flow.js";

function session(overrides: Partial<CreatedSession> = {}): CreatedSession {
  return {
    id: "sess-a",
    title: "Backend title",
    slug: "backend-title",
    parentID: "parent-a",
    time: { created: 10, updated: 20 },
    directory: "/workspace/a",
    ...overrides,
  } as CreatedSession;
}

test("created session sidebar item uses optimistic display fields and durable backend identifiers", () => {
  assert.deepEqual(
    buildCreatedSidebarSessionItem({
      session: session({
        conversationId: "conv-a",
        opencodeSessionId: "open-a",
        parentConversationId: "conv-parent",
        branchId: "branch-a",
      }),
      displaySession: session({
        title: "Prompt title",
        slug: "prompt-title",
      }),
      pendingSidebarSession: { id: " pending-1 " },
    }),
    {
      id: "sess-a",
      title: "Prompt title",
      slug: "prompt-title",
      parentID: "parent-a",
      time: { created: 10, updated: 20 },
      directory: "/workspace/a",
      conversationId: "conv-a",
      opencodeSessionId: "open-a",
      parentConversationId: "conv-parent",
      branchId: "branch-a",
      pendingSessionInstanceId: "pending-1",
    },
  );
});

test("created sidebar item falls back to the opencode session id and null optional ids", () => {
  assert.deepEqual(
    buildCreatedSidebarSessionItem({
      session: session(),
      displaySession: session(),
      pendingSidebarSession: null,
    }),
    {
      id: "sess-a",
      title: "Backend title",
      slug: "backend-title",
      parentID: "parent-a",
      time: { created: 10, updated: 20 },
      directory: "/workspace/a",
      conversationId: null,
      opencodeSessionId: "sess-a",
      parentConversationId: null,
      branchId: null,
      pendingSessionInstanceId: null,
    },
  );
});

test("created session workspace id prefers pending, target, connecting, then active workspace", () => {
  assert.equal(
    resolveCreatedSessionWorkspaceId({
      pendingSidebarSession: { workspaceId: " pending-ws " },
      targetWorkspaceId: "target-ws",
      connectingWorkspaceId: "connecting-ws",
      activeWorkspaceId: "active-ws",
    }),
    "pending-ws",
  );
  assert.equal(
    resolveCreatedSessionWorkspaceId({
      pendingSidebarSession: null,
      targetWorkspaceId: " target-ws ",
      connectingWorkspaceId: "connecting-ws",
      activeWorkspaceId: "active-ws",
    }),
    "target-ws",
  );
  assert.equal(
    resolveCreatedSessionWorkspaceId({
      pendingSidebarSession: null,
      targetWorkspaceId: "",
      connectingWorkspaceId: " connecting-ws ",
      activeWorkspaceId: "active-ws",
    }),
    "connecting-ws",
  );
  assert.equal(
    resolveCreatedSessionWorkspaceId({
      pendingSidebarSession: null,
      targetWorkspaceId: "",
      connectingWorkspaceId: "",
      activeWorkspaceId: " active-ws ",
    }),
    "active-ws",
  );
});

test("created sessions route after select only when the user is in the session flow", () => {
  assert.equal(shouldRouteCreatedSessionAfterSelect({ blockAppDuringCreate: true, currentView: "dashboard" }), true);
  assert.equal(shouldRouteCreatedSessionAfterSelect({ blockAppDuringCreate: false, currentView: "session" }), true);
  assert.equal(shouldRouteCreatedSessionAfterSelect({ blockAppDuringCreate: false, currentView: "dashboard" }), false);
});
