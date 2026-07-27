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
    /deps\.isSuperseded\(\)[\s\S]*activate:superseded:before-local-set-active[\s\S]*workspaceSetActive\(id/,
    "stale local activations should not call workspaceSetActive after being superseded",
  );
  assert.match(
    localSource,
    /workspaceSetActive\(id[\s\S]*deps\.isSuperseded\(\)[\s\S]*activate:superseded:after-local-set-active[\s\S]*deps\.setWorkspaces\(ws\.workspaces\)/,
    "stale local workspaceSetActive responses should not be applied to UI state",
  );
  assert.match(
    localSource,
    /deps\.setWorkspaces\(ws\.workspaces\);[\s\S]*deps\.syncActiveWorkspaceId\(ws\.activeId\);[\s\S]*await deps\.activateVesloHostWorkspace\(next\.path\);/s,
    "local workspace activation should sync the Veslo server active workspace after local workspaceSetActive succeeds",
  );
  assert.match(
    localSource,
    // Whitespace-tolerant: this guards the error-handling path, not the
    // formatter's current line-wrapping choice.
    /const error =\s*e instanceof Error \? e\.message : deps\.safeStringify\(e\);[\s\S]*if \(error\.startsWith\("workspace_registry_unsynced:"\)\) \{[\s\S]*deps\.setError\(deps\.addOpencodeCacheHint\(error\)\);/s,
    "local workspace activation should surface Veslo registry sync failures to the UI",
  );
  assert.match(
    facadeSource,
    /createWorkspaceLocalActivation\(\{[\s\S]*activateVesloHostWorkspace,[\s\S]*setError: options\.setError,/s,
    "workspace facade should wire Veslo server active-workspace sync into local activation",
  );
  assert.match(
    localSource,
    /deps\.setEngineReady\?\.\(selection\.targetRuntimeReady\);[\s\S]*await deps\.populateSidebarFromDb!\(id, next\.path\);/,
    "browse mode should preserve target runtime readiness before title-only DB hydration",
  );
  assert.match(
    localSource,
    /if \(selection\.passiveBrowseActivation\) \{[\s\S]*activate:local:veslo-host-active:skip[\s\S]*reason: "passive-browse"[\s\S]*\} else \{[\s\S]*await deps\.activateVesloHostWorkspace\(next\.path\);/s,
    "passive local browse should not call Veslo server workspace activation/provisioning",
  );
  assert.match(
    localSource,
    /await deps\.syncWorkspaceSkillMaterializationBeforeRuntime\(next, \{[\s\S]*reason: "workspace-restart"/,
    "local runtime restart must be gated behind skill materialization",
  );
  assert.match(
    localSource,
    /async function reconnectRemoteToLocalHost\([\s\S]*await deps\.syncWorkspaceSkillMaterializationBeforeRuntime\(next, \{[\s\S]*reason: "workspace-attach-local"[\s\S]*prepareRuntimeWithSkillViewRefresh\(\{[\s\S]*prepare: prepareRuntime,/s,
    "remote-to-local attachment must materialize skills and bridge one changed-view refresh before preparing the engine",
  );
  assert.match(
    localSource,
    /let localFailureMessage: string \| null = null;[\s\S]*message: localFailureMessage \?\? deps\.indirectT\(/s,
    "remote-to-local attachment should keep the concrete skill recovery error in workspace connection state",
  );
  assert.match(
    localSource,
    /const message = e instanceof Error \? e\.message : deps\.safeStringify\(e\);[\s\S]*deps\.setError\(deps\.addOpencodeCacheHint\(message\)\);/,
    "local activation failures should keep concrete messages for the UI",
  );
  assert.doesNotMatch(facadeSource, /activate:local->local:browsingMode/);
  assert.doesNotMatch(facadeSource, /workspace-orchestrator-switch/);
});
