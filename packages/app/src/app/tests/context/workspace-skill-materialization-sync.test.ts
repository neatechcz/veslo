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

test("engine-only recovery selects a local binding without waiting for Skills", async () => {
  let requests = 0;
  const gate = createGate({
    prepareRuntimeSkillView: async () => {
      requests += 1;
      throw new Error("this request must not run during engine-only recovery");
    },
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "runtime-recovery", skipServingViewRefresh: true },
  );

  assert.equal(ready, true);
  assert.equal(requests, 0);
  assert.deepEqual(gate.runtimeSkillBinding("workspace-1", "/repo"), {
    revision: "empty-direct-skill-view/v1",
    authorizationRevision: "empty-direct-skill-authorization/v1",
  });
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

test("a binding resolved for another path is treated as absent", async () => {
  const gate = createGate({
    prepareRuntimeSkillView: async () => ({
      ready: true,
      revision: "view-1",
      authorizationRevision: "authorization-1",
      generatedAt: "2026-07-28T00:00:00.000Z",
      activeCount: 1,
      items: [],
    }),
  });

  await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );

  assert.deepEqual(gate.runtimeSkillBinding("workspace-1", "/repo"), {
    revision: "view-1",
    authorizationRevision: "authorization-1",
  });
  // Same id, different path: a reused or repointed workspace must re-resolve
  // rather than inherit a view that was never agreed for it.
  assert.equal(gate.runtimeSkillBinding("workspace-1", "/other-repo"), null);
});

test("forgetting a workspace clears its runtime binding", async () => {
  const gate = createGate({
    prepareRuntimeSkillView: async () => ({
      ready: true,
      revision: "view-1",
      authorizationRevision: "authorization-1",
      generatedAt: "2026-07-28T00:00:00.000Z",
      activeCount: 1,
      items: [],
    }),
  });

  await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );
  assert.notEqual(gate.runtimeSkillBinding("workspace-1"), null);

  gate.forgetWorkspaceRuntimeBinding("workspace-1");
  assert.equal(gate.runtimeSkillBinding("workspace-1"), null);
});

test("a slow preparation cannot publish over a newer one", async () => {
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let calls = 0;
  const gate = createGate({
    prepareRuntimeSkillView: async () => {
      calls += 1;
      if (calls === 1) {
        await slowGate;
        return {
          ready: true,
          revision: "stale-view",
          authorizationRevision: "stale-authorization",
          generatedAt: "2026-07-28T00:00:00.000Z",
          activeCount: 0,
          items: [],
        };
      }
      return {
        ready: true,
        revision: "current-view",
        authorizationRevision: "current-authorization",
        generatedAt: "2026-07-28T00:00:01.000Z",
        activeCount: 1,
        items: [],
      };
    },
  });

  // Distinct paths so the two preparations do not share a single flight.
  const slow = gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );
  await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo-moved" } as any,
    { reason: "send-preflight" },
  );
  assert.deepEqual(gate.runtimeSkillBinding("workspace-1", "/repo-moved"), {
    revision: "current-view",
    authorizationRevision: "current-authorization",
  });

  releaseSlow();
  await slow;

  // The late arrival belongs to a superseded epoch and must not win.
  assert.deepEqual(gate.runtimeSkillBinding("workspace-1", "/repo-moved"), {
    revision: "current-view",
    authorizationRevision: "current-authorization",
  });
});

test("forgetting a workspace fences an in-flight binding before the id is reused", async () => {
  let releaseOld!: () => void;
  const oldBlocked = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let calls = 0;
  const gate = createGate({
    prepareRuntimeSkillView: async () => {
      calls += 1;
      if (calls === 1) {
        await oldBlocked;
        return {
          ready: true,
          revision: "old-view",
          authorizationRevision: "old-authorization",
          generatedAt: "2026-07-28T00:00:00.000Z",
          activeCount: 1,
          items: [],
        };
      }
      return {
        ready: true,
        revision: "new-view",
        authorizationRevision: "new-authorization",
        generatedAt: "2026-07-28T00:00:01.000Z",
        activeCount: 1,
        items: [],
      };
    },
  });

  const old = gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/old" } as any,
    { reason: "send-preflight" },
  );
  await Promise.resolve();
  gate.forgetWorkspaceRuntimeBinding("workspace-1");
  const replacement = gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/new" } as any,
    { reason: "send-preflight" },
  );

  releaseOld();
  await Promise.all([old, replacement]);

  assert.deepEqual(gate.runtimeSkillBinding("workspace-1", "/new"), {
    revision: "new-view",
    authorizationRevision: "new-authorization",
  });
  assert.equal(gate.runtimeSkillBinding("workspace-1", "/old"), null);
});
