import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("sendPrompt recovers a stale local runtime before reading the client", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");

  const sendPromptSource = source.slice(start, end);
  const recoveryCheckIndex = sendPromptSource.indexOf('ensureLocalRuntimeReachableForSend("sendPrompt")');
  const routedClientIndex = sendPromptSource.indexOf("const c = routedClient();");
  assert.ok(recoveryCheckIndex >= 0, "sendPrompt should check local runtime reachability");
  assert.ok(routedClientIndex >= 0, "sendPrompt should capture the routed client after recovery");
  assert.ok(
    recoveryCheckIndex < routedClientIndex,
    "sendPrompt should verify and recover the local runtime before capturing the routed client used for prompt calls",
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
    /if \(!isLocalRuntimeHealthTimeoutError\(error\) && !shouldRecoverLocalRuntimeFromHealthError\(error\)\) \{[\s\S]*return true;[\s\S]*setEngineReady\(false\);[\s\S]*workspaceStore\.ensureEngineForWorkspace\(\{ activeRun: true \}\)/s,
    "runtime recovery should restart before send when the endpoint is dead or the local health probe times out",
  );
});
