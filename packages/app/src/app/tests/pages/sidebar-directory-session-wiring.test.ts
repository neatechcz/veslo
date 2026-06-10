import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../../pages/dashboard.tsx", import.meta.url), "utf8");
const workspaceSessionListSource = readFileSync(
  new URL("../../components/session/workspace-session-list.tsx", import.meta.url),
  "utf8",
);

test("session view props expose the directory-picked session callback", () => {
  assert.match(
    sessionSource,
    /openDirectorySessionFromPicker: \(\) => void;/,
    "SessionViewProps should expose the picker-driven directory session callback",
  );
});

test("dashboard view props expose the directory-picked session callback", () => {
  assert.match(
    dashboardSource,
    /openDirectorySessionFromPicker: \(\) => void;/,
    "DashboardViewProps should expose the picker-driven directory session callback",
  );
});

test("session wires the directory-picked session callback into WorkspaceSessionList", () => {
  assert.match(
    sessionSource,
    /onAddDirectorySession=\{props\.openDirectorySessionFromPicker\}/,
    "Session should pass the picker-driven callback into WorkspaceSessionList",
  );
});

test("dashboard wires the directory-picked session callback into WorkspaceSessionList", () => {
  assert.match(
    dashboardSource,
    /onAddDirectorySession=\{props\.openDirectorySessionFromPicker\}/,
    "Dashboard should pass the picker-driven callback into WorkspaceSessionList",
  );
});

test("session view props expose the project pending-draft callback", () => {
  assert.match(
    sessionSource,
    /openPendingDirectoryDraftInWorkspace: \(workspaceId: string\) => void;/,
    "SessionViewProps should expose the project pending-draft callback",
  );
});

test("dashboard view props expose the project pending-draft callback", () => {
  assert.match(
    dashboardSource,
    /openPendingDirectoryDraftInWorkspace: \(workspaceId: string\) => void;/,
    "DashboardViewProps should expose the project pending-draft callback",
  );
});

test("WorkspaceSessionList exposes the project pending-draft callback", () => {
  assert.match(
    workspaceSessionListSource,
    /onOpenPendingDirectoryDraftInWorkspace: \(workspaceId: string\) => void;/,
    "WorkspaceSessionList should expose the per-project pending-draft callback",
  );
});

test("session wires the project pending-draft callback into WorkspaceSessionList", () => {
  assert.match(
    sessionSource,
    /onOpenPendingDirectoryDraftInWorkspace=\{props\.openPendingDirectoryDraftInWorkspace\}/,
    "Session should pass the per-project pending-draft callback into WorkspaceSessionList",
  );
});

test("dashboard wires the project pending-draft callback into WorkspaceSessionList", () => {
  assert.match(
    dashboardSource,
    /onOpenPendingDirectoryDraftInWorkspace=\{props\.openPendingDirectoryDraftInWorkspace\}/,
    "Dashboard should pass the per-project pending-draft callback into WorkspaceSessionList",
  );
});

test("project plus button uses the pending-draft callback instead of real-session creation wiring", () => {
  assert.match(
    workspaceSessionListSource,
    /onClick=\{\(\) => props\.onOpenPendingDirectoryDraftInWorkspace\(workspace\(\)\.id\)\}/,
    "WorkspaceSessionList should route the project plus button into the pending-draft callback",
  );
  assert.doesNotMatch(
    workspaceSessionListSource,
    /props\.onCreateTaskInWorkspace/,
    "WorkspaceSessionList should stop referring to the old real-session creation callback",
  );
});

test("project plus button stays enabled for pending-draft browsing mode", () => {
  assert.doesNotMatch(
    workspaceSessionListSource,
    /onClick=\{\(\) => props\.onOpenPendingDirectoryDraftInWorkspace\(workspace\(\)\.id\)\}[\s\S]*disabled=\{props\.newTaskDisabled\}/,
    "Project plus should not inherit the real-session disabled state because it opens a pending draft first",
  );
});

