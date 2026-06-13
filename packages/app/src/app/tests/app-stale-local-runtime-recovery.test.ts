import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const readinessSource = readFileSync(new URL("../context/send-runtime-readiness.ts", import.meta.url), "utf8");

test("sendPrompt recovers a stale local runtime before reading the client", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");

  const sendPromptSource = source.slice(start, end);
  const recoveryCheckIndex = sendPromptSource.indexOf('ensureLocalRuntimeReachableForSend("sendPrompt", sendPreflight)');
  const routedClientIndex = sendPromptSource.indexOf("const c = routedClientForSendTarget(sendTargetWorkspace);");
  assert.ok(recoveryCheckIndex >= 0, "sendPrompt should check local runtime reachability");
  assert.ok(routedClientIndex >= 0, "sendPrompt should capture the routed client after recovery");
  assert.ok(
    recoveryCheckIndex < routedClientIndex,
    "sendPrompt should verify and recover the local runtime before capturing the routed client used for prompt calls",
  );
});

test("local runtime send health uses the routed active workspace client", () => {
  const start = readinessSource.indexOf("async function ensureLocalRuntimeReachableForSend(");
  const end = readinessSource.indexOf("async function connectLocalRuntimeClientFromEngineInfo", start);
  assert.ok(start >= 0 && end > start, "ensureLocalRuntimeReachableForSend source should be present");

  const recoverySource = readinessSource.slice(start, end);
  assert.match(
    recoverySource,
    /const currentClient = targetWorkspaceId \? deps\.routedClient\(targetWorkspaceId\) : deps\.routedClient\(\);/,
    "local send health should inspect the routed active/target workspace client, not the stale global client",
  );
  assert.match(
    recoverySource,
    /const recoveredClient = targetWorkspaceId \? deps\.routedClient\(targetWorkspaceId\) : deps\.routedClient\(\);[\s\S]*if \(!started \|\| !recoveredClient\) \{/,
    "runtime recovery should require a route for the active workspace before send continues",
  );
  assert.doesNotMatch(
    recoverySource,
    /const currentClient = client\(\);/,
    "raw global client can belong to a previous local workspace and must not pass send health",
  );
});

test("local runtime client reconnect uses workspace-scoped engine info", () => {
  const start = readinessSource.indexOf("async function connectLocalRuntimeClientFromEngineInfo(");
  const end = readinessSource.indexOf("return {", start);
  assert.ok(start >= 0 && end > start, "connectLocalRuntimeClientFromEngineInfo source should be present");

  const reconnectSource = readinessSource.slice(start, end);
  assert.match(
    reconnectSource,
    /const activeWorkspaceId = deps\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*const activeWorkspaceRoot = deps\.activeWorkspaceRoot\(\)\.trim\(\);[\s\S]*await deps\.engineInfo\(activeWorkspaceId \|\| undefined, activeWorkspaceRoot \|\| undefined\)/s,
    "engineInfo reconnect must be scoped to the active workspace id and path",
  );
  assert.match(
    reconnectSource,
    /deps\.connectToServer\([\s\S]*workspaceId: activeWorkspaceId \|\| undefined,[\s\S]*reason,[\s\S]*\{ quiet: true, navigate: false, forceRefresh: true \}/s,
    "engineInfo reconnect should publish the client through workspace routing, not by setting the raw global client only",
  );
});

test("local runtime recovery restarts for dead endpoints and health timeouts", () => {
  assert.match(
    readinessSource,
    /export function shouldRecoverLocalRuntimeFromHealthError\(error: unknown\): boolean \{[\s\S]*error sending request[\s\S]*connection refused[\s\S]*ECONNREFUSED/s,
    "dead local endpoint errors should be classified as runtime recovery candidates",
  );
  assert.match(
    readinessSource,
    /export const localRuntimeHealthTimeoutMessage = "Timed out waiting for local runtime health";[\s\S]*export function isLocalRuntimeHealthTimeoutError\(error: unknown\): boolean \{[\s\S]*localRuntimeHealthTimeoutMessage/s,
    "health timeouts should stay separately detectable so stale daemon probes can trigger runtime recovery",
  );
  assert.match(
    readinessSource,
    /if \(!isLocalRuntimeHealthTimeoutError\(error\) && !shouldRecoverLocalRuntimeFromHealthError\(error\)\) \{[\s\S]*return true;[\s\S]*deps\.setEngineReady\(false\);[\s\S]*deps\.ensureEngineForWorkspace\(targetWorkspaceId \|\| undefined\)/s,
    "runtime recovery should restart before send when the endpoint is dead or the local health probe times out",
  );
});

test("send runtime recovery uses the snapshotted target workspace", () => {
  const start = readinessSource.indexOf("async function ensureLocalRuntimeReachableForSend(");
  const end = readinessSource.indexOf("async function connectLocalRuntimeClientFromEngineInfo", start);
  assert.ok(start >= 0 && end > start, "ensureLocalRuntimeReachableForSend source should be present");
  const recoverySource = readinessSource.slice(start, end);

  assert.match(
    recoverySource,
    /const targetWorkspaceId = preflight\?\.targetWorkspace\?\.workspaceId\?\.trim\(\) \?\? "";/,
    "runtime health should read the send preflight target workspace",
  );
  assert.match(
    recoverySource,
    /const currentClient = targetWorkspaceId \? deps\.routedClient\(targetWorkspaceId\) : deps\.routedClient\(\);/,
    "runtime health should probe the routed target workspace client when a target is present",
  );
  assert.match(
    recoverySource,
    /deps\.ensureEngineForWorkspace\(targetWorkspaceId \|\| undefined\)/,
    "runtime recovery should restart the target workspace engine, not the current active workspace",
  );
  assert.match(
    recoverySource,
    /const recoveredClient = targetWorkspaceId \? deps\.routedClient\(targetWorkspaceId\) : deps\.routedClient\(\);/,
    "runtime recovery should verify that the target workspace client was restored",
  );
});
