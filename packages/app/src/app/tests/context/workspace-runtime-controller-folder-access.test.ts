import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceRuntimeController } from "../../context/workspace-runtime-controller.js";

function makeController(input: {
  runtimeError: Error;
  folderAccessRequests?: Array<{
    workspaceId: string;
    workspacePath: string;
    requestedPath: string;
    reason: string;
  }>;
  errors?: string[];
}) {
  const workspace = {
    id: "ws-a",
    name: "Project",
    path: "/Users/example/Documents/Project",
    preset: "starter",
    workspaceType: "local",
  };

  return createWorkspaceRuntimeController({
    activeWorkspaceId: () => workspace.id,
    workspaces: () => [workspace as never],
    workspacesHydrated: () => true,
    routing: {
      release: () => {},
      ensure: async () => null,
      lastEnsureError: () => null,
    },
    resolveEngineRuntime: () => "direct",
    localRuntimeLifecycle: {
      prepareWorkspaceRuntime: async () => {
        throw input.runtimeError;
      },
    } as never,
    connectToServer: async () => true,
    loadSessions: async () => {},
    setClient: () => {},
    setConnectedVersion: () => {},
    setBaseUrl: () => {},
    setClientDirectory: () => {},
    setError: (message) => {
      if (message) input.errors?.push(message);
    },
    updateWorkspaceConnectionState: () => {},
    clearWorkspaceBusyAllExcept: () => {},
    ensureLocalRuntimeReadyForWorkspaceStart: async () => true,
    syncWorkspaceSkillMaterializationBeforeRuntime: async () => true,
    createClient: () => {
      throw new Error("createClient should not run when runtime startup fails");
    },
    waitForHealthy: async () => ({}),
    safeStringify: String,
    wsLog: () => {},
    requestWorkspaceFolderAccess: (request) => {
      input.folderAccessRequests?.push(request);
    },
  });
}

test("workspace runtime access denial requests folder access at the point of use", async () => {
  const folderAccessRequests: Array<{
    workspaceId: string;
    workspacePath: string;
    requestedPath: string;
    reason: string;
  }> = [];
  const errors: string[] = [];
  const controller = makeController({
    runtimeError: new Error("Failed to start Veslo server: Operation not permitted (os error 1)"),
    folderAccessRequests,
    errors,
  });

  const ok = await controller.ensureEngineForWorkspace("ws-a");

  assert.equal(ok, false);
  assert.deepEqual(folderAccessRequests, [
    {
      workspaceId: "ws-a",
      workspacePath: "/Users/example/Documents/Project",
      requestedPath: "/Users/example/Documents/Project",
      reason: "Failed to start Veslo server: Operation not permitted (os error 1)",
    },
  ]);
  assert.deepEqual(errors, []);
});

test("workspace runtime non-permission failure keeps the existing visible error path", async () => {
  const folderAccessRequests: Array<{
    workspaceId: string;
    workspacePath: string;
    requestedPath: string;
    reason: string;
  }> = [];
  const errors: string[] = [];
  const controller = makeController({
    runtimeError: new Error("OpenCode CLI is installed, but `opencode serve` is unavailable."),
    folderAccessRequests,
    errors,
  });

  const ok = await controller.ensureEngineForWorkspace("ws-a");

  assert.equal(ok, false);
  assert.deepEqual(folderAccessRequests, []);
  assert.deepEqual(errors, ["OpenCode CLI is installed, but `opencode serve` is unavailable."]);
});
