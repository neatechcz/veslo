import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync(
  new URL("../../components/windows-sandbox-repair.tsx", import.meta.url),
  "utf8",
);
const settingsSource = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const onboardingSource = readFileSync(new URL("../../pages/onboarding.tsx", import.meta.url), "utf8");
const tauriSource = readFileSync(new URL("../../lib/tauri.ts", import.meta.url), "utf8");

test("Windows sandbox repair is gated to Tauri on Windows", () => {
  assert.match(componentSource, /isTauriRuntime\(\)\s*&&\s*isWindowsPlatform\(\)/);
});

test("Windows sandbox repair runs WSL prerequisites before sandbox provisioning", () => {
  const prerequisiteIndex = componentSource.indexOf("wslPrerequisitesRepair({ checkOnly: true })");
  const sandboxIndex = componentSource.indexOf("wslSandboxRepair({ checkOnly: false })");

  assert.ok(prerequisiteIndex > 0, "Expected a phase-1 WSL prerequisite check");
  assert.ok(sandboxIndex > prerequisiteIndex, "Expected VesloSandbox provisioning to run after WSL prerequisite repair");
  assert.match(componentSource, /settings\.windows_sandbox_restart_required/);
});

test("Windows sandbox repair only treats explicit restart-required install results as restart-required", () => {
  assert.match(componentSource, /result\.status === 3010/);
  assert.match(componentSource, /result\.status === 1641/);
  assert.doesNotMatch(componentSource, /\\brestart\\b\|\\breboot\\b/);
});

test("Windows sandbox repair is available from onboarding and settings", () => {
  assert.match(settingsSource, /<WindowsSandboxRepair \/>/);
  // Onboarding renders the gating variant so the user cannot proceed until the
  // sandbox is ready; settings keeps the inline card for manual repair.
  assert.match(onboardingSource, /<WindowsSandboxRepair\s+blocking\s*\/>/);
});

test("Windows sandbox gate blocks onboarding until ready and offers an escape", () => {
  assert.match(componentSource, /blocking\?:\s*boolean/);
  assert.match(componentSource, /fixed inset-0/);
  assert.match(componentSource, /settings\.windows_sandbox_continue_anyway/);
});

test("Tauri API exposes both WSL repair phases", () => {
  assert.match(tauriSource, /wsl_prerequisites_repair/);
  assert.match(tauriSource, /wsl_sandbox_repair/);
});
