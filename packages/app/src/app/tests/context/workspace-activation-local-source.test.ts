import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource } from "./workspace-source";

test("local workspace activation lives in a scoped activation module", () => {
  const localSource = readContextSource("workspace-activation-local.ts");
  const facadeSource = readContextSource("workspace.ts");

  assert.match(localSource, /export function createWorkspaceLocalActivation\(/);
  assert.match(localSource, /function prepareLocalWorkspaceSelection/);
  assert.match(localSource, /async function reconnectRemoteToLocalHost/);
  assert.match(localSource, /async function enterLocalBrowseMode/);
  assert.match(localSource, /async function restartLocalRuntimeForSwitch/);
  assert.match(
    localSource,
    /if \(restartResult === "superseded"\) return false;[\s\S]*if \(restartResult === "failed"\)/,
    "superseded local activations should not publish a restart failure",
  );
  assert.match(
    localSource,
    /deps\.setEngineReady\?\.\(false\);[\s\S]*await deps\.populateSidebarFromDb!\(id, next\.path\);/,
    "browse mode must mark engine not-ready before DB hydration",
  );
  assert.match(
    localSource,
    /await deps\.syncWorkspaceSkillMaterializationBeforeRuntime\(next, \{[\s\S]*reason: "workspace-restart"/,
    "local runtime restart must be gated behind skill materialization",
  );
  assert.match(
    localSource,
    /const message = e instanceof Error \? e\.message : deps\.safeStringify\(e\);[\s\S]*deps\.setError\(deps\.addOpencodeCacheHint\(message\)\);/,
    "local activation failures should keep concrete messages for the UI",
  );
  assert.doesNotMatch(facadeSource, /activate:local->local:browsingMode/);
  assert.doesNotMatch(facadeSource, /workspace-orchestrator-switch/);
});
