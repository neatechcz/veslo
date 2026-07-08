import assert from "node:assert/strict";
import test from "node:test";

import {
  archivedSidebarSessionKeyFromRecord,
  buildArchivedSessionDisplayLabel,
  buildArchivedSidebarSessionKey,
  buildLegacyArchiveMigration,
  buildSessionArchiveSnapshot,
  buildWorkspaceIdentity,
  sortArchivedSessionsByRecency,
  toSessionArchiveItem,
  type SessionArchiveItem,
} from "../../lib/session-archive-model.js";

test("sortArchivedSessionsByRecency orders newest archived session first", () => {
  const items: SessionArchiveItem[] = [
    {
      sessionId: "old",
      workspaceId: "workspace",
      title: "Old",
      workspaceLabel: "Workspace",
      archivedAt: 10,
      availableOnThisDevice: true,
    },
    {
      sessionId: "new",
      workspaceId: "workspace",
      title: "New",
      workspaceLabel: "Workspace",
      archivedAt: 20,
      availableOnThisDevice: true,
    },
  ];

  assert.deepEqual(sortArchivedSessionsByRecency(items).map((item) => item.sessionId), ["new", "old"]);
});

test("buildArchivedSidebarSessionKey scopes archived sidebar filtering by workspace", () => {
  assert.notEqual(
    buildArchivedSidebarSessionKey({ workspaceId: "workspace-a", sessionId: "shared" }),
    buildArchivedSidebarSessionKey({ workspaceId: "workspace-b", sessionId: "shared" }),
  );
  assert.notEqual(
    buildArchivedSidebarSessionKey({ workspaceId: "workspace-a", sessionId: "shared", directory: "/repo/a" }),
    buildArchivedSidebarSessionKey({ workspaceId: "workspace-a", sessionId: "shared", directory: "/repo/b" }),
  );
  assert.equal(
    archivedSidebarSessionKeyFromRecord({
      workspaceIdAtArchive: "workspace-a",
      sessionId: "shared",
      resolvedDirectoryAtArchive: "/repo/a",
    }),
    buildArchivedSidebarSessionKey({ workspaceId: "workspace-a", sessionId: "shared", directory: "/repo/a" }),
  );
  assert.equal(buildArchivedSidebarSessionKey({ workspaceId: "", sessionId: "legacy" }), "legacy");
});

test("buildArchivedSidebarSessionKey scopes duplicate workspace sessions by directory", () => {
  assert.notEqual(
    buildArchivedSidebarSessionKey({ workspaceId: "workspace-a", sessionId: "shared", directory: "/work/a" }),
    buildArchivedSidebarSessionKey({ workspaceId: "workspace-a", sessionId: "shared", directory: "/work/b" }),
  );
  assert.equal(
    archivedSidebarSessionKeyFromRecord({
      workspaceIdAtArchive: "workspace-a",
      sessionId: "shared",
      resolvedDirectoryAtArchive: "/work/a",
    }),
    buildArchivedSidebarSessionKey({ workspaceId: "workspace-a", sessionId: "shared", directory: "/work/a" }),
  );
});

test("archived sidebar keys can scope identity-only archive records", () => {
  assert.notEqual(
    buildArchivedSidebarSessionKey({ workspaceIdentity: "local:/workspace/a", sessionId: "shared" }),
    buildArchivedSidebarSessionKey({ workspaceIdentity: "local:/workspace/b", sessionId: "shared" }),
  );
  assert.equal(
    archivedSidebarSessionKeyFromRecord({
      workspaceIdentity: "local:/workspace/a",
      sessionId: "shared",
    }),
    buildArchivedSidebarSessionKey({ workspaceIdentity: "local:/workspace/a", sessionId: "shared" }),
  );
});

test("buildArchivedSessionDisplayLabel falls back to project and workspace snapshots", () => {
  const label = buildArchivedSessionDisplayLabel({
    sessionId: "sess_123",
    workspaceLabel: "Cloud Workspace",
    projectLabel: "Client A",
    resolvedDirectory: null,
  });

  assert.equal(label, "Cloud Workspace · Client A");
});

