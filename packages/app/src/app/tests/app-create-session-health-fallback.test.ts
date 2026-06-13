import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("createSessionAndOpen does not abort session creation solely because the health preflight timed out", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const openNewSessionWithDirectory = async () =>");
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");

  const createSessionAndOpenSource = source.slice(start, end);
  assert.doesNotMatch(
    createSessionAndOpenSource,
    /throw new Error\(t\("app\.connection_lost", currentLocale\(\)\)\);/,
    "createSessionAndOpen should fall through to session.create when the health probe is flaky instead of failing the send immediately",
  );
});

test("createSessionAndOpen attempts local runtime recovery before reading the routed client", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const openNewSessionWithDirectory = async () =>");
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
  assert.match(
    createSessionAndOpenSource,
    /if \(!createRuntimeReady\) \{[\s\S]*recordSendTrace\("createSessionAndOpen:runtime-unreachable-continue"/,
    "createSessionAndOpen should preserve the flaky-health fallback and continue when recovery cannot prove readiness",
  );
  assert.doesNotMatch(
    createSessionAndOpenSource,
    /const withTimeout = async <T,>|c\.global\.health\(\)/,
    "createSessionAndOpen should not keep a separate direct health probe after delegating runtime readiness",
  );
});
