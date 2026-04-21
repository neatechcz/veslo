import assert from "node:assert/strict";
import test from "node:test";

import { shouldSyncSidebarFromSessionStore } from "./sidebar-session-sync-guard.js";

test("blocks sidebar sync during workspace switch when session store is still scoped to previous workspace", () => {
  assert.equal(
    shouldSyncSidebarFromSessionStore({
      activeWorkspaceId: "ws-a",
      connectingWorkspaceId: "ws-b",
      targetWorkspaceId: "ws-b",
      allSessionCount: 12,
      scopedSessionCount: 0,
    }),
    false,
  );
});

test("allows sidebar sync during workspace switch once scoped sessions exist", () => {
  assert.equal(
    shouldSyncSidebarFromSessionStore({
      activeWorkspaceId: "ws-a",
      connectingWorkspaceId: "ws-b",
      targetWorkspaceId: "ws-b",
      allSessionCount: 12,
      scopedSessionCount: 4,
    }),
    true,
  );
});

test("allows sidebar sync when switch is in progress and target workspace legitimately has zero sessions", () => {
  assert.equal(
    shouldSyncSidebarFromSessionStore({
      activeWorkspaceId: "ws-a",
      connectingWorkspaceId: "ws-b",
      targetWorkspaceId: "ws-b",
      allSessionCount: 0,
      scopedSessionCount: 0,
      existingTargetSessionCount: 0,
    }),
    true,
  );
});

test("blocks empty session store from wiping existing target rows during workspace switch", () => {
  assert.equal(
    shouldSyncSidebarFromSessionStore({
      activeWorkspaceId: "ws-a",
      connectingWorkspaceId: "ws-b",
      targetWorkspaceId: "ws-b",
      allSessionCount: 0,
      scopedSessionCount: 0,
      existingTargetSessionCount: 3,
    }),
    false,
  );
});

test("allows sidebar sync when no workspace switch is in progress", () => {
  assert.equal(
    shouldSyncSidebarFromSessionStore({
      activeWorkspaceId: "ws-a",
      connectingWorkspaceId: null,
      targetWorkspaceId: "ws-a",
      allSessionCount: 7,
      scopedSessionCount: 7,
    }),
    true,
  );
});
