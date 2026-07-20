import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");

test("settings surfaces a failed native diagnostic capture status instead of hiding the feature", () => {
  assert.match(source, /const \[userCaptureLoadError, setUserCaptureLoadError\] = createSignal/);
  assert.match(source, /const \[userCaptureStatusBusy, setUserCaptureStatusBusy\] = createSignal/);
  assert.match(source, /status skipped: renderer is not running in Tauri/);
  assert.match(source, /console\.warn\("\[user-diagnostic-capture\] status unavailable", error\)/);
  assert.match(source, /recordBootstrapDiagnostic\("user-diagnostic-capture:status-unavailable", \{ message \}\)/);
  assert.match(source, /data-user-diagnostic-capture-unavailable/);
  assert.match(source, /userCapture\(\)\?\.available && userCapture\(\)\?\.canStart/);
  assert.match(source, /Retrying\.\.\./);
  assert.match(source, /refreshUserCapture\(\{ force: true \}\)/);
});
