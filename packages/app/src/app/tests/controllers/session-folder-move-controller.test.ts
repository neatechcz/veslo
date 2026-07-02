import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionFolderMoveSource } from "../../controllers/session-folder-move-controller.js";

const isPrivate = (path: string) => path.includes("private-workspaces");

test("resolves the session's own private workspace over the active one", () => {
  const source = resolveSessionFolderMoveSource({
    sessionDirectory: "C:/Users/dev/private-workspaces/scratch-1",
    activeWorkspaceId: "ws-active",
    activeWorkspaceRoot: "C:/Users/dev/projects/other",
    activeWorkspace: { id: "ws-active", workspaceType: "local" },
    workspaces: [
      { id: "ws-active", workspaceType: "local", path: "C:/Users/dev/projects/other" },
      { id: "ws-scratch", workspaceType: "local", path: "C:/Users/dev/private-workspaces/scratch-1" },
    ],
    isPrivateWorkspacePath: isPrivate,
  });

  assert.deepEqual(source, {
    ok: true,
    sourceRoot: "C:/Users/dev/private-workspaces/scratch-1",
    sourceWorkspaceId: "ws-scratch",
  });
});

test("falls back to the active workspace when no workspace matches the directory", () => {
  const source = resolveSessionFolderMoveSource({
    sessionDirectory: "C:/Users/dev/private-workspaces/unlisted",
    activeWorkspaceId: "ws-active",
    activeWorkspaceRoot: "C:/Users/dev/private-workspaces/unlisted",
    activeWorkspace: { id: "ws-active", workspaceType: "local" },
    workspaces: [],
    isPrivateWorkspacePath: isPrivate,
  });

  assert.deepEqual(source, {
    ok: true,
    sourceRoot: "C:/Users/dev/private-workspaces/unlisted",
    sourceWorkspaceId: "ws-active",
  });
});

test("rejects moves from remote workspaces", () => {
  const source = resolveSessionFolderMoveSource({
    sessionDirectory: "",
    activeWorkspaceId: "ws-remote",
    activeWorkspaceRoot: "C:/Users/dev/private-workspaces/scratch-1",
    activeWorkspace: { id: "ws-remote", workspaceType: "remote" },
    workspaces: [],
    isPrivateWorkspacePath: isPrivate,
  });

  assert.deepEqual(source, { ok: false, reason: "not-private" });
});

test("rejects moves from non-private local folders", () => {
  const source = resolveSessionFolderMoveSource({
    sessionDirectory: "C:/Users/dev/projects/real-project",
    activeWorkspaceId: "ws-active",
    activeWorkspaceRoot: "C:/Users/dev/projects/real-project",
    activeWorkspace: { id: "ws-active", workspaceType: "local" },
    workspaces: [
      { id: "ws-active", workspaceType: "local", path: "C:/Users/dev/projects/real-project" },
    ],
    isPrivateWorkspacePath: isPrivate,
  });

  assert.deepEqual(source, { ok: false, reason: "not-private" });
});