test("WorkspaceSessionList refreshes project order after registered project promotion", () => {
  assert.match(
    workspaceSessionListSource,
    /PROJECT_ORDER_PROMOTED_EVENT/,
    "WorkspaceSessionList should subscribe to external project-order promotion events",
  );
  assert.match(
    workspaceSessionListSource,
    /const promoteProjectOrder = \(projectKey: string\) => \{[\s\S]*mergeVisibleOrder\([\s\S]*promoteProjectKeyInOrder\(/s,
    "WorkspaceSessionList should materialize visible projects and promote the registered key when notified",
  );
  assert.match(
    workspaceSessionListSource,
    /window\.addEventListener\(PROJECT_ORDER_PROMOTED_EVENT, handleProjectOrderPromoted\)/,
    "WorkspaceSessionList should listen for registered project promotions",
  );
});

test("session wires archived-items navigation into WorkspaceSessionList", () => {
  assert.match(
    sessionSource,
    /onOpenArchivedSessions=\{\(\) => openSettings\("archived"\)\}/,
    "Session should route archived items into the dedicated archived settings tab",
  );
});

test("dashboard wires archived-items navigation into WorkspaceSessionList", () => {
  assert.match(
    dashboardSource,
    /onOpenArchivedSessions=\{\(\) => openSettings\("archived"\)\}/,
    "Dashboard should route archived items into the dedicated archived settings tab",
  );
});

test("session view props expose workspace sidebar paging controls", () => {
  assert.match(
    sessionSource,
    /workspaceSessionPagingById: Record<string, \{ hasMore: boolean; loadingMore: boolean \}>;/,
    "SessionViewProps should include paging metadata for workspace sidebar sessions",
  );

  assert.match(
    sessionSource,
    /loadMoreWorkspaceSidebarSessions: \(workspaceId: string\) => Promise<void> \| void;/,
    "SessionViewProps should expose callback for loading additional sidebar sessions",
  );
});

test("dashboard view props expose workspace sidebar paging controls", () => {
  assert.match(
    dashboardSource,
    /workspaceSessionPagingById: Record<string, \{ hasMore: boolean; loadingMore: boolean \}>;/,
    "DashboardViewProps should include paging metadata for workspace sidebar sessions",
  );

  assert.match(
    dashboardSource,
    /loadMoreWorkspaceSidebarSessions: \(workspaceId: string\) => Promise<void> \| void;/,
    "DashboardViewProps should expose callback for loading additional sidebar sessions",
  );
});

test("session wires paging props into WorkspaceSessionList", () => {
  assert.match(
    sessionSource,
    /workspaceSessionPagingById=\{props\.workspaceSessionPagingById\}/,
    "Session should pass workspace paging metadata into WorkspaceSessionList",
  );

  assert.match(
    sessionSource,
    /onLoadMoreWorkspaceSessions=\{props\.loadMoreWorkspaceSidebarSessions\}/,
    "Session should pass load-more callback into WorkspaceSessionList",
  );
});

test("dashboard wires paging props into WorkspaceSessionList", () => {
  assert.match(
    dashboardSource,
    /workspaceSessionPagingById=\{props\.workspaceSessionPagingById\}/,
    "Dashboard should pass workspace paging metadata into WorkspaceSessionList",
  );

  assert.match(
    dashboardSource,
    /onLoadMoreWorkspaceSessions=\{props\.loadMoreWorkspaceSidebarSessions\}/,
    "Dashboard should pass load-more callback into WorkspaceSessionList",
  );
});

test("session view props expose unread session ids", () => {
  assert.match(
    sessionSource,
    /unreadSessionIds: Record<string, true>;/,
    "SessionViewProps should include local unread session ids for sidebar rows",
  );
});

test("dashboard view props expose unread session ids", () => {
  assert.match(
    dashboardSource,
    /unreadSessionIds: Record<string, true>;/,
    "DashboardViewProps should include local unread session ids for sidebar rows",
  );
});

test("session wires unread session ids into WorkspaceSessionList", () => {
  assert.match(
    sessionSource,
    /unreadSessionIds=\{props\.unreadSessionIds\}/,
    "Session should pass unread session ids into WorkspaceSessionList",
  );
});

test("dashboard wires unread session ids into WorkspaceSessionList", () => {
  assert.match(
    dashboardSource,
    /unreadSessionIds=\{props\.unreadSessionIds\}/,
    "Dashboard should pass unread session ids into WorkspaceSessionList",
  );
});
