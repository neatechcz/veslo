import assert from "node:assert/strict";
import test from "node:test";

import { readContextSource, readWorkspaceFacadeSource } from "./workspace-source";

test("lazy runtime ensure lives in workspace runtime controller", () => {
  const runtimeSource = readContextSource("workspace-runtime-controller.ts");
  const facadeSource = readWorkspaceFacadeSource();

  assert.match(runtimeSource, /export function createWorkspaceRuntimeController\(/);
  assert.match(runtimeSource, /async function ensureEngineForWorkspace/);
  assert.match(runtimeSource, /connectMode: "quiet"/);
  assert.match(
    runtimeSource,
    /async function connectToEngineQuiet[\s\S]*deps\.routing\.ensure\(workspaceId, baseUrl,[\s\S]*deps\.setClient\(nextClient\);/s,
    "quiet reconnect must bind a workspace-scoped routed client before send uses routedClient(workspaceId)",
  );
  assert.match(runtimeSource, /reattachOrchestratorWorkspace\(/);
  assert.match(
    runtimeSource,
    /if \(!ok && runtime === "veslo-orchestrator"\) \{[\s\S]*ok = await reattachOrchestratorAfterColdStart\("browse-cold-start-reattach"\);[\s\S]*\}/,
    "orchestrator cold start should reattach the workspace when startHost starts the daemon but does not publish a route",
  );
  assert.match(runtimeSource, /withTimeoutOrThrow\(deps\.loadSessions\(workspace\.path\)/);
  assert.match(runtimeSource, /loadSessions failed; continuing first prompt/);
  assert.match(runtimeSource, /clearWorkspaceBusyAllExcept\(workspace\.id\)/);
  assert.match(
    runtimeSource,
    /const runtimeReady = workspace\.workspaceType === "local"[\s\S]*await deps\.ensureLocalRuntimeReadyForWorkspaceStart\?\.\(workspace\.path\)[\s\S]*if \(runtimeReady === false\) \{[\s\S]*ensure-engine:runtime-prerequisites-not-ready[\s\S]*return false;[\s\S]*\}[\s\S]*const skillsReady = await deps\.syncWorkspaceSkillMaterializationBeforeRuntime\(workspace,/s,
    "first-prompt lazy runtime startup must ask the local runtime readiness guard before skill sync or engine spawn",
  );
  assert.match(
    runtimeSource,
    /const isActiveWorkspace = workspace\.id === deps\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*if \(isActiveWorkspace\) \{[\s\S]*deps\.setEngineReady\?\.\(true\);[\s\S]*deps\.onEngineStable\?\.\(\);[\s\S]*\}/s,
    "runtime ensure should reflect engine readiness only for the currently active workspace",
  );
  assert.match(
    runtimeSource,
    /dispatchLifecycle\?: \(event: WorkspaceLifecycleEvent\) => void;/,
    "runtime controller should accept lifecycle dispatch from the workspace store instead of owning another state model",
  );
  assert.match(
    runtimeSource,
    /deps\.dispatchLifecycle\?\.\(\{[\s\S]*type: "runtime-starting",[\s\S]*workspaceId: id,[\s\S]*runtime,[\s\S]*reason: "ensure-engine-for-workspace",[\s\S]*\}\);[\s\S]*recordSendWorkflowTrace\("workspace-runtime", "ensure-engine:start"/s,
    "explicit runtime ensure should publish runtime-starting before it can spawn or attach the engine",
  );
  assert.match(
    runtimeSource,
    /deps\.updateWorkspaceConnectionState\(id, \{ status: "connected", message: null \}\);[\s\S]*deps\.dispatchLifecycle\?\.\(\{[\s\S]*type: "connected",[\s\S]*workspaceId: id,[\s\S]*runtime,[\s\S]*reason: "ensure-engine-for-workspace",[\s\S]*\}\);/s,
    "runtime ensure success should publish a workspace-scoped connected event",
  );
  assert.match(
    runtimeSource,
    /deps\.dispatchLifecycle\?\.\(\{[\s\S]*type: "failed",[\s\S]*workspaceId: id,[\s\S]*message,[\s\S]*\}\);[\s\S]*return false;/s,
    "runtime ensure failures should publish workspace-scoped failed events with the concrete message",
  );
  assert.match(
    runtimeSource,
    /const message = messageFromUnknownError\(e, deps\.safeStringify\);[\s\S]*setErrorForActiveWorkspace\(id, message\);/,
    "runtime ensure failures should keep concrete engine startup messages for the UI",
  );
  assert.match(
    facadeSource,
    /ensureLocalRuntimeReadyForWorkspaceStart: engineStore\.ensureLocalRuntimeReadyForWorkspaceStart,/,
    "workspace store should pass the same local runtime preflight used by startHost into lazy first-prompt runtime startup",
  );
  assert.doesNotMatch(facadeSource, /async function ensureEngineForWorkspace/);
});
