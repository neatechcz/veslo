import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("sendPrompt recovers a stale local runtime before reading the client", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");

  const sendPromptSource = source.slice(start, end);
  assert.match(
    sendPromptSource,
    /if \(!\(await ensureManagedAiBootstrapReady\(\)\)\) \{[\s\S]*?return false;\s*\}\s*if \(!\(await ensureLocalRuntimeReachableForSend\("sendPrompt"\)\)\) \{\s*recordSendTrace\("sendPrompt:blocked-runtime-unreachable"\);[\s\S]*?return false;\s*\}\s*const c = client\(\);/s,
    "sendPrompt should verify and recover the local runtime before capturing the client used for create/prompt calls",
  );
});

test("local runtime recovery restarts only for dead endpoints and preserves flaky health fallback", () => {
  assert.match(
    source,
    /const shouldRecoverLocalRuntimeFromHealthError = \(error: unknown\): boolean => \{[\s\S]*error sending request[\s\S]*connection refused[\s\S]*ECONNREFUSED/s,
    "dead local endpoint errors should be classified as runtime recovery candidates",
  );
  assert.match(
    source,
    /const localRuntimeHealthTimeoutMessage = "Timed out waiting for local runtime health";[\s\S]*const isLocalRuntimeHealthTimeoutError = \(error: unknown\): boolean =>[\s\S]*localRuntimeHealthTimeoutMessage/s,
    "health timeouts should remain distinct from dead endpoint failures",
  );
  assert.match(
    source,
    /if \(isLocalRuntimeHealthTimeoutError\(error\) \|\| !shouldRecoverLocalRuntimeFromHealthError\(error\)\) \{[\s\S]*return true;[\s\S]*setEngineReady\(false\);[\s\S]*workspaceStore\.ensureEngineForWorkspace\(\)/s,
    "runtime recovery should ignore flaky health probes but restart before send when the endpoint is clearly dead",
  );
});
