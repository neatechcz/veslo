import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");

test("settings keeps the diagnostic capture card visible for unavailable and active states", () => {
  assert.match(source, /const \[userCaptureLoadError, setUserCaptureLoadError\] = createSignal/);
  assert.match(source, /const \[userCaptureStatusBusy, setUserCaptureStatusBusy\] = createSignal/);
  assert.match(source, /status skipped: renderer is not running in Tauri/);
  assert.match(source, /console\.warn\("\[user-diagnostic-capture\] status unavailable", error\)/);
  assert.match(source, /recordBootstrapDiagnostic\("user-diagnostic-capture:status-unavailable", \{ message \}\)/);
  assert.match(source, /data-user-diagnostic-capture-unavailable/);
  assert.match(source, /const userCaptureUnavailableReason = \(\) =>/);
  assert.match(source, /const stopUserCapture = async \(\) =>/);
  assert.match(source, /stopUserDiagnosticCapture\(\)/);
  assert.match(source, /data-user-diagnostic-capture-stop/);
  assert.match(source, /Stop capture/);
  assert.match(source, /This Veslo release does not include diagnostic capture\./);
  assert.match(source, /Sign in to Veslo and wait for the account connection to finish/);
  assert.match(source, /<Show when=\{userCaptureUnavailableReason\(\)\}>/);
  assert.doesNotMatch(source, /<Show when=\{userCapture\(\)\?\.available && userCapture\(\)\?\.canStart\}>/);
  assert.match(source, /<div data-user-diagnostic-capture class=/);
  assert.match(source, /!userCapture\(\)\?\.available/);
  assert.match(source, /!userCapture\(\)\?\.canStart/);
  assert.match(source, /if \(capture\.captureId \|\| capture\.state === "active"\) return null;/);
  assert.match(source, /Retrying\.\.\./);
  assert.match(source, /refreshUserCapture\(\{ force: true \}\)/);
});

test("settings places the diagnostic capture card in general settings", () => {
  const generalStart = source.indexOf('<Match when={activeTab() === "general"}>');
  const advancedStart = source.indexOf('<Match when={activeTab() === "advanced"}>');
  const captureStart = source.indexOf("<div data-user-diagnostic-capture class=");

  assert.ok(generalStart >= 0);
  assert.ok(advancedStart > generalStart);
  assert.ok(captureStart > generalStart);
  assert.ok(captureStart < advancedStart);
});
