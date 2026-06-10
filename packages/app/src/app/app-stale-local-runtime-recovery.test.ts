import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("sendPrompt recovers a stale local runtime before reading the client", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");

  const sendPromptSource = source.slice(start, end);
  const recoveryCheckIndex = sendPromptSource.indexOf('ensureLocalRuntimeReachableForSend("sendPrompt", sendPreflight)');
  const routedClientIndex = sendPromptSource.indexOf("const c = routedClient();");
  assert.ok(recoveryCheckIndex >= 0, "sendPrompt should check local runtime reachability");
  assert.ok(routedClientIndex >= 0, "sendPrompt should capture the routed client after recovery");
  assert.ok(
    recoveryCheckIndex < routedClientIndex,
    "sendPrompt should verify and recover the local runtime before capturing the routed client used for prompt calls",
  );
});

test("local runtime send health uses the routed active workspace client", () => {
  const start = source.indexOf("async function ensureLocalRuntimeReachableForSend(");
  const end = source.indexOf("async function connectLocalRuntimeClientFromEngineInfo", start);
  assert.ok(start >= 0 && end > start, "ensureLocalRuntimeReachableForSend source should be present");

  const recoverySource = source.slice(start, end);
  assert.match(
    recoverySource,
    /const currentClient = routedClient\(\);/,
    "local send health should inspect the routed active workspace client, not the stale global client",
  );
  assert.match(
    recoverySource,
    /if \(!started \|\| !routedClient\(\)\) \{/,
    "runtime recovery should require a route for the active workspace before send continues",
  );
  assert.doesNotMatch(
    recoverySource,
    /const currentClient = client\(\);/,
    "raw global client can belong to a previous local workspace and must not pass send health",
  );
});

test("local runtime client reconnect uses workspace-scoped engine info", () => {
  const start = source.indexOf("async function connectLocalRuntimeClientFromEngineInfo(");
  const end = source.indexOf("const [showThinking", start);
  assert.ok(start >= 0 && end > start, "connectLocalRuntimeClientFromEngineInfo source should be present");

  const reconnectSource = source.slice(start, end);
  assert.match(
    reconnectSource,
    /const activeWorkspaceId = workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*const activeWorkspaceRoot = workspaceStore\.activeWorkspaceRoot\(\)\.trim\(\);[\s\S]*await engineInfo\(activeWorkspaceId \|\| undefined, activeWorkspaceRoot \|\| undefined\)/s,
    "engineInfo reconnect must be scoped to the active workspace id and path",
  );
  assert.match(
    reconnectSource,
    /workspaceStore\.connectToServer\([\s\S]*workspaceId: activeWorkspaceId \|\| undefined,[\s\S]*reason,[\s\S]*\{ quiet: true, navigate: false, forceRefresh: true \}/s,
    "engineInfo reconnect should publish the client through workspace routing, not by setting the raw global client only",
  );
});

test("local runtime recovery restarts for dead endpoints and health timeouts", () => {
  assert.match(
    source,
    /const shouldRecoverLocalRuntimeFromHealthError = \(error: unknown\): boolean => \{[\s\S]*error sending request[\s\S]*connection refused[\s\S]*ECONNREFUSED/s,
    "dead local endpoint errors should be classified as runtime recovery candidates",
  );
  assert.match(
    source,
    /const localRuntimeHealthTimeoutMessage = "Timed out waiting for local runtime health";[\s\S]*const isLocalRuntimeHealthTimeoutError = \(error: unknown\): boolean =>[\s\S]*localRuntimeHealthTimeoutMessage/s,
    "health timeouts should stay separately detectable so stale daemon probes can trigger runtime recovery",
  );
  assert.match(
    source,
    /if \(!isLocalRuntimeHealthTimeoutError\(error\) && !shouldRecoverLocalRuntimeFromHealthError\(error\)\) \{[\s\S]*return true;[\s\S]*setEngineReady\(false\);[\s\S]*workspaceStore\.ensureEngineForWorkspace\(\)/s,
    "runtime recovery should restart before send when the endpoint is dead or the local health probe times out",
  );
});
