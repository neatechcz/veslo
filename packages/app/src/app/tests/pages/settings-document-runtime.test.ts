import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");

test("settings exposes document runtime diagnostics through the shared model", () => {
  assert.match(settingsSource, /documentRuntimeSettingsRow/);
  assert.match(settingsSource, /type DocumentRuntimeStatusPayload/);
  assert.match(settingsSource, /documentRuntimeStatus\?: DocumentRuntimeStatusPayload \| null/);
  assert.match(settingsSource, /repairDocumentRuntime\?: \(\) => void/);
  assert.match(settingsSource, /const documentRuntimeRow = createMemo/);
  assert.match(settingsSource, />Document runtime</);
  assert.match(settingsSource, /documentRuntimeRow\(\)\.status/);
  assert.match(settingsSource, /documentRuntimeRow\(\)\.detail/);
  assert.match(settingsSource, /documentRuntimeRow\(\)\.action === "repair"/);
  assert.match(settingsSource, /props\.repairDocumentRuntime\?\.\(\)/);
  assert.match(settingsSource, /props\.checkForUpdates\(\)/);
});