test("buildWorkspaceIdentity prefers stable remote host and workspace ids", () => {
  assert.equal(
    buildWorkspaceIdentity({
      id: "local-id",
      name: "Remote",
      path: "/tmp",
      preset: "starter",
      workspaceType: "remote",
      remoteType: "veslo",
      baseUrl: "https://worker.example/workspace",
      directory: "/workspace/client-a",
      vesloHostUrl: "https://worker.example/",
      vesloWorkspaceId: "ws_123",
      vesloWorkspaceName: "Client A",
    }),
    "remote:https://worker.example::id:ws_123",
  );
});

test("buildSessionArchiveSnapshot captures workspace and session metadata", () => {
  const snapshot = buildSessionArchiveSnapshot({
    session: {
      id: "sess_123",
      title: "Draft task",
      parentID: "root",
      directory: "/workspace/client-a",
      time: { created: 1, updated: 2 },
    },
    workspace: {
      id: "ws_local",
      name: "Workspace",
      path: "/workspace",
      preset: "starter",
      workspaceType: "local",
      displayName: "Workspace",
    },
    archivedAt: 99,
  });

  assert.equal(snapshot.archivedAt, 99);
  assert.equal(snapshot.workspaceIdAtArchive, "ws_local");
  assert.equal(snapshot.projectLabelSnapshot, "client-a");
  assert.equal(snapshot.parentSessionId, "root");
});

test("toSessionArchiveItem marks unavailable sessions and uses record snapshots", () => {
  const item = toSessionArchiveItem(
    {
      sessionId: "sess_123",
      archivedAt: 50,
      titleSnapshot: "Archived task",
      workspaceIdAtArchive: "ws_cloud",
      workspaceLabelSnapshot: "Cloud Workspace",
      projectLabelSnapshot: "Client A",
      resolvedDirectoryAtArchive: "/workspace/client-a",
      workspaceIdentity: "remote:https://worker.example::id:missing",
    },
    [],
  );

  assert.equal(item.availableOnThisDevice, false);
  assert.equal(item.workspaceId, "ws_cloud");
  assert.equal(item.workspaceLabel, "Cloud Workspace");
  assert.equal(item.projectLabel, "Client A");
});

test("toSessionArchiveItem resolves identity-only records to the current workspace id", () => {
  const item = toSessionArchiveItem(
    {
      sessionId: "shared",
      archivedAt: 50,
      titleSnapshot: "Archived task",
      workspaceLabelSnapshot: "Workspace A",
      workspaceIdentity: "local:/workspace/a",
    },
    [
      {
        id: "workspace-a",
        name: "Workspace A",
        path: "/workspace/a",
        preset: "starter",
        workspaceType: "local",
      },
    ],
  );

  assert.equal(item.workspaceId, "workspace-a");
  assert.equal(item.workspaceIdentity, "local:/workspace/a");
  assert.equal(item.availableOnThisDevice, true);
});

test("buildLegacyArchiveMigration preserves local archive order as synthetic archived timestamps", () => {
  const records = buildLegacyArchiveMigration(
    ["session-1", "session-2"],
    [
      {
        workspace: {
          id: "ws_local",
          name: "Workspace",
          path: "/workspace",
          preset: "starter",
          workspaceType: "local",
          displayName: "Workspace",
        },
        sessions: [
          { id: "session-1", title: "One", directory: "/workspace/one" },
          { id: "session-2", title: "Two", directory: "/workspace/two" },
        ],
        status: "ready",
        error: null,
      },
    ],
  );

  assert.equal(records.length, 2);
  assert.equal(records[0]?.sessionId, "session-1");
  assert.equal(records[1]?.sessionId, "session-2");
  assert.ok((records[1]?.archivedAt ?? 0) > (records[0]?.archivedAt ?? 0));
});
