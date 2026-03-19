import assert from "node:assert/strict";
import test from "node:test";

import { resolveComposerWorkspaceLabel } from "./composer-workspace-label.js";

test("shows only the last directory name for local workspace paths", () => {
  const result = resolveComposerWorkspaceLabel({
    isRemoteWorkspace: false,
    localWorkspacePath: "/Users/vaclavsoukup/AI agent projects/Openwork",
    localLabel: "Local workspace",
    remoteLabel: "Remote workspace",
  });

  assert.deepEqual(result, {
    label: "Openwork",
    usePathStyle: true,
  });
});

test("handles Windows-style local workspace paths", () => {
  const result = resolveComposerWorkspaceLabel({
    isRemoteWorkspace: false,
    localWorkspacePath: "C:\\Users\\vaclav\\Projects\\Openwork\\",
    localLabel: "Local workspace",
    remoteLabel: "Remote workspace",
  });

  assert.deepEqual(result, {
    label: "Openwork",
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
