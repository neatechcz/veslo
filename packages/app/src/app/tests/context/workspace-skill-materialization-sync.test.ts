import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceSkillMaterializationGate } from "../../context/workspace-skill-materialization.js";
import { VesloServerError } from "../../lib/veslo-server.js";
import { readContextSource, readWorkspaceBehaviorSources } from "./workspace-source";

const behaviorSource = readWorkspaceBehaviorSources();
const source = readContextSource("workspace-skill-materialization.ts");
const runtimeSource = readContextSource("workspace-runtime-controller.ts");

function createGate(overrides: {
  client: unknown;
  workspaceBusy?: () => Record<string, Record<string, { startedAt: number }>>;
  setError?: (value: string | null) => void;
  updateWorkspaceConnectionState?: (workspaceId: string, next: unknown) => void;
  wsDebug?: (label: string, payload?: unknown) => void;
}) {
  return createWorkspaceSkillMaterializationGate({
    workspaceBusy: overrides.workspaceBusy ?? (() => ({})),
    vesloServerClient: () => overrides.client as any,
    refreshSkills: async () => undefined,
    setError: overrides.setError ?? (() => undefined),
    updateWorkspaceConnectionState: overrides.updateWorkspaceConnectionState as any ?? (() => undefined),
    wsDebug: overrides.wsDebug ?? (() => undefined),
  });
}

test("workspace store defines a server-backed skill materialization sync gate", () => {
  assert.match(
    source,
    /export function createWorkspaceSkillMaterializationGate\([\s\S]*deps\.vesloServerClient\?\.\(\)[\s\S]*getWorkspaceSkillMaterializationStatus\([\s\S]*syncWorkspaceSkillMaterialization\(/s,
    "workspace activation should use the Veslo server materialization status/sync APIs",
  );

  assert.match(
    source,
    /Object\.keys\(deps\.workspaceBusy\(\)\[workspace\.id\] \?\? \{\}\)\.length > 0[\s\S]*activeRun: true/s,
    "active workspace runs must request pending materialization instead of mutating managed skill files",
  );
});

test("workspace materialization sync forwards the signed-in Den API base", () => {
  assert.match(
    source,
    /denApiBase:\s*denAuth\?\.denApiBase\?\.trim\(\)\s*\|\|\s*undefined/,
    "runtime-start materialization sync must use the current signed-in Den API base, not only the server fallback config",
  );
});

test("local materialization sync starts the managed server before using the fallback client", () => {
  const ensureIdx = source.indexOf("await deps.ensureLocalVesloServerRunning?.({ requireRuntimeChainReady: false })");
  const clientIdx = source.indexOf("const client = deps.vesloServerClient?.()");

  assert.notStrictEqual(
    ensureIdx,
    -1,
    "local sync should ensure the managed Veslo server process is running without requiring the runtime chain it is about to start",
  );
  assert.notStrictEqual(clientIdx, -1, "local sync should read the Veslo server client");
  assert.ok(ensureIdx < clientIdx, "managed server startup must happen before reading the fallback client");
});

test("local runtime starts are gated behind skill materialization sync", () => {
  const helperCall = "await deps.syncWorkspaceSkillMaterializationBeforeRuntime(workspace,";
  const ensureStart = runtimeSource.indexOf("async function ensureEngineForWorkspace(");
  assert.notStrictEqual(ensureStart, -1, "ensureEngineForWorkspace is missing");

  const ensureSource = runtimeSource.slice(ensureStart);
  const syncIdx = ensureSource.indexOf(helperCall);
  const restartIdx = ensureSource.indexOf("deps.localRuntimeLifecycle.restartWorkspaceRuntime({");
  const coldStartIdx = ensureSource.indexOf("deps.localRuntimeLifecycle.startHost({");

  assert.notStrictEqual(syncIdx, -1, "ensureEngineForWorkspace should sync skills before runtime start");
  assert.ok(syncIdx < restartIdx, "sync must happen before browsing-mode runtime restart");
  assert.ok(syncIdx < coldStartIdx, "sync must happen before browsing-mode cold start fallback");
});

test("workspace activation local restart is gated behind skill materialization sync", () => {
  const activationSource = readContextSource("workspace-activation-local.ts");

  const syncIdx = activationSource.indexOf("await deps.syncWorkspaceSkillMaterializationBeforeRuntime(next,");
  const restartIdx = activationSource.indexOf("deps.localRuntimeLifecycle.restartWorkspaceRuntime({");

  assert.notStrictEqual(syncIdx, -1, "activateWorkspace should sync skills before local runtime restart");
  assert.ok(syncIdx < restartIdx, "sync must happen before local-to-local runtime restart");
});

test("configured pending materialization sync failure blocks runtime readiness", async () => {
  const debugLabels: string[] = [];
  const errors: Array<string | null> = [];
  const states: Array<{ workspaceId: string; next: unknown }> = [];
  const gate = createGate({
    client: {
      getWorkspaceSkillMaterializationStatus: async () => ({
        registryConfigured: true,
        status: "pending",
        reloadRequired: true,
      }),
      syncWorkspaceSkillMaterialization: async () => {
        throw new VesloServerError(404, "not_found", "Materialization sync route was not found");
      },
    },
    setError: (value) => errors.push(value),
    updateWorkspaceConnectionState: (workspaceId, next) => states.push({ workspaceId, next }),
    wsDebug: (label) => debugLabels.push(label),
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "send-preflight" },
  );

  assert.equal(ready, false);
  assert.deepEqual(debugLabels, ["skills:materialization:failed:configured-sync"]);
  assert.deepEqual(errors, ["Materialization sync route was not found"]);
  assert.deepEqual(states, [
    {
      workspaceId: "workspace-1",
      next: { status: "error", message: "Materialization sync route was not found" },
    },
  ]);
});

test("missing materialization status route remains an unsupported older server skip", async () => {
  const debugLabels: string[] = [];
  const gate = createGate({
    client: {
      getWorkspaceSkillMaterializationStatus: async () => {
        throw new VesloServerError(404, "not_found", "Not found");
      },
    },
    wsDebug: (label) => debugLabels.push(label),
  });

  const ready = await gate.syncWorkspaceSkillMaterializationBeforeRuntime(
    { id: "workspace-1", workspaceType: "local", path: "/repo" } as any,
    { reason: "activation" },
  );

  assert.equal(ready, true);
  assert.deepEqual(debugLabels, ["skills:materialization:skip:unsupported-server"]);
});

test("skill registry materialization outages degrade without blocking runtime start", () => {
  assert.match(
    source,
    /export function isSkillRegistryMaterializationError\(error: unknown\): boolean \{/,
    "workspace materialization should classify skill registry outages separately",
  );

  assert.match(
    source,
    /if \(isSkillRegistryMaterializationError\(error\)\) \{[\s\S]*deps\.wsDebug\("skills:materialization:degraded"[\s\S]*reportError\(error, "workspace\.skillMaterialization"\);[\s\S]*return true;[\s\S]*\}/s,
    "skill registry outages should be reported as degraded and allow runtime startup to continue",
  );
});

test("materialization hard failures keep concrete messages for UI", () => {
  assert.match(
    source,
    /const message = error instanceof Error \? error\.message : safeStringify\(error\);[\s\S]*deps\.setError\(addOpencodeCacheHint\(message\)\);[\s\S]*deps\.updateWorkspaceConnectionState\(workspaceId, \{ status: "error", message \}\);/s,
    "hard materialization failures should preserve the concrete error message in UI connection state",
  );
});
