import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceInfo } from "./tauri";
import { buildSkillInstallTargetWorkspaces } from "./skill-install-targets";

const workspace = (input: Partial<WorkspaceInfo> & Pick<WorkspaceInfo, "id">): WorkspaceInfo => ({
  id: input.id,
  name: input.name ?? input.id,
  path: input.path ?? "",
  preset: input.preset ?? "starter",
  workspaceType: input.workspaceType ?? "local",
  directory: input.directory,
  displayName: input.displayName,
});

test("skill install targets exclude private workspaces but keep them out of the inventory model", () => {
  const privateRoot = "/Users/example/Library/Application Support/com.neatech.veslo.dev/private-workspaces";
  const targets = buildSkillInstallTargetWorkspaces({
    activeWorkspaceId: "regular",
    activeWorkspaceName: "Regular",
    activeWorkspaceRoot: "/Users/example/work/regular",
    activeWorkspaceType: "local",
    isPrivateWorkspacePath: (folder) => String(folder ?? "").startsWith(privateRoot),
    workspaces: [
      workspace({ id: "regular", path: "/Users/example/work/regular" }),
      workspace({ id: "private-chat", path: `${privateRoot}/chat-a` }),
      workspace({ id: "remote", workspaceType: "remote", path: "" }),
    ],
  });

  assert.deepEqual(targets.map((target) => target.id), ["regular", "remote"]);
});

test("skill install targets do not add the active fallback when the active workspace is private", () => {
  const privateRoot = "/Users/example/Library/Application Support/com.neatech.veslo.dev/private-workspaces";
  const targets = buildSkillInstallTargetWorkspaces({
    activeWorkspaceId: "active-private",
    activeWorkspaceName: "Chat",
    activeWorkspaceRoot: `${privateRoot}/chat-a`,
    activeWorkspaceType: "local",
    isPrivateWorkspacePath: (folder) => String(folder ?? "").startsWith(privateRoot),
    workspaces: [
      workspace({ id: "regular", path: "/Users/example/work/regular" }),
    ],
  });

  assert.deepEqual(targets.map((target) => target.id), ["regular"]);
});

test("skill install targets can be restricted to local filesystem workspaces", () => {
  const targets = buildSkillInstallTargetWorkspaces({
    activeWorkspaceId: "regular",
    activeWorkspaceName: "Regular",
    activeWorkspaceRoot: "/Users/example/work/regular",
    activeWorkspaceType: "local",
    isPrivateWorkspacePath: () => false,
    requireLocalFilesystemTarget: true,
    workspaces: [
      workspace({ id: "regular", path: "/Users/example/work/regular" }),
      workspace({ id: "pathless", path: "" }),
      workspace({ id: "directory-target", path: "", directory: "/Users/example/work/directory-target" }),
      workspace({ id: "remote", workspaceType: "remote", path: "" }),
    ],
  });

  assert.deepEqual(targets.map((target) => target.id), ["regular", "directory-target"]);
});
