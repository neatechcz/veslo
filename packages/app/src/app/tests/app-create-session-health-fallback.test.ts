import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("createSessionAndOpen blocks session creation when runtime readiness cannot be proven", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const chooseFolderForCurrentSession = async () =>");
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");

  const createSessionAndOpenSource = source.slice(start, end);
  assert.match(
    createSessionAndOpenSource,
    /if \(!createRuntimeReady\) \{[\s\S]*recordSendTrace\("createSessionAndOpen:blocked-runtime-unreachable"[\s\S]*setError\("Local runtime is not ready yet\."\);[\s\S]*return undefined;[\s\S]*\}/,
    "createSessionAndOpen should not continue into session.create when runtime readiness cannot be proven",
  );
});

test("createSessionAndOpen attempts local runtime recovery before reading the routed client", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const chooseFolderForCurrentSession = async () =>");
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");

  const createSessionAndOpenSource = source.slice(start, end);
  const recoveryIndex = createSessionAndOpenSource.indexOf(
    'ensureLocalRuntimeReachableForSend("createSessionAndOpen", createRuntimePreflight)',
  );
  const clientIndex = createSessionAndOpenSource.indexOf("const c = routedClientForSendTarget(targetWorkspace);");
  assert.ok(recoveryIndex >= 0, "createSessionAndOpen should reuse the send runtime readiness recovery helper");
  assert.ok(clientIndex >= 0, "createSessionAndOpen should read the routed target client after recovery");
  assert.ok(
    recoveryIndex < clientIndex,
    "createSessionAndOpen should try runtime recovery before capturing the client used for session.create",
  );
  assert.doesNotMatch(
    createSessionAndOpenSource,
    /recordSendTrace\("createSessionAndOpen:runtime-unreachable-continue"/,
    "createSessionAndOpen should not preserve the stale-client fallback when recovery cannot prove readiness",
  );
  assert.doesNotMatch(
    createSessionAndOpenSource,
    /const withTimeout = async <T,>|c\.global\.health\(\)/,
    "createSessionAndOpen should not keep a separate direct health probe after delegating runtime readiness",
  );
});
