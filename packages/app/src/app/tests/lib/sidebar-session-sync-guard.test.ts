import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  shouldPreserveSidebarRowsOnRead,
  shouldSyncSidebarFromSessionStore,
} from "../../lib/sidebar-session-sync-guard.js";

const sidebarWorkspaceSessionsSource = readFileSync(
  new URL("../../context/sidebar-workspace-sessions.ts", import.meta.url),
  "utf8",
);

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

test("preserves sidebar rows when a read is unavailable (server/sandbox unreachable)", () => {
  assert.equal(
    shouldPreserveSidebarRowsOnRead({ available: false, incomingCount: 0, existingCount: 5 }),
    true,
  );
  // Even an "available" but empty read keeps rows the user can still open.
  assert.equal(
    shouldPreserveSidebarRowsOnRead({ available: true, incomingCount: 0, existingCount: 5 }),
    true,
  );
});

test("uses non-empty read results even when the sandbox read source is unavailable", () => {
  assert.equal(
    shouldPreserveSidebarRowsOnRead({ available: false, incomingCount: 3, existingCount: 0 }),
    false,
  );
  assert.equal(
    shouldPreserveSidebarRowsOnRead({ available: false, incomingCount: 3, existingCount: 5 }),
    false,
  );
});

test("replaces sidebar rows on a genuine non-empty read, or empty read for a fresh workspace", () => {
  assert.equal(
    shouldPreserveSidebarRowsOnRead({ available: true, incomingCount: 3, existingCount: 5 }),
    false,
  );
  assert.equal(
    shouldPreserveSidebarRowsOnRead({ available: true, incomingCount: 0, existingCount: 0 }),
    false,
  );
});

test("sidebar unavailable fallback preserves rows and clears paging state", () => {
  const start = sidebarWorkspaceSessionsSource.indexOf("  const markSidebarRefreshUnavailable = ");
  const end = sidebarWorkspaceSessionsSource.indexOf("  const refreshSidebarWorkspaceSessions = ", start);
  assert.notEqual(start, -1, "markSidebarRefreshUnavailable should exist");
  assert.notEqual(end, -1, "markSidebarRefreshUnavailable block should end before refreshSidebarWorkspaceSessions");
  const block = sidebarWorkspaceSessionsSource.slice(start, end);

  assert.match(block, /setSidebarSessionStatusByWorkspaceId\(\(prev\) => \(\{ \.\.\.prev, \[id\]: "ready" as const \}\)\)/);
  assert.match(block, /setSidebarSessionErrorByWorkspaceId\(\(prev\) => \(\{ \.\.\.prev, \[id\]: null \}\)\)/);
  assert.match(block, /setSidebarSessionHasMoreByWorkspaceId\(\(prev\) => \(\{ \.\.\.prev, \[id\]: false \}\)\)/);
  assert.match(block, /setSidebarSessionLoadingMoreByWorkspaceId\(\(prev\) => \(\{ \.\.\.prev, \[id\]: false \}\)\)/);
  assert.doesNotMatch(block, /setSidebarSessionsByWorkspaceId/, "unavailable runtime must not wipe existing sidebar rows");
});
