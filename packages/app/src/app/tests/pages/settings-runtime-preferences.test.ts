import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const tauriSource = readFileSync(new URL("../../lib/tauri.ts", import.meta.url), "utf8");

test("settings hides the user-facing Sandbox mode toggle", () => {
  assert.doesNotMatch(settingsSource, /const \[sharedUnsandboxedEngine, setSharedUnsandboxedEngine\]/);
  assert.doesNotMatch(settingsSource, /const sandboxEnabled = createMemo/);
  assert.doesNotMatch(settingsSource, /const handleToggleSandbox = async/);
  assert.doesNotMatch(settingsSource, /aria-label="Toggle Sandbox"/);
  assert.doesNotMatch(settingsSource, /A sandbox gives the AI a safe place to work\./);
  assert.doesNotMatch(settingsSource, />Local runtime</);
  assert.doesNotMatch(settingsSource, />Shared unsandboxed engine</);
  assert.doesNotMatch(settingsSource, /VESLO_DISABLE_SANDBOX/);
  assert.doesNotMatch(settingsSource, /VESLO_SHARED_OPENCODE_ENGINE/);
  assert.doesNotMatch(settingsSource, /toggleDisableSandbox/);
  assert.doesNotMatch(settingsSource, /toggleSharedOpenCodeEngine/);
});

test("settings exposes a persisted support diagnostics switch for desktop troubleshooting", () => {
  assert.match(settingsSource, /desktopRuntimePreferencesRead/);
  assert.match(settingsSource, /desktopRuntimePreferencesWrite/);
  assert.match(settingsSource, /supportDiagnostics/);
  assert.match(settingsSource, /aria-label="Toggle support diagnostics"/);
  assert.match(settingsSource, /Restart Veslo before reproducing the issue/);
});

test("tauri wrapper exposes desktop runtime preferences commands", () => {
  assert.match(tauriSource, /export type DesktopRuntimePreferences = \{[\s\S]*sharedUnsandboxedEngine: boolean;[\s\S]*supportDiagnostics: boolean;/);
  assert.match(tauriSource, /invoke<DesktopRuntimePreferences>\("desktop_runtime_preferences_read"\)/);
  assert.match(tauriSource, /invoke<DesktopRuntimePreferences>\("desktop_runtime_preferences_write", \{ preferences \}\)/);
});
