import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sendWorkflowSource = readFileSync(new URL("../pages/session-send-workflow.ts", import.meta.url), "utf8");
const readinessSource = readFileSync(new URL("../context/send-runtime-readiness.ts", import.meta.url), "utf8");

function ensureLocalRuntimeReachableForSendResultSource(): string {
  const start = readinessSource.indexOf("async function ensureLocalRuntimeReachableForSendResult(");
  const end = readinessSource.indexOf("async function ensureLocalRuntimeReachableForSend(", start);
  assert.ok(start >= 0 && end > start, "ensureLocalRuntimeReachableForSendResult source should be present");
  return readinessSource.slice(start, end);
}

test("local runtime send health uses the routed active workspace client", () => {
  const recoverySource = ensureLocalRuntimeReachableForSendResultSource();
  assert.match(
    recoverySource,
    /const currentClient = targetWorkspaceId\s*\? deps\.routedClient\(targetWorkspaceId\)\s*:\s*deps\.routedClient\(\);/,
    "local send health should inspect the routed active/target workspace client, not the stale global client",
  );
  assert.match(
    recoverySource,
    /const recoveredClient = targetWorkspaceId\s*\? deps\.routedClient\(targetWorkspaceId\)\s*:\s*deps\.routedClient\(\);[\s\S]*if \(!requested \|\| !recoveredClient\) \{/,
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
    /const activeWorkspaceId = deps\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*const activeWorkspaceRoot = deps\.activeWorkspaceRoot\(\)\.trim\(\);[\s\S]*await deps\.engineInfo\(\s*activeWorkspaceId \|\| undefined,\s*activeWorkspaceRoot \|\| undefined,\s*\)/s,
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
    /export function classifyLocalRuntimeRecoveryError\([\s\S]*error: unknown,[\s\S]*error sending request[\s\S]*connection refused[\s\S]*ECONNREFUSED/s,
    "dead local endpoint errors should be classified as runtime recovery candidates",
  );
  assert.match(
    readinessSource,
    /export function shouldRecoverLocalRuntimeFromHealthError\([\s\S]*return isAutomaticLocalRuntimeRecoveryCategory\(\s*classifyLocalRuntimeRecoveryError\(error, safeStringify\),\s*\);/s,
    "health recovery should delegate to the typed and transport classification boundary",
  );
  assert.match(
    readinessSource,
    /export const localRuntimeHealthTimeoutMessage\s*=\s*"Timed out waiting for local runtime health";[\s\S]*export function isLocalRuntimeHealthTimeoutError\([\s\S]*localRuntimeHealthTimeoutMessage/s,
    "health timeouts should stay separately detectable so stale daemon probes can trigger runtime recovery",
  );
  const recoverySource = ensureLocalRuntimeReachableForSendResultSource();
  assert.match(
    recoverySource,
    /const timedOut = isLocalRuntimeHealthTimeoutError\(\s*error,\s*deps\.safeStringify,\s*\);[\s\S]*const classifiedRecoverable = shouldRecoverLocalRuntimeFromHealthError\(\s*error,\s*deps\.safeStringify,\s*\);[\s\S]*recoverByDefault: !timedOut && !classifiedRecoverable,[\s\S]*willRecover: true,[\s\S]*deps\.recordSendTrace\(`\$\{reason\}:runtime-recovery-start`/s,
    "failed health probes against an existing routed client should fall through to runtime recovery by default",
  );
  assert.doesNotMatch(
    recoverySource,
    /!shouldRecoverLocalRuntimeFromHealthError\(error, deps\.safeStringify\)[\s\S]*return true;/s,
    "unclassified health failures must not continue with the existing routed client",
  );
  assert.match(
    recoverySource,
    /if \(targetIsActiveWorkspace\) \{[\s\S]*deps\.setEngineReady\(false\);[\s\S]*deps\.requestServerRuntimeRecovery\?\.\(\{[\s\S]*workspaceId: recoveryWorkspaceId,[\s\S]*reason: recoveryReason,/s,
    "runtime recovery should ask the server owner to decide the guarded restart and reflect readiness only when the target is still active",
  );
});

test("send runtime recovery uses the snapshotted target workspace", () => {
  const recoverySource = ensureLocalRuntimeReachableForSendResultSource();

  assert.match(
    recoverySource,
    /const targetWorkspaceId\s*=\s*preflight\?\.targetWorkspace\?\.workspaceId\?\.trim\(\)\s*\?\? "";/,
    "runtime health should read the send preflight target workspace",
  );
  assert.match(
    recoverySource,
    /const currentClient = targetWorkspaceId\s*\? deps\.routedClient\(targetWorkspaceId\)\s*:\s*deps\.routedClient\(\);/,
    "runtime health should probe the routed target workspace client when a target is present",
  );
  assert.match(
    recoverySource,
    /deps\.requestServerRuntimeRecovery\?\.\(\{[\s\S]*workspaceId: recoveryWorkspaceId,[\s\S]*reason: recoveryReason,/s,
    "runtime recovery should request the target workspace server-owned recovery operation",
  );
  assert.match(
    recoverySource,
    /const recoveredClient = targetWorkspaceId\s*\? deps\.routedClient\(targetWorkspaceId\)\s*:\s*deps\.routedClient\(\);/,
    "runtime recovery should verify that the target workspace client was restored",
  );
  assert.match(
    recoverySource,
    /if \(!requested \|\| !recoveredClient\) \{/,
    "runtime recovery must not continue unless ensure succeeded and the target workspace route was restored",
  );
});
