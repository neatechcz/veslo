import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptPath = resolve(__dirname, "./tauri-dev.mjs");

test("tauri-dev enables the manual Pilot runtime diagnostics by default", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /randomUUID/);
  assert.match(source, /VESLO_TAURI_PILOT/);
  assert.match(source, /manual-pilot/);
  assert.match(source, /pilot:default/);
  assert.match(source, /TAURI_PILOT_SOCKET/);
  assert.match(source, /TAURI_PILOT_LOG_DIR/);
  assert.match(source, /VESLO_RUNTIME_DIAGNOSTICS/);
  assert.match(source, /VITE_VESLO_RUNTIME_DIAGNOSTICS/);
  assert.match(source, /VESLO_RUNTIME_TRACE_FILE/);
  assert.match(source, /VESLO_SEND_WORKFLOW_TRACE_FILE/);
  assert.match(source, /VESLO_SEND_WORKFLOW_TRACE_UI_FILE/);
  assert.match(source, /VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE/);
  assert.match(source, /VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE/);
  assert.match(source, /deriveTraceFilePath/);
  assert.match(source, /\.\$\{channel\}\.ndjson/);
  assert.match(source, /optionalEnvValue\(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE"\)/);
  assert.doesNotMatch(source, /join\(repoRoot, "\.tmp", "send-workflow-trace\.ndjson"\)/);
  assert.match(source, /VITE_VESLO_SEND_WORKFLOW_TRACE/);
  assert.match(source, /VITE_VESLO_SESSION_UI_MUTATION_TRACE/);
  assert.match(source, /VESLO_OPENCODE_HEALTH_DIAG_FILE/);
  assert.match(source, /runtime-info\.json/);
  assert.match(source, /"--features"/);
  assert.match(source, /"e2e"/);
});

test("tauri-dev attributes the child exit before forwarding its result", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /tauri-child-exit/);
  assert.match(source, /timestamp=.*code=.*signal=/);
  assert.ok(
    source.indexOf("tauri-child-exit") < source.indexOf("process.exit(code ?? 0)"),
    "exit attribution must be written before the wrapper exits",
  );
});

test("tauri-dev keeps the native WebDriver endpoint opt-in and live-profile scoped", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /devCliArgs\.includes\("--webdriver"\)/);
  assert.match(source, /TAURI_WEBDRIVER_PORT/);
  assert.match(source, /VESLO_WEBDRIVER_DESCRIPTOR_PATH/);
  assert.match(source, /wdio-webdriver:default/);
  assert.match(source, /"webdriver"/);
  assert.match(source, /E2E_USE_EXISTING_PROFILE/);
  assert.match(source, /E2E_MANAGED_AI_GATEWAY_FIXTURE/);
  assert.match(source, /kind: webdriverRuntime \? "existing-development" : "development"/);
  assert.match(source, /isolated: false/);
  assert.match(source, /tauriCliArgs/);
});

test("live WebDriver startup rejects an inherited E2E profile override before spawning Tauri", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--webdriver"], {
    env: {
      ...process.env,
      E2E_USE_EXISTING_PROFILE: "1",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing live WebDriver mode with E2E\/profile overrides/);
  assert.match(result.stderr, /E2E_USE_EXISTING_PROFILE/);
  assert.doesNotMatch(result.stdout, /Running target\/debug\/veslo/);
});
