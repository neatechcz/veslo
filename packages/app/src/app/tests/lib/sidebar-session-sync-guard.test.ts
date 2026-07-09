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

test("allows sidebar sync during workspace switch for freshly materialized created sessions", () => {
  assert.equal(
    shouldSyncSidebarFromSessionStore({
      activeWorkspaceId: "ws-a",
      connectingWorkspaceId: "ws-b",
      targetWorkspaceId: "ws-b",
      allSessionCount: 1,
      scopedSessionCount: 0,
      existingTargetSessionCount: 1,
      freshlyCreatedSessionCount: 1,
      activeSendInProgress: true,
    }),
    true,
  );
});

test("blocks active-send live-only sidebar sync before target rows hydrate", () => {
  assert.equal(
    shouldSyncSidebarFromSessionStore({
      activeWorkspaceId: "ws-a",
      connectingWorkspaceId: "ws-b",
      targetWorkspaceId: "ws-b",
      allSessionCount: 1,
      scopedSessionCount: 1,
      existingTargetSessionCount: 0,
      freshlyCreatedSessionCount: 0,
      activeSendInProgress: true,
    }),
    false,
  );
});

test("allows active-send sidebar sync once there are target rows to merge with", () => {
  assert.equal(
    shouldSyncSidebarFromSessionStore({
      activeWorkspaceId: "ws-a",
      connectingWorkspaceId: "ws-b",
      targetWorkspaceId: "ws-b",
      allSessionCount: 1,
      scopedSessionCount: 1,
      existingTargetSessionCount: 4,
      freshlyCreatedSessionCount: 0,
      activeSendInProgress: true,
    }),
    true,
  );
});

test("blocks active-send live-only sidebar sync without a workspace switch", () => {
  assert.equal(
    shouldSyncSidebarFromSessionStore({
      activeWorkspaceId: "ws-a",
      connectingWorkspaceId: null,
      targetWorkspaceId: "ws-a",
      allSessionCount: 1,
      scopedSessionCount: 1,
      existingTargetSessionCount: 0,
      freshlyCreatedSessionCount: 0,
      activeSendInProgress: true,
    }),
    false,
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

test("read-api unavailable result is not treated as a ready sidebar snapshot", () => {
  const start = sidebarWorkspaceSessionsSource.indexOf("  const applyWorkspaceSidebarReadResult = ");
  const end = sidebarWorkspaceSessionsSource.indexOf("  const isSidebarRuntimeUnavailableError = ", start);
  assert.notEqual(start, -1, "applyWorkspaceSidebarReadResult should exist");
  assert.notEqual(end, -1, "applyWorkspaceSidebarReadResult block should end before runtime error matcher");
  const block = sidebarWorkspaceSessionsSource.slice(start, end);

  assert.match(block, /if \(input\.available\) \{[\s\S]*\[id\]: "ready" as const[\s\S]*\[id\]: null[\s\S]*\} else \{/);
  const unavailableStart = block.indexOf("    } else {");
  assert.notEqual(unavailableStart, -1, "unavailable branch should be explicit");
  const unavailableBlock = block.slice(unavailableStart);
  assert.match(unavailableBlock, /\[id\]: "error" as const/);
  assert.match(unavailableBlock, /sidebarReadUnavailableMessage\(reason\)/);
  assert.doesNotMatch(unavailableBlock, /\[id\]: "ready" as const/, "unavailable read must not share the ready branch");
});

test("read-api unavailable result does not close sidebar pagination as complete", () => {
  const start = sidebarWorkspaceSessionsSource.indexOf("  const refreshSidebarWorkspaceSessionsFromReadApi = ");
  const end = sidebarWorkspaceSessionsSource.indexOf("  const resolveSidebarClientConfig = ", start);
  assert.notEqual(start, -1, "refreshSidebarWorkspaceSessionsFromReadApi should exist");
  assert.notEqual(end, -1, "refreshSidebarWorkspaceSessionsFromReadApi block should end before client config helper");
  const block = sidebarWorkspaceSessionsSource.slice(start, end);

  assert.match(
    block,
    /if \(result\.available \|\| result\.items\.length > 0\) \{[\s\S]*setSidebarSessionHasMoreByWorkspaceId\(\(prev\) => \(\{ \.\.\.prev, \[workspaceId\]: false \}\)\);[\s\S]*\}/,
  );
  assert.doesNotMatch(
    block,
    /applyWorkspaceSidebarReadResult\([\s\S]*\);\s*setSidebarSessionHasMoreByWorkspaceId\(\(prev\) => \(\{ \.\.\.prev, \[workspaceId\]: false \}\)\);/,
    "unavailable empty read must not immediately mark pagination complete",
  );
});

test("sidebar unavailable fallback preserves rows and exposes unavailable state", () => {
  const start = sidebarWorkspaceSessionsSource.indexOf("  const markSidebarRefreshUnavailable = ");
  const end = sidebarWorkspaceSessionsSource.indexOf("  const refreshSidebarWorkspaceSessions = ", start);
  assert.notEqual(start, -1, "markSidebarRefreshUnavailable should exist");
  assert.notEqual(end, -1, "markSidebarRefreshUnavailable block should end before refreshSidebarWorkspaceSessions");
  const block = sidebarWorkspaceSessionsSource.slice(start, end);

  assert.match(block, /setSidebarSessionStatusByWorkspaceId\(\(prev\) => \(\{ \.\.\.prev, \[id\]: "error" as const \}\)\)/);
  assert.match(block, /sidebarReadUnavailableMessage\(reason\)/);
  assert.doesNotMatch(block, /setSidebarSessionErrorByWorkspaceId\(\(prev\) => \(\{ \.\.\.prev, \[id\]: null \}\)\)/);
  assert.doesNotMatch(block, /setSidebarSessionHasMoreByWorkspaceId/, "unavailable runtime must not close pagination as complete");
  assert.match(block, /setSidebarSessionLoadingMoreByWorkspaceId\(\(prev\) => \(\{ \.\.\.prev, \[id\]: false \}\)\)/);
  assert.doesNotMatch(block, /setSidebarSessionsByWorkspaceId/, "unavailable runtime must not wipe existing sidebar rows");
});

test("live sidebar list denial clears stale read errors instead of exposing unavailable state", () => {
  const start = sidebarWorkspaceSessionsSource.indexOf("  const skipLiveSidebarSessionList = ");
  const end = sidebarWorkspaceSessionsSource.indexOf("  const refreshSidebarWorkspaceSessions = ", start);
  assert.notEqual(start, -1, "skipLiveSidebarSessionList should exist");
  assert.notEqual(end, -1, "skipLiveSidebarSessionList block should end before refreshSidebarWorkspaceSessions");
  const block = sidebarWorkspaceSessionsSource.slice(start, end);

  assert.match(block, /\[id\]: "ready" as const/);
  assert.match(block, /\[id\]: null/);
  assert.match(block, /\[id\]: false/);
  assert.match(block, /sidebar:live-session-list:skipped/);
  assert.doesNotMatch(block, /sidebarReadUnavailableMessage/);
  assert.doesNotMatch(block, /setSidebarSessionsByWorkspaceId/, "live-list denial must not wipe existing sidebar rows");
  assert.match(
    sidebarWorkspaceSessionsSource,
    /if \(hostReadDirectory && options\.allowLiveWorkspaceSessionList\?\.\(id\) !== true\) \{[\s\S]*skipLiveSidebarSessionList\(id, "live-session-list-not-allowed"\);[\s\S]*return;[\s\S]*\}/,
    "live-list denial should use the soft-skip helper",
  );
});
