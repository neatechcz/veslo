import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtimeControllerSource = readFileSync(
  new URL("./workspace-runtime-controller.ts", import.meta.url),
  "utf8",
);
const lifecycleSource = readFileSync(
  new URL("../utils/local-runtime-lifecycle.ts", import.meta.url),
  "utf8",
);

test("browse cold start is owned by workspace runtime controller and lifecycle", () => {
  const ensureStart = runtimeControllerSource.indexOf("async function ensureEngineForWorkspace(");
  assert.notEqual(ensureStart, -1, "ensureEngineForWorkspace should exist in workspace runtime controller");

  const ensureSource = runtimeControllerSource.slice(ensureStart);
  assert.match(
    ensureSource,
    /const prepareReason = ensureReason;[\s\S]*localRuntimeLifecycle\.prepareWorkspaceRuntime\(\{/,
    "ensureEngineForWorkspace should pass the original runtime intent to the backend prepare owner",
  );
  assert.match(
    ensureSource,
    /localRuntimeLifecycle\.prepareWorkspaceRuntime\(\{[\s\S]*reason: prepareReason,[\s\S]*connectMode: "quiet"/,
    "first prompt runtime prepare should connect quietly and let ensureEngineForWorkspace own session loading",
  );
  assert.doesNotMatch(
    ensureSource,
    /startHostQuiet|reattachOrchestratorAfterColdStart|localRuntimeLifecycle\.startHost\(/,
    "backend prepare should own cold-start fallback decisions instead of the UI retrying lifecycle primitives",
  );
  assert.match(
    ensureSource,
    /withTimeoutOrThrow\(deps\.loadSessions\(workspace\.path\),[\s\S]*label: "loadSessions"[\s\S]*catch \(loadSessionsError\)[\s\S]*loadSessions failed; continuing first prompt[\s\S]*deps\.setEngineReady\?\.\(true\);/s,
    "first prompt should log loadSessions failures but still mark the healthy engine ready so sending can continue",
  );

  assert.match(
    lifecycleSource,
    /const nativePrepare = deps\.prepareWorkspaceRuntime\(input\);/,
    "local runtime lifecycle should delegate process preparation to the backend command",
  );
  assert.doesNotMatch(
    lifecycleSource,
    /runWorkspaceEngineRestartWithTimeouts\(|deps\.startEngine\(|deps\.stopEngine\(|deps\.activateOrchestratorWorkspace\(/,
    "frontend lifecycle code should not choose engine process primitives",
  );
});
