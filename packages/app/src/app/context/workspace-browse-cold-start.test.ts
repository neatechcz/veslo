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
    /localRuntimeLifecycle\.startHost\(\{[\s\S]*reason: "browse-cold-start"/,
    "ensureEngineForWorkspace fallback should identify the cold first-prompt startup reason",
  );
  assert.match(
    ensureSource,
    /localRuntimeLifecycle\.startHost\(\{[\s\S]*reason: "browse-cold-start"[\s\S]*connectMode: "quiet"/,
    "first prompt cold starts should connect quietly and let ensureEngineForWorkspace own session loading",
  );
  assert.match(
    ensureSource,
    /catch \(startHostError\) \{[\s\S]*messageFromUnknownError\(startHostError,[\s\S]*\)\.includes\("Request timed out"\)[\s\S]*reattachOrchestratorAfterColdStart\("browse-cold-start-reattach", startHostError\)/,
    "if engine_start times out after spawning orchestrator, first prompt should reattach instead of failing immediately",
  );
  assert.match(
    ensureSource,
    /withTimeoutOrThrow\(deps\.loadSessions\(workspace\.path\),[\s\S]*label: "loadSessions"[\s\S]*catch \(loadSessionsError\)[\s\S]*loadSessions failed; continuing first prompt[\s\S]*deps\.setEngineReady\?\.\(true\);/s,
    "first prompt should log loadSessions failures but still mark the healthy engine ready so sending can continue",
  );

  assert.match(
    lifecycleSource,
    /runWorkspaceEngineRestartWithTimeouts\(/,
    "direct runtime restarts should keep using lifecycle restart timeouts",
  );
  assert.match(
    lifecycleSource,
    /deps\.readEngineInfo\(options\.workspaceId, options\.workspacePath\),[\s\S]*timeoutMs: 30_000,[\s\S]*label: "engine_info"/,
    "orchestrator reattach should keep the widened engine_info wait after activation",
  );
});
