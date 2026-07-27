import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceSkillMaterializationGate } from "../../context/workspace-skill-materialization.js";
import { VesloServerError } from "../../lib/veslo-server.js";
import { readContextSource } from "./workspace-source";

const source = readContextSource("workspace-skill-materialization.ts");
const runtimeSource = readContextSource("workspace-runtime-controller.ts");

function createGate(client: unknown, wsDebug: (label: string) => void = () => undefined) {
  return createWorkspaceSkillMaterializationGate({
    workspaceBusy: () => ({}),
    vesloServerClient: () => client as any,
    refreshSkills: async () => undefined,
    setError: () => undefined,
    updateWorkspaceConnectionState: () => undefined,
    wsDebug,
  });
}

test("runtime activation resolves the active view without materialization control-plane work", () => {
  assert.match(
    source,
    /client\.prepareRuntimeSkillView\(\s*workspaceId,/s,
    "runtime activation must prepare the serving view",
  );
  assert.doesNotMatch(
    source,
    /getWorkspaceSkillMaterializationStatus\(/,
    "ordinary runtime activation must not poll materialization status",
  );
  assert.doesNotMatch(
    source,
    /syncWorkspaceSkillMaterialization\(/,
    "ordinary runtime activation must not trigger materialization",
  );

  const helperCall = "await deps.syncWorkspaceSkillMaterializationBeforeRuntime(workspace,";
  const ensureStart = runtimeSource.indexOf("async function ensureEngineForWorkspace(");
  const ensureSource = runtimeSource.slice(ensureStart);
  assert.ok(ensureStart >= 0, "ensureEngineForWorkspace is missing");
  assert.ok(ensureSource.indexOf(helperCall) < ensureSource.indexOf("deps.localRuntimeLifecycle.prepareWorkspaceRuntime({"));
});

test("ordinary runtime preflight selects the serving binding before activation", async () => {
  let prepared = 0;
  let releasePrepare!: () => void;
  const prepareGate = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  const gate = createGate({
    prepareRuntimeSkillView: async () => {
      prepared += 1;
      await prepareGate;
      return {
        ready: true,
        revision: "view-1",
        authorizationRevision: "authorization-1",
        generatedAt: "2026-07-27T00:00:00.000Z",
        activeCount: 1,
        items: [{ name: "selected-skill" }],
      };
    },
  });

  let settled = false;
  const readyPromise = gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  ).then((ready) => {
    settled = true;
    return ready;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prepared, 1);
  assert.equal(settled, false);
  assert.equal(gate.runtimeSkillBinding("workspace-1"), null);
  releasePrepare();
  assert.equal(await readyPromise, true);
  assert.deepEqual(gate.runtimeSkillBinding("workspace-1"), {
    revision: "view-1",
    authorizationRevision: "authorization-1",
  });
});

test("ordinary runtime never requests a force refresh", async () => {
  const options: Array<{ forceRefresh?: boolean } | undefined> = [];
  const gate = createGate({
    prepareRuntimeSkillView: async (_workspaceId: string, next?: { forceRefresh?: boolean }) => {
      options.push(next);
      return {
        ready: true,
        revision: "view-2",
        authorizationRevision: "authorization-2",
        generatedAt: "2026-07-27T00:00:00.000Z",
        activeCount: 0,
        items: [],
      };
    },
  });

  await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );

  assert.deepEqual(options, [undefined]);
});

test("an older server without the manifest endpoint remains compatible", async () => {
  const labels: string[] = [];
  const gate = createGate({
    prepareRuntimeSkillView: async () => {
      throw new VesloServerError(404, "not_found", "Not found");
    },
  }, (label) => labels.push(label));

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
  );

  assert.equal(ready, true);
  assert.deepEqual(labels, ["skills:runtime-view:unsupported-server"]);
});

test("a failed serving-view refresh never blocks ordinary runtime", async () => {
  const labels: string[] = [];
  const gate = createGate({
    prepareRuntimeSkillView: async () => {
      throw new VesloServerError(503, "skills_unavailable", "Skills unavailable");
    },
  }, (label) => labels.push(label));

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );
  assert.equal(ready, true);
  assert.deepEqual(gate.runtimeSkillBinding("workspace-1"), {
    revision: "empty-direct-skill-view/v1",
    authorizationRevision: "empty-direct-skill-authorization/v1",
  });
  assert.ok(labels.includes("skills:materialization:failed"));
});
