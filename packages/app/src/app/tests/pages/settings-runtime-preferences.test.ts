import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const tauriSource = readFileSync(new URL("../../lib/tauri.ts", import.meta.url), "utf8");

test("settings exposes one positive Sandbox toggle for the desktop runtime", () => {
  assert.match(settingsSource, /desktopRuntimePreferencesRead/);
  assert.match(settingsSource, /desktopRuntimePreferencesWrite/);
  assert.match(settingsSource, /const \[sharedUnsandboxedEngine, setSharedUnsandboxedEngine\]/);
  assert.match(settingsSource, /const sandboxEnabled = createMemo\(\(\) => !sharedUnsandboxedEngine\(\)\)/);
  assert.match(settingsSource, /const handleToggleSandbox = async \(\) =>/);
  assert.match(settingsSource, /const nextSandboxEnabled = !sandboxEnabled\(\);/);
  assert.match(settingsSource, /sharedUnsandboxedEngine: !nextSandboxEnabled/);
  assert.match(settingsSource, />Sandbox</);
  assert.match(
    settingsSource,
    /A sandbox gives the AI a safe place to work\. It can use the files in a folder, but it is kept separate from the rest of your computer\./,
  );
  assert.doesNotMatch(settingsSource, />Local runtime</);
  assert.doesNotMatch(settingsSource, />Shared unsandboxed engine</);
  assert.doesNotMatch(settingsSource, /VESLO_DISABLE_SANDBOX/);
  assert.doesNotMatch(settingsSource, /VESLO_SHARED_OPENCODE_ENGINE/);
  assert.match(settingsSource, /role="switch"[\s\S]*aria-checked=\{sandboxEnabled\(\)\}/);
  assert.match(settingsSource, /aria-label="Toggle Sandbox"/);
  assert.match(settingsSource, /onClick=\{\(\) => void handleToggleSandbox\(\)\}/);
  assert.doesNotMatch(settingsSource, /toggleDisableSandbox/);
  assert.doesNotMatch(settingsSource, /toggleSharedOpenCodeEngine/);
});

test("tauri wrapper exposes desktop runtime preferences commands", () => {
  assert.match(tauriSource, /export type DesktopRuntimePreferences = \{[\s\S]*sharedUnsandboxedEngine: boolean;/);
  assert.match(tauriSource, /invoke<DesktopRuntimePreferences>\("desktop_runtime_preferences_read"\)/);
  assert.match(tauriSource, /invoke<DesktopRuntimePreferences>\("desktop_runtime_preferences_write", \{ preferences \}\)/);
});
