import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace.ts", import.meta.url), "utf8");

test("browse cold start uses the long local boot health window", () => {
  const longBootReasonsStart = source.indexOf("const LONG_BOOT_CONNECT_REASONS = new Set([");
  assert.notEqual(longBootReasonsStart, -1, "LONG_BOOT_CONNECT_REASONS should exist");

  const longBootReasonsEnd = source.indexOf("]);", longBootReasonsStart);
  const longBootReasons = source.slice(longBootReasonsStart, longBootReasonsEnd);
  assert.match(
    longBootReasons,
    /"browse-cold-start"/,
    "first prompt cold starts must not use the short default health timeout",
  );

  const ensureStart = source.indexOf("async function ensureEngineForWorkspace()");
  assert.notEqual(ensureStart, -1, "ensureEngineForWorkspace should exist");

  const ensureSource = source.slice(ensureStart);
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
    /catch \(startHostError\) \{[\s\S]*messageFromUnknownError\(startHostError\)\.includes\("Request timed out"\)[\s\S]*localRuntimeLifecycle\.reattachOrchestratorWorkspace\(\{[\s\S]*reason: "browse-cold-start-reattach"[\s\S]*connectMode: "quiet"/,
    "if engine_start times out after spawning orchestrator, first prompt should reattach instead of failing immediately",
  );
  assert.match(
    ensureSource,
    /try \{[\s\S]*withTimeoutOrThrow\(\s*options\.loadSessions\(workspace\.path\),\s*\{ timeoutMs: CONNECT_LOAD_SESSIONS_TIMEOUT_MS, label: "loadSessions" \},\s*\);[\s\S]*\} catch \(loadSessionsError\) \{[\s\S]*_wsLog\("\[workspace:ensureEngine\] loadSessions failed; continuing first prompt"[\s\S]*options\.setEngineReady\?\.\(true\);/s,
    "first prompt should log loadSessions failures but still mark the healthy engine ready so sending can continue",
  );
});
