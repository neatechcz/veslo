import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceBehaviorSources } from "./workspace-source";

const behaviorSource = readWorkspaceBehaviorSources();
const source = readContextSource("workspace-skill-materialization.ts");
const runtimeSource = readContextSource("workspace-runtime-controller.ts");

test("workspace store defines a server-backed skill materialization sync gate", () => {
  assert.match(
    source,
    /export function createWorkspaceSkillMaterializationGate\([\s\S]*deps\.vesloServerClient\?\.\(\)[\s\S]*getWorkspaceSkillMaterializationStatus\([\s\S]*syncWorkspaceSkillMaterialization\(/s,
    "workspace activation should use the Veslo server materialization status/sync APIs",
  );

  assert.match(
    source,
    /deps\.workspaceBusy\(\)\[workspace\.id\][\s\S]*activeRun: true/s,
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
  const ensureIdx = source.indexOf("await deps.ensureLocalVesloServerRunning?.()");
  const clientIdx = source.indexOf("const client = deps.vesloServerClient?.()");

  assert.notStrictEqual(ensureIdx, -1, "local sync should ensure the managed Veslo server is running");
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
  const activationStart = behaviorSource.indexOf("async function activateWorkspace(");
  assert.notStrictEqual(activationStart, -1, "activateWorkspace is missing");
  const activationSource = behaviorSource.slice(activationStart, behaviorSource.indexOf("const connectionController = createWorkspaceConnectionController(", activationStart));

  const syncIdx = activationSource.indexOf("await syncWorkspaceSkillMaterializationBeforeRuntime(next,");
  const restartIdx = activationSource.indexOf("localRuntimeLifecycle.restartWorkspaceRuntime({");

  assert.notStrictEqual(syncIdx, -1, "activateWorkspace should sync skills before local runtime restart");
  assert.ok(syncIdx < restartIdx, "sync must happen before local-to-local runtime restart");
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
