import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceRuntimeController } from "../../context/workspace-runtime-controller.js";

test("explicit engine-only runtime starts bypass Managed AI config without changing normal starts", async () => {
  const calls: string[] = [];
  const controller = createWorkspaceRuntimeController({
    activeWorkspaceId: () => "ws-a",
    workspaces: () => [
      {
        id: "ws-a",
        name: "Workspace A",
        path: "/repo/a",
        workspaceType: "local",
      } as never,
    ],
    workspacesHydrated: () => true,
    routing: {
      release: () => {},
      ensure: async () => null,
      lastEnsureError: () => null,
    },
    resolveEngineRuntime: () => "veslo-orchestrator",
    localRuntimeLifecycle: {
      prepareWorkspaceRuntime: async () => {
        calls.push("prepare");
        return true;
      },
    } as never,
    connectToServer: async () => true,
    loadSessions: async () => {},
    setClient: () => {},
    setConnectedVersion: () => {},
    setBaseUrl: () => {},
    setClientDirectory: () => {},
    setEngineReady: () => {},
    setError: () => {},
    updateWorkspaceConnectionState: () => {},
    clearWorkspaceBusyAllExcept: () => {},
    ensureLocalRuntimeReadyForWorkspaceStart: async () => true,
    syncManagedAiRuntimeConfigBeforeRuntime: async () => {
      calls.push("managed-ai-config");
      return true;
    },
    syncWorkspaceSkillMaterializationBeforeRuntime: async (_workspace, options) => {
      calls.push(options.skipServingViewRefresh ? "skills-skipped" : "skills");
      return true;
    },
    createClient: () => {
      throw new Error("createClient should not run when prepare succeeds");
    },
    waitForHealthy: async () => ({}),
    safeStringify: String,
    wsLog: () => {},
  });

  assert.equal(
    await controller.ensureEngineForWorkspace("ws-a", {
      reason: "normal-start",
      loadSessions: false,
    }),
    true,
  );
  assert.equal(
    await controller.ensureEngineForWorkspace("ws-a", {
      reason: "sendPrompt-runtime-recovery",
      loadSessions: false,
      forceFreshRuntime: true,
      skipManagedAiConfig: true,
      skipServingViewRefresh: true,
    }),
    true,
  );

  assert.deepEqual(calls, [
    "managed-ai-config",
    "skills",
    "prepare",
    "skills-skipped",
    "prepare",
  ]);
});
