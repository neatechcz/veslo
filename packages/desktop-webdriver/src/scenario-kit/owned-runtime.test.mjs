import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isLiveWebDriverRuntimeInfo,
  isIsolatedWebDriverRuntimeInfo,
  OWNED_BACKGROUND_COMMAND_LINE_PATTERN,
  ownedDiagnosticEnvironment,
  ownedRuntimeInfoPath,
  pnpmExecutable,
} from "./owned-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("owned runtime helpers keep the launch mode and path explicit", () => {
  assert.equal(pnpmExecutable("win32"), "pnpm.cmd");
  assert.equal(pnpmExecutable("linux"), "pnpm");
  assert.match(ownedRuntimeInfoPath("C:/tmp/veslo-owned"), /runtime-info\.json$/);
  assert.equal(isLiveWebDriverRuntimeInfo({ schema: "veslo-dev-runtime/v1", mode: "live-dev-webdriver" }), true);
  assert.equal(isLiveWebDriverRuntimeInfo({ schema: "veslo-dev-runtime/v1", mode: "manual-pilot" }), false);
  assert.equal(isIsolatedWebDriverRuntimeInfo({ schema: "veslo-dev-runtime/v1", mode: "isolated-dev-webdriver" }), true);
});

test("owned runtime cleanup includes detached desktop sidecars", () => {
  const pattern = new RegExp(OWNED_BACKGROUND_COMMAND_LINE_PATTERN, "i");
  assert.match("C:\\repo\\vite\\bin\\vite.js", pattern);
  assert.match("C:\\repo\\veslo-orchestrator.exe", pattern);
  assert.match("C:\\repo\\opencode.exe", pattern);
  assert.match("target\\debug\\veslo.exe", pattern);
  assert.doesNotMatch("C:\\Users\\user\\AppData\\Local\\Veslo\\veslo.exe", pattern);
});

test("Windows preflight excludes its own PowerShell probe process", () => {
  const source = readFileSync(resolve(__dirname, "./owned-runtime.mjs"), "utf8");
  assert.match(source, /ProcessId -ne \$PID -and \$_\.CommandLine/);
});

test("isolated runtime keeps its descriptor inside the harness-owned run directory", () => {
  const source = readFileSync(resolve(__dirname, "./owned-runtime.mjs"), "utf8");
  assert.match(source, /VESLO_DEV_RUNTIME_DIR: runDirectory/);
  assert.match(source, /isolatedRuntimeEnvironment\(env, paths, normalizedGatewayBaseUrl, resolvedRunDirectory\)/);
  assert.match(source, /RUSTUP_HOME: rustupHome/);
  assert.match(source, /CARGO_HOME: cargoHome/);
});

test("isolated runtime preserves native startup output when descriptor publication fails", () => {
  const source = readFileSync(resolve(__dirname, "./owned-runtime.mjs"), "utf8");
  assert.match(source, /desktop-runtime-output\.log/);
  assert.match(source, /See \$\{output\?\.outputPath/);
  assert.match(source, /code=\$\{child\.exitCode/);
});

test("owned scenarios force all local diagnostic channels on", () => {
  const environment = ownedDiagnosticEnvironment({
    VESLO_RUNTIME_DIAGNOSTICS: "0",
    VESLO_SEND_WORKFLOW_TRACE: "false",
  });
  assert.equal(environment.VESLO_RUNTIME_DIAGNOSTICS, "1");
  assert.equal(environment.VESLO_SEND_WORKFLOW_TRACE, "1");
  assert.equal(environment.VITE_VESLO_SESSION_UI_MUTATION_TRACE, "1");
  assert.equal(environment.VESLO_OPENCODE_HEALTH_DIAG, "1");
});
