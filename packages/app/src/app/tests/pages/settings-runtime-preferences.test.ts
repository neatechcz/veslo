import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const tauriSource = readFileSync(new URL("../../lib/tauri.ts", import.meta.url), "utf8");

test("settings exposes one user toggle for shared unsandboxed engine runtime", () => {
  assert.match(settingsSource, /desktopRuntimePreferencesRead/);
  assert.match(settingsSource, /desktopRuntimePreferencesWrite/);
  assert.match(settingsSource, /const \[sharedUnsandboxedEngine, setSharedUnsandboxedEngine\]/);
  assert.match(settingsSource, /const handleToggleSharedUnsandboxedEngine = async \(\) =>/);
  assert.match(settingsSource, /sharedUnsandboxedEngine: next/);
  assert.match(settingsSource, />Local runtime</);
  assert.match(settingsSource, />Shared unsandboxed engine</);
  assert.match(settingsSource, /VESLO_DISABLE_SANDBOX/);
  assert.match(settingsSource, /VESLO_SHARED_OPENCODE_ENGINE/);
  assert.match(settingsSource, /role="switch"[\s\S]*aria-checked=\{sharedUnsandboxedEngine\(\)\}/);
  assert.match(settingsSource, /onClick=\{\(\) => void handleToggleSharedUnsandboxedEngine\(\)\}/);
  assert.doesNotMatch(settingsSource, /toggleDisableSandbox/);
  assert.doesNotMatch(settingsSource, /toggleSharedOpenCodeEngine/);
});

test("tauri wrapper exposes desktop runtime preferences commands", () => {
  assert.match(tauriSource, /export type DesktopRuntimePreferences = \{[\s\S]*sharedUnsandboxedEngine: boolean;/);
  assert.match(tauriSource, /invoke<DesktopRuntimePreferences>\("desktop_runtime_preferences_read"\)/);
  assert.match(tauriSource, /invoke<DesktopRuntimePreferences>\("desktop_runtime_preferences_write", \{ preferences \}\)/);
});
