import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const enLocaleSource = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");

test("settings exposes document runtime diagnostics through the shared model", () => {
  assert.match(settingsSource, /documentRuntimeSettingsRow/);
  assert.match(settingsSource, /redactDocumentRuntimeStatus/);
  assert.match(settingsSource, /type DocumentRuntimeStatusPayload/);
  assert.match(settingsSource, /documentRuntimeStatus\?: DocumentRuntimeStatusPayload \| null/);
  assert.match(settingsSource, /repairDocumentRuntime\?: \(\) => void/);
  assert.match(settingsSource, /const documentRuntimeRow = createMemo/);
  assert.match(settingsSource, /__vesloT\("ui\.literal\.document_runtime_z4n8k2"/);
  assert.match(enLocaleSource, /"ui\.literal\.document_runtime_z4n8k2": "Document runtime"/);
  assert.match(settingsSource, /documentRuntimeRow\(\)\.status/);
  assert.match(settingsSource, /documentRuntimeRow\(\)\.detail/);
  assert.match(settingsSource, /action === "install" \|\| action === "repair" \|\| action === "update"/);
  assert.match(settingsSource, /Install office package/);
  assert.match(settingsSource, /Update office package/);
  assert.match(settingsSource, /documentRuntimeRow\(\)\.progressPercent/);
  assert.match(settingsSource, /bg-blue-9/);
  assert.match(settingsSource, /props\.repairDocumentRuntime\?\.\(\)/);
  assert.match(settingsSource, /props\.checkForUpdates\(\)/);
  assert.match(settingsSource, /documentRuntime: redactDocumentRuntimeStatus\(props\.documentRuntimeStatus\)/);
  assert.match(settingsSource, /runtimeSandbox: runtimeSandboxReport\(\)/);
  assert.match(settingsSource, /bootstrap: sanitizeBootstrapDiagnosticPayload\(/);
  assert.match(settingsSource, /lastServerLaunch:/);
});
