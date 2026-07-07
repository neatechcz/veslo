import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const createWorkflowSource = readFileSync(new URL("../pages/session-creation-workflow.ts", import.meta.url), "utf8");

function createSessionAndOpenSource(): string {
  const start = createWorkflowSource.indexOf("  const runCreateSessionFlow = async (");
  const end = createWorkflowSource.indexOf("  const createSession = (", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen runtime preflight source should be present");
  return createWorkflowSource.slice(start, end);
}

test("createSessionAndOpen blocks session creation when runtime readiness cannot be proven", () => {
  const source = createSessionAndOpenSource();
  assert.match(
    source,
    /if \(!createRuntimeReady\) \{[\s\S]*deps\.recordSendTrace\("createSessionAndOpen:blocked-runtime-unreachable"[\s\S]*deps\.setError\("Local runtime is not ready yet\."\);[\s\S]*return undefined;[\s\S]*\}/,
    "createSessionAndOpen should not continue into session.create when runtime readiness cannot be proven",
  );
});

test("createSessionAndOpen attempts local runtime recovery before reading the routed client", () => {
  const source = createSessionAndOpenSource();
  const recoveryIndex = source.indexOf(
    'deps.ensureLocalRuntimeReachableForSend("createSessionAndOpen", createPreflight)',
  );
  const clientIndex = source.indexOf("const client = deps.routedClientForSendTarget(targetWorkspace);");
  assert.ok(recoveryIndex >= 0, "createSessionAndOpen should reuse the send runtime readiness recovery helper");
  assert.ok(clientIndex >= 0, "createSessionAndOpen should read the routed target client after recovery");
  assert.ok(
    recoveryIndex < clientIndex,
    "createSessionAndOpen should try runtime recovery before capturing the client used for session.create",
  );
  assert.doesNotMatch(
    source,
    /recordSendTrace\("createSessionAndOpen:runtime-unreachable-continue"/,
    "createSessionAndOpen should not preserve the stale-client fallback when recovery cannot prove readiness",
  );
  assert.doesNotMatch(
    source,
    /const withTimeout = async <T,>|c\.global\.health\(\)/,
    "createSessionAndOpen should not keep a separate direct health probe after delegating runtime readiness",
  );
});
