import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sendWorkflowSource = readFileSync(
  new URL("../pages/session-send-workflow.ts", import.meta.url),
  "utf8",
);
const readinessSource = readFileSync(new URL("../context/send-runtime-readiness.ts", import.meta.url), "utf8");

function conversationRunCompatibilityBridgePrepareSource(): string {
  const bridgeStart = sendWorkflowSource.indexOf("export function createConversationRunCompatibilityBridge(");
  const prepareStart = sendWorkflowSource.indexOf("  const prepare = async", bridgeStart);
  const submitStart = sendWorkflowSource.indexOf("  const submit = async", prepareStart);
  assert.ok(prepareStart >= 0 && submitStart > prepareStart, "compatibility bridge prepare source should be present");
  return sendWorkflowSource.slice(prepareStart, submitStart);
}

function ensureLocalRuntimeReachableForSendResultSource(): string {
  const start = readinessSource.indexOf("async function ensureLocalRuntimeReachableForSendResult(");
  const end = readinessSource.indexOf("async function ensureLocalRuntimeReachableForSend(", start);
  assert.ok(start >= 0 && end > start, "ensureLocalRuntimeReachableForSendResult source should be present");
  return readinessSource.slice(start, end);
}

test("sendPrompt recovers a stale local runtime before reading the client", () => {
  const prepareSource = conversationRunCompatibilityBridgePrepareSource();
  const recoveryCheckIndex = prepareSource.indexOf('deps.prepareSendRuntimeForSend("sendPrompt", input.sendPreflight)');
  const routedClientIndex = prepareSource.indexOf("const c = deps.routedClientForSendTarget(input.sendTargetWorkspace);");
  assert.ok(recoveryCheckIndex >= 0, "compatibility bridge should prepare send runtime readiness");
  assert.ok(routedClientIndex >= 0, "compatibility bridge should capture the routed client after recovery");
  assert.ok(
    recoveryCheckIndex < routedClientIndex,
    "compatibility bridge should verify and recover the local runtime before capturing the routed client used for prompt calls",
  );
});

test("local runtime send health uses the routed active workspace client", () => {
  const recoverySource = ensureLocalRuntimeReachableForSendResultSource();
  assert.match(
    recoverySource,
    /const currentClient = targetWorkspaceId \? deps\.routedClient\(targetWorkspaceId\) : deps\.routedClient\(\);/,
    "local send health should inspect the routed active/target workspace client, not the stale global client",
  );
  assert.match(
    recoverySource,
    /const recoveredClient = targetWorkspaceId \? deps\.routedClient\(targetWorkspaceId\) : deps\.routedClient\(\);[\s\S]*if \(!started \|\| !recoveredClient\) \{/,
    "runtime recovery should require a successful ensure and restored route before send continues",
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
    /export function shouldRecoverLocalRuntimeFromHealthError\([\s\S]*error: unknown,[\s\S]*safeStringify\?: \(value: unknown\) => string,[\s\S]*\): boolean \{[\s\S]*error sending request[\s\S]*connection refused[\s\S]*ECONNREFUSED/s,
    "dead local endpoint errors should be classified as runtime recovery candidates",
  );
  assert.match(
    readinessSource,
    /export const localRuntimeHealthTimeoutMessage = "Timed out waiting for local runtime health";[\s\S]*export function isLocalRuntimeHealthTimeoutError\([\s\S]*safeStringify\?: \(value: unknown\) => string,[\s\S]*\): boolean \{[\s\S]*localRuntimeHealthTimeoutMessage/s,
    "health timeouts should stay separately detectable so stale daemon probes can trigger runtime recovery",
  );
  const recoverySource = ensureLocalRuntimeReachableForSendResultSource();
  assert.match(
    recoverySource,
    /const timedOut = isLocalRuntimeHealthTimeoutError\(error, deps\.safeStringify\);[\s\S]*const classifiedRecoverable = shouldRecoverLocalRuntimeFromHealthError\(error, deps\.safeStringify\);[\s\S]*recoverByDefault: !timedOut && !classifiedRecoverable,[\s\S]*willRecover: true,[\s\S]*deps\.recordSendTrace\(`\$\{reason\}:runtime-recovery-start`/s,
    "failed health probes against an existing routed client should fall through to runtime recovery by default",
  );
  assert.doesNotMatch(
    recoverySource,
    /!shouldRecoverLocalRuntimeFromHealthError\(error, deps\.safeStringify\)[\s\S]*return true;/s,
    "unclassified health failures must not continue with the existing routed client",
  );
  assert.match(
    recoverySource,
    /if \(targetIsActiveWorkspace\) \{[\s\S]*deps\.setEngineReady\(false\);[\s\S]*deps\.ensureEngineForWorkspace\(targetWorkspaceId \|\| undefined, \{[\s\S]*loadSessions: false/s,
    "runtime recovery should restart before send without forcing session-list UI side effects and reflect readiness only when the target is still active",
  );
});

test("send runtime recovery uses the snapshotted target workspace", () => {
  const recoverySource = ensureLocalRuntimeReachableForSendResultSource();

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
    /deps\.ensureEngineForWorkspace\(targetWorkspaceId \|\| undefined, \{[\s\S]*reason: `\$\{reason\}-runtime-recovery`,[\s\S]*loadSessions: false/s,
    "runtime recovery should restart the target workspace engine without blocking on session load",
  );
  assert.match(
    recoverySource,
    /const recoveredClient = targetWorkspaceId \? deps\.routedClient\(targetWorkspaceId\) : deps\.routedClient\(\);/,
    "runtime recovery should verify that the target workspace client was restored",
  );
  assert.match(
    recoverySource,
    /if \(!started \|\| !recoveredClient\) \{/,
    "runtime recovery must not continue unless ensure succeeded and the target workspace route was restored",
  );
});
