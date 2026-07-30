import assert from "node:assert/strict";
import test from "node:test";

import {
  isLiveWebDriverRuntimeInfo,
  OWNED_BACKGROUND_COMMAND_LINE_PATTERN,
  ownedDiagnosticEnvironment,
  ownedRuntimeInfoPath,
  pnpmExecutable,
} from "./owned-runtime.mjs";

test("owned runtime helpers keep the launch mode and path explicit", () => {
  assert.equal(pnpmExecutable("win32"), "pnpm.cmd");
  assert.equal(pnpmExecutable("linux"), "pnpm");
  assert.match(ownedRuntimeInfoPath("C:/tmp/veslo-owned"), /runtime-info\.json$/);
  assert.equal(isLiveWebDriverRuntimeInfo({ schema: "veslo-dev-runtime/v1", mode: "live-dev-webdriver" }), true);
  assert.equal(isLiveWebDriverRuntimeInfo({ schema: "veslo-dev-runtime/v1", mode: "manual-pilot" }), false);
});

test("owned runtime cleanup includes detached desktop sidecars", () => {
  const pattern = new RegExp(OWNED_BACKGROUND_COMMAND_LINE_PATTERN, "i");
  assert.match("C:\\repo\\vite\\bin\\vite.js", pattern);
  assert.match("C:\\repo\\veslo-orchestrator.exe", pattern);
  assert.match("C:\\repo\\opencode.exe", pattern);
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
