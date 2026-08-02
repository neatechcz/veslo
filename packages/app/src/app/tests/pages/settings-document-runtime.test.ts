import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
test("settings does not expose document runtime diagnostics or maintenance actions", () => {
  assert.doesNotMatch(settingsSource, /documentRuntimeSettingsRow/);
  assert.doesNotMatch(settingsSource, /redactDocumentRuntimeStatus/);
  assert.doesNotMatch(settingsSource, /DocumentRuntimeStatusPayload/);
  assert.doesNotMatch(settingsSource, /documentRuntimeStatus/);
  assert.doesNotMatch(settingsSource, /repairDocumentRuntime/);
  assert.doesNotMatch(settingsSource, /document_runtime_z4n8k2/);
  assert.match(settingsSource, /props\.checkForUpdates\(\)/);
  assert.match(settingsSource, /runtimeSandbox: runtimeSandboxReport\(\)/);
  assert.match(settingsSource, /bootstrap: sanitizeBootstrapDiagnosticPayload\(/);
  assert.match(settingsSource, /lastServerLaunch:/);
});
