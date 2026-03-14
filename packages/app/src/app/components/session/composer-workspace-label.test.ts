import assert from "node:assert/strict";
import test from "node:test";

import { resolveComposerWorkspaceLabel } from "./composer-workspace-label.js";

test("shows folder path for local workspace when a non-temporary folder is active", () => {
  const result = resolveComposerWorkspaceLabel({
    isRemoteWorkspace: false,
    localWorkspacePath: "/Users/vaclavsoukup/AI agent projects/Openwork",
    localLabel: "Local workspace",
    remoteLabel: "Remote workspace",
  });

  assert.deepEqual(result, {
    label: "/Users/vaclavsoukup/AI agent projects/Openwork",
    usePathStyle: true,
  });
});

test("falls back to local label when no local folder path is available", () => {
  const result = resolveComposerWorkspaceLabel({
    isRemoteWorkspace: false,
    localWorkspacePath: "   ",
    localLabel: "Local workspace",
    remoteLabel: "Remote workspace",
  });

  assert.deepEqual(result, {
    label: "Local workspace",
    usePathStyle: false,
  });
});

test("uses remote label for remote workspaces", () => {
  const result = resolveComposerWorkspaceLabel({
    isRemoteWorkspace: true,
    localWorkspacePath: "/Users/example/project",
    localLabel: "Local workspace",
    remoteLabel: "Remote workspace",
  });

  assert.deepEqual(result, {
    label: "Remote workspace",
    usePathStyle: false,
  });
});
