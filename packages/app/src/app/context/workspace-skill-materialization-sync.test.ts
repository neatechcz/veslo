import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace.ts", import.meta.url), "utf8");

test("workspace store defines a server-backed skill materialization sync gate", () => {
  assert.match(
    source,
    /async function syncWorkspaceSkillMaterializationBeforeRuntime\([\s\S]*options\.vesloServerClient\?\.\(\)[\s\S]*getWorkspaceSkillMaterializationStatus\([\s\S]*syncWorkspaceSkillMaterialization\(/s,
    "workspace activation should use the Veslo server materialization status/sync APIs",
  );

  assert.match(
    source,
    /workspaceBusy\(\)\[workspace\.id\][\s\S]*activeRun: true/s,
    "active workspace runs must request pending materialization instead of mutating managed skill files",
  );
});

test("local runtime starts are gated behind skill materialization sync", () => {
  const helperCall = "await syncWorkspaceSkillMaterializationBeforeRuntime(workspace,";
  const ensureStart = source.indexOf("async function ensureEngineForWorkspace()");
  assert.notStrictEqual(ensureStart, -1, "ensureEngineForWorkspace is missing");

  const ensureSource = source.slice(ensureStart);
  const syncIdx = ensureSource.indexOf(helperCall);
  const restartIdx = ensureSource.indexOf("localRuntimeLifecycle.restartWorkspaceRuntime({");
  const coldStartIdx = ensureSource.indexOf("localRuntimeLifecycle.startHost({");

  assert.notStrictEqual(syncIdx, -1, "ensureEngineForWorkspace should sync skills before runtime start");
  assert.ok(syncIdx < restartIdx, "sync must happen before browsing-mode runtime restart");
  assert.ok(syncIdx < coldStartIdx, "sync must happen before browsing-mode cold start fallback");
});

test("workspace activation local restart is gated behind skill materialization sync", () => {
  const activationStart = source.indexOf("async function activateWorkspace(");
  assert.notStrictEqual(activationStart, -1, "activateWorkspace is missing");
  const activationSource = source.slice(activationStart, source.indexOf("async function connectToServer(", activationStart));

  const syncIdx = activationSource.indexOf("await syncWorkspaceSkillMaterializationBeforeRuntime(next,");
  const restartIdx = activationSource.indexOf("localRuntimeLifecycle.restartWorkspaceRuntime({");

  assert.notStrictEqual(syncIdx, -1, "activateWorkspace should sync skills before local runtime restart");
  assert.ok(syncIdx < restartIdx, "sync must happen before local-to-local runtime restart");
});
