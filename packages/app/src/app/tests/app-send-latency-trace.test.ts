import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("send preflight records per-step latency trace entries for step 2", () => {
  assert.match(
    source,
    /const sendTraceStep = async <T,>\(/,
    "app should expose a helper that records duration for awaited send preflight steps",
  );
  for (const event of [
    "sendPrompt:maybe-resolve-skill-command",
    "sendPrompt:ensure-scoped-workspace-active",
    "sendPrompt:ensure-engine-for-workspace",
    "sendPrompt:ensure-managed-ai-bootstrap-ready",
    "sendPrompt:ensure-local-runtime-reachable",
    "sendPrompt:create-session-and-open",
  ]) {
    assert.match(
      source,
      new RegExp(`sendTraceStep\\(\\s*"${event}"`),
      `${event} should be timed with sendTraceStep`,
    );
  }
});

test("send flow preserves UI trace id and forwards trace entries to native logs", () => {
  assert.match(
    source,
    /const createSendPreflightContext = \(traceId\?: string \| null\): SendPreflightContext => \(\{\s*traceId: traceId\?\.trim\(\) \|\| makeSendTraceId\(\),/,
    "send preflight should reuse the trace id created by the UI send action",
  );
  assert.match(
    source,
    /const sendPreflight = createSendPreflightContext\(options\.sendTraceId\);/,
    "app sendPrompt should seed preflight tracing from composer send options",
  );
  assert.match(
    source,
    /logUiEvent\("send-trace", event, entry\);/,
    "app send trace entries should be forwarded to Tauri stderr",
  );
  assert.match(
    source,
    /relativeMs/,
    "send trace entries should include a relative timestamp for cold-start timelines",
  );
});

test("create session preflight records duration for duplicate gates and fallback branches", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("const openNewSessionWithDirectory", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const createSource = source.slice(start, end);

  for (const event of [
    "createSessionAndOpen:ensure-managed-ai-bootstrap-ready",
    "createSessionAndOpen:abort-refresh-settle",
    "createSessionAndOpen:health",
    "createSessionAndOpen:veslo-conversation-create",
    "createSessionAndOpen:legacy-session-create",
    "createSessionAndOpen:select-session",
  ]) {
    assert.match(
      createSource,
      new RegExp(`sendTraceStep\\(\\s*"${event}"`),
      `${event} should be timed with sendTraceStep`,
    );
  }
});
