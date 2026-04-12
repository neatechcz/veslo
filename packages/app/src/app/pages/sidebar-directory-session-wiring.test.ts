import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");

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

test("session wires archived-items navigation into WorkspaceSessionList", () => {
  assert.match(
    sessionSource,
    /onOpenArchivedSessions=\{\(\) => openSettings\("general"\)\}/,
    "Session should route archived items into the existing settings general archive surface",
  );
});

test("dashboard wires archived-items navigation into WorkspaceSessionList", () => {
  assert.match(
    dashboardSource,
    /onOpenArchivedSessions=\{\(\) => openSettings\("general"\)\}/,
    "Dashboard should route archived items into the existing settings general archive surface",
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
