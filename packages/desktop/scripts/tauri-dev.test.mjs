import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptPath = resolve(__dirname, "./tauri-dev.mjs");

test("tauri-dev enables the manual Pilot runtime diagnostics by default", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /VESLO_TAURI_PILOT/);
  assert.match(source, /manual-pilot/);
  assert.match(source, /pilot:default/);
  assert.match(source, /TAURI_PILOT_SOCKET/);
  assert.match(source, /TAURI_PILOT_LOG_DIR/);
  assert.match(source, /VESLO_RUNTIME_TRACE_FILE/);
  assert.match(source, /VESLO_SEND_WORKFLOW_TRACE_FILE/);
  assert.match(source, /VESLO_SEND_WORKFLOW_TRACE_UI_FILE/);
  assert.match(source, /VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE/);
  assert.match(source, /VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE/);
  assert.match(source, /deriveTraceFilePath/);
  assert.match(source, /\.\$\{channel\}\.ndjson/);
  assert.match(source, /VITE_VESLO_SEND_WORKFLOW_TRACE/);
  assert.match(source, /VESLO_OPENCODE_HEALTH_DIAG_FILE/);
  assert.match(source, /runtime-info\.json/);
  assert.match(source, /"--features"/);
  assert.match(source, /"e2e"/);
});
