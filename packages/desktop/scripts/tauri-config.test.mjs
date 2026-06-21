import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { APP_WINDOW_MIN_WIDTH } from "./window-size-contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const tauriConfigPath = resolve(__dirname, "../src-tauri/tauri.conf.json");
const srcTauriDir = resolve(__dirname, "../src-tauri");

test("desktop window keeps Tauri native drag-drop disabled for HTML5 file drop", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const windows = Array.isArray(config?.app?.windows) ? config.app.windows : [];
  assert.ok(windows.length > 0, "Expected at least one desktop window config");

  for (const windowConfig of windows) {
    assert.equal(
      windowConfig?.dragDropEnabled,
      false,
      "Window must set dragDropEnabled=false so Finder file drops reach frontend onDrop handlers",
    );
  }
});

test("desktop window keeps a 390px minimum width for phone-standard layouts", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const windows = Array.isArray(config?.app?.windows) ? config.app.windows : [];
  assert.ok(windows.length > 0, "Expected at least one desktop window config");

  for (const windowConfig of windows) {
    assert.equal(
      windowConfig?.minWidth,
      APP_WINDOW_MIN_WIDTH,
      "Window must keep the documented minimum width so the desktop shell cannot shrink below the phone-standard layout contract",
    );
  }
});

test("Windows updater MSI installs write a verbose diagnostic log", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const installerArgs = config?.plugins?.updater?.windows?.installerArgs;

  assert.deepEqual(
    installerArgs,
    ["/l*v", "C:\\ProgramData\\veslo-updater-msi.log"],
    "Windows updater should pass verbose MSI logging args so failed in-app updates leave diagnostics",
  );
});

test("Windows MSI bundles and schedules managed WSL sandbox provisioning", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const resources = config?.bundle?.resources ?? {};
  const wix = config?.bundle?.windows?.wix ?? {};

  assert.equal(
    resources["../package.json"],
    "package.json",
    "MSI must bundle the desktop package manifest so the installer wrapper passes the pinned OpenCode version",
  );
  assert.equal(
    resources["../../orchestrator/scripts/windows-wsl2-sandbox-provision.ps1"],
    "windows-wsl2-sandbox-provision.ps1",
    "MSI must bundle the managed WSL provisioning helper into the app resources directory",
  );
  assert.equal(
    resources["windows/wsl2-prerequisite-installer.ps1"],
    "wsl2-prerequisite-installer.ps1",
    "MSI must bundle the phase-1 WSL prerequisite helper for first-run repair",
  );
  assert.equal(
    resources["windows/wsl2-sandbox-installer.ps1"],
    "wsl2-sandbox-installer.ps1",
    "MSI must bundle the installer wrapper that calls the provisioning helper",
  );
  assert.ok(
    wix.fragmentPaths?.includes("windows/wsl2-sandbox-installer.wxs"),
    "MSI must include the WiX fragment that schedules WSL distro provisioning",
  );
  assert.ok(
    wix.componentGroupRefs?.includes("VesloWslProvisioningInstallerComponents"),
    "MSI must reference the WSL provisioning fragment so WiX links the custom action into the final package",
  );

  const fragmentPath = resolve(srcTauriDir, "windows/wsl2-sandbox-installer.wxs");
  const prerequisitePath = resolve(srcTauriDir, "windows/wsl2-prerequisite-installer.ps1");
  const wrapperPath = resolve(srcTauriDir, "windows/wsl2-sandbox-installer.ps1");
  assert.ok(existsSync(fragmentPath), "Expected the WSL provisioning WiX fragment to exist");
  assert.ok(existsSync(prerequisitePath), "Expected the WSL prerequisite installer helper to exist");
  assert.ok(existsSync(wrapperPath), "Expected the WSL provisioning installer wrapper to exist");

  const fragment = readFileSync(fragmentPath, "utf8");
  assert.match(fragment, /ComponentGroup\s+Id="VesloWslProvisioningInstallerComponents"/);
  assert.match(fragment, /CustomAction\s+[^>]*Id="VesloProvisionWslSandbox"/s);
  assert.match(fragment, /After="InstallFiles"/);
  assert.match(fragment, /Return="ignore"/);
  assert.match(fragment, /wsl2-sandbox-installer\.ps1/);
  const prerequisite = readFileSync(prerequisitePath, "utf8");
  assert.match(prerequisite, /wsl\.exe"\s+@\("--install",\s+"--no-distribution"\)/);
  assert.match(prerequisite, /Microsoft-Windows-Subsystem-Linux/);
  assert.match(prerequisite, /VirtualMachinePlatform/);
  assert.match(readFileSync(wrapperPath, "utf8"), /package\.json/);
});
