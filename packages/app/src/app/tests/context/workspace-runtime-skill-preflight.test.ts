import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceSkillMaterializationGate } from "../../context/workspace-skill-materialization.js";

test("ordinary runtime preflight resolves only the active runtime view", async () => {
  let prepareCalls = 0;
  let statusCalls = 0;
  let syncCalls = 0;
  const gate = createWorkspaceSkillMaterializationGate({
    workspaceBusy: () => ({}),
    vesloServerClient: () => ({
      prepareRuntimeSkillView: async () => {
        prepareCalls += 1;
        return {
          ready: true,
          revision: "runtime-view-1",
          authorizationRevision: "runtime-authorization-1",
          generatedAt: "2026-07-27T00:00:00.000Z",
          activeCount: 1,
          items: [{ name: "selected-skill" }],
        };
      },
      getWorkspaceSkillMaterializationStatus: async () => {
        statusCalls += 1;
        throw new Error("runtime preflight must not poll materialization status");
      },
      syncWorkspaceSkillMaterialization: async () => {
        syncCalls += 1;
        throw new Error("runtime preflight must not sync materialization");
      },
    } as any),
    refreshSkills: async () => undefined,
    setError: () => undefined,
    updateWorkspaceConnectionState: () => undefined,
    wsDebug: () => undefined,
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime({
    id: "workspace-1",
    workspaceType: "local",
    path: "/repo",
  } as any, { reason: "send-preflight" });

  assert.equal(ready, true);
  assert.equal(prepareCalls, 1);
  assert.equal(statusCalls, 0);
  assert.equal(syncCalls, 0);
  assert.deepEqual(gate.runtimeSkillBinding("workspace-1"), {
    revision: "runtime-view-1",
    authorizationRevision: "runtime-authorization-1",
  });
});

test("ordinary runtime never turns a stale hint into a force-refresh retry", async () => {
  const forceRefreshes: Array<{ forceRefresh?: boolean } | undefined> = [];
  const gate = createWorkspaceSkillMaterializationGate({
    workspaceBusy: () => ({}),
    vesloServerClient: () => ({
      prepareRuntimeSkillView: async (_workspaceId: string, options?: { forceRefresh?: boolean }) => {
        forceRefreshes.push(options);
        return {
          ready: true,
          revision: "runtime-view-2",
          authorizationRevision: "runtime-authorization-2",
          generatedAt: "2026-07-27T00:00:00.000Z",
          activeCount: 0,
          items: [],
        };
      },
      getWorkspaceSkillMaterializationStatus: async () => {
        throw new Error("runtime preflight must not poll materialization status");
      },
      syncWorkspaceSkillMaterialization: async () => {
        throw new Error("runtime preflight must not sync materialization");
      },
    } as any),
    refreshSkills: async () => undefined,
    setError: () => undefined,
    updateWorkspaceConnectionState: () => undefined,
    wsDebug: () => undefined,
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime({
    id: "workspace-1",
    workspaceType: "local",
    path: "/repo",
  } as any, { reason: "send-preflight" });

  assert.equal(ready, true);
  assert.deepEqual(forceRefreshes, [undefined]);
});
