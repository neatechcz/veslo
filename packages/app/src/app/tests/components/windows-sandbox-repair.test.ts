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

test("Windows sandbox repair WSL path is available while sandbox is the default", () => {
  assert.match(componentSource, /const WINDOWS_WSL_SANDBOX_REPAIR_ENABLED = true;/);
  assert.doesNotMatch(componentSource, /shared non-sandbox runtime by default/);
  assert.match(
    componentSource,
    /if \(!WINDOWS_WSL_SANDBOX_REPAIR_ENABLED\) return;[\s\S]*const prereq = await wslPrerequisitesRepair\(\{ checkOnly: true \}\);/,
    "manual WSL prerequisite repair should stay in the source but remain dormant",
  );
  assert.match(
    componentSource,
    /if \(!WINDOWS_WSL_SANDBOX_REPAIR_ENABLED\) return;[\s\S]*const sandboxCheck = await wslSandboxRepair\(\{ checkOnly: true \}\);/,
    "automatic WSL sandbox provisioning should stay in the source but remain dormant",
  );
  assert.match(
    componentSource,
    /isTauriRuntime\(\) && isWindowsPlatform\(\) && WINDOWS_WSL_SANDBOX_REPAIR_ENABLED/,
    "the WSL repair prompt should render from the installed Windows app when sandbox setup is available",
  );

  const prerequisiteIndex = componentSource.indexOf("wslPrerequisitesRepair({ checkOnly: true })");
  const sandboxIndex = componentSource.indexOf("wslSandboxRepair({ checkOnly: false })");

  assert.ok(prerequisiteIndex > 0, "Expected the dormant WSL prerequisite check to remain in source");
  assert.ok(sandboxIndex > prerequisiteIndex, "Expected dormant VesloSandbox provisioning to remain after WSL repair");
  assert.match(componentSource, /settings\.windows_sandbox_restart_required/);
});

test("Windows sandbox repair only treats explicit restart-required install results as restart-required", () => {
  assert.match(componentSource, /result\.status === 3010/);
  assert.match(componentSource, /result\.status === 1641/);
  assert.doesNotMatch(componentSource, /\\brestart\\b\|\\breboot\\b/);
});

test("Windows sandbox repair is available from onboarding and settings", () => {
  assert.match(settingsSource, /<WindowsSandboxRepair \/>/);
  assert.match(onboardingSource, /<WindowsSandboxRepair\s*\/>/);
  assert.doesNotMatch(onboardingSource, /<WindowsSandboxRepair\s+blocking\s*\/>/);
});

test("Windows sandbox gate remains available but onboarding repair is non-blocking", () => {
  assert.match(componentSource, /blocking\?:\s*boolean/);
  assert.match(componentSource, /fixed inset-0/);
  assert.match(componentSource, /settings\.windows_sandbox_continue_anyway/);
});

test("Tauri API exposes both WSL repair phases", () => {
  assert.match(tauriSource, /wsl_prerequisites_repair/);
  assert.match(tauriSource, /wsl_sandbox_repair/);
});
