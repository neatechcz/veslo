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

test("Windows MSI uses Czech WiX localization", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const language = config?.bundle?.windows?.wix?.language;
  const localePath = "windows/locales/cs-CZ.wxl";
  const localeFilePath = resolve(srcTauriDir, localePath);

  assert.deepEqual(
    language,
    {
      "cs-CZ": {
        localePath,
      },
    },
    "Windows MSI should build the Czech installer instead of the default en-US package",
  );
  assert.ok(existsSync(localeFilePath), "Expected the Czech WiX locale file to exist");

  const locale = readFileSync(localeFilePath, "utf8");
  assert.match(locale, /Culture="cs-CZ"/);
  assert.match(locale, /<String Id="TauriLanguage">1029<\/String>/);
  assert.match(locale, /<String Id="TauriCodepage">1250<\/String>/);
  assert.match(locale, /Spustit Veslo by Neatech/);
  assert.match(locale, /Je již nainstalována novější verze aplikace Veslo by Neatech\./);
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
    resources["windows/wsl2-client-installer.ps1"],
    "wsl2-client-installer.ps1",
    "Windows installers must bundle the client runtime installer that can run prerequisite and sandbox setup from the installer flow",
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
  const clientInstallerPath = resolve(srcTauriDir, "windows/wsl2-client-installer.ps1");
  const wrapperPath = resolve(srcTauriDir, "windows/wsl2-sandbox-installer.ps1");
  const nsisHookPath = resolve(srcTauriDir, "windows/nsis-hooks.nsh");
  const provisionerPath = resolve(__dirname, "../../orchestrator/scripts/windows-wsl2-sandbox-provision.ps1");
  assert.ok(existsSync(fragmentPath), "Expected the WSL provisioning WiX fragment to exist");
  assert.ok(existsSync(prerequisitePath), "Expected the WSL prerequisite installer helper to exist");
  assert.ok(existsSync(clientInstallerPath), "Expected the client runtime installer helper to exist");
  assert.ok(existsSync(wrapperPath), "Expected the WSL provisioning installer wrapper to exist");
  assert.ok(existsSync(nsisHookPath), "Expected the NSIS installer hook to exist");
  assert.ok(existsSync(provisionerPath), "Expected the WSL provisioning helper to exist");

  const fragment = readFileSync(fragmentPath, "utf8");
  assert.match(fragment, /ComponentGroup\s+Id="VesloWslProvisioningInstallerComponents"/);
  assert.match(fragment, /CustomAction\s+[^>]*Id="VesloProvisionWslSandbox"/s);
  assert.match(fragment, /After="InstallFiles"/);
  assert.match(fragment, /Return="ignore"/);
  assert.match(
    fragment,
    /\[System64Folder\]WindowsPowerShell\\v1\.0\\powershell\.exe/,
    "MSI custom action must use 64-bit PowerShell so wsl.exe is visible on 64-bit Windows",
  );
  assert.doesNotMatch(
    fragment,
    /\[SystemFolder\]WindowsPowerShell\\v1\.0\\powershell\.exe/,
    "MSI custom action must not use SystemFolder because it can resolve to SysWOW64 and hide wsl.exe",
  );
  assert.match(fragment, /-NoProfile\s+-NonInteractive\s+-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass/);
  assert.match(
    fragment,
    /\[INSTALLDIR\]wsl2-client-installer\.ps1/,
    "MSI custom action should run the client runtime installer so missing WSL prerequisites are handled from the installer flow",
  );
  assert.doesNotMatch(
    fragment,
    /\[INSTALLDIR\]resources\\wsl2-sandbox-installer\.ps1/,
    "Tauri MSI installs script resources into INSTALLDIR on Windows, so the custom action must not point at a resources subdirectory",
  );
  const prerequisite = readFileSync(prerequisitePath, "utf8");
  assert.match(prerequisite, /wsl\.exe"\s+@\("--install",\s+"--no-distribution"\)/);
  assert.match(prerequisite, /Microsoft-Windows-Subsystem-Linux/);
  assert.match(prerequisite, /VirtualMachinePlatform/);
  assert.match(
    prerequisite,
    /New-Object\s+System\.Diagnostics\.ProcessStartInfo[\s\S]*?\$startInfo\.UseShellExecute\s*=\s*\$false[\s\S]*?\$startInfo\.CreateNoWindow\s*=\s*\$true/,
    "WSL prerequisite helper should run native wsl.exe/dism.exe children through hidden ProcessStartInfo",
  );
  assert.doesNotMatch(
    prerequisite,
    /&\s+\$FilePath\b/,
    "WSL prerequisite helper should not invoke native child commands through PowerShell's call operator",
  );
  const clientInstaller = readFileSync(clientInstallerPath, "utf8");
  assert.match(clientInstaller, /wsl2-prerequisite-installer\.ps1/);
  assert.match(clientInstaller, /wsl2-sandbox-installer\.ps1/);
  assert.match(clientInstaller, /function\s+Resolve-WslExecutable\b/);
  assert.match(clientInstaller, /function\s+Resolve-PowerShellExecutable\b/);
  assert.match(clientInstaller, /Sysnative/);
  assert.match(clientInstaller, /System32/);
  assert.match(clientInstaller, /Invoke-ElevatedPowerShellScript\s+\$prerequisiteScript\s+@\("-Install"\)/);
  assert.match(clientInstaller, /-Verb\s+RunAs/);
  assert.match(clientInstaller, /RunOnce/);
  assert.match(
    clientInstaller,
    /\$arguments\s*=\s*@\([\s\S]*?"-NoProfile",[\s\S]*?"-NonInteractive",[\s\S]*?"-WindowStyle",[\s\S]*?"Hidden",[\s\S]*?"-ExecutionPolicy"/,
    "client runtime installer should run nested PowerShell commands hidden and non-interactive",
  );
  assert.match(
    clientInstaller,
    /New-Object\s+System\.Diagnostics\.ProcessStartInfo[\s\S]*?\$startInfo\.UseShellExecute\s*=\s*\$false[\s\S]*?\$startInfo\.CreateNoWindow\s*=\s*\$true/,
    "client runtime installer should run native child commands through hidden ProcessStartInfo",
  );
  assert.doesNotMatch(
    clientInstaller,
    /&\s+(?:wsl|powershell)\.exe\b/i,
    "client runtime installer should not invoke WSL or nested PowerShell children through PowerShell's call operator",
  );
  const wrapper = readFileSync(wrapperPath, "utf8");
  assert.match(wrapper, /package\.json/);
  assert.match(wrapper, /function\s+Resolve-WslExecutable\b/);
  assert.match(wrapper, /function\s+Resolve-PowerShellExecutable\b/);
  assert.match(wrapper, /Sysnative/);
  assert.match(wrapper, /System32/);
  assert.match(wrapper, /Invoke-HiddenNativeCommand\s+\$wslCommand\s+@\("--status"\)/);
  assert.match(wrapper, /Invoke-HiddenNativeCommand\s+\$powershellCommand\s+@\(\$baseArgs\s+\+\s+@\("-CheckOnly"\)\)/);
  assert.match(
    wrapper,
    /\$baseArgs\s*=\s*@\([\s\S]*?"-NoProfile",[\s\S]*?"-NonInteractive",[\s\S]*?"-WindowStyle",[\s\S]*?"Hidden",[\s\S]*?"-ExecutionPolicy"/,
    "installer wrapper should run nested PowerShell provisioning commands hidden and non-interactive",
  );
  assert.match(
    wrapper,
    /New-Object\s+System\.Diagnostics\.ProcessStartInfo[\s\S]*?\$startInfo\.UseShellExecute\s*=\s*\$false[\s\S]*?\$startInfo\.CreateNoWindow\s*=\s*\$true/,
    "installer wrapper should run native wsl.exe/powershell.exe children through hidden ProcessStartInfo",
  );
  assert.doesNotMatch(
    wrapper,
    /&\s+(?:wsl|powershell)\.exe\b/i,
    "installer wrapper should not invoke WSL or nested PowerShell children through PowerShell's call operator",
  );

  const provisioner = readFileSync(provisionerPath, "utf8");
  assert.match(
    provisioner,
    /New-Object\s+System\.Diagnostics\.ProcessStartInfo[\s\S]*?\$startInfo\.UseShellExecute\s*=\s*\$false[\s\S]*?\$startInfo\.CreateNoWindow\s*=\s*\$true/,
    "WSL provisioner should run every wsl.exe command through hidden ProcessStartInfo",
  );
  assert.match(
    provisioner,
    /Invoke-HiddenNativeCommand\s+"wsl\.exe"\s+\$WslArgs/,
    "WSL provisioner should route Invoke-Wsl through the hidden native command helper",
  );
  assert.doesNotMatch(
    provisioner,
    /&\s+wsl\.exe\b/i,
    "WSL provisioner should not invoke wsl.exe through PowerShell's call operator",
  );
});

test("Windows NSIS builds a current-user client installer with runtime setup hook", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const nsis = config?.bundle?.windows?.nsis ?? {};
  const hookPath = resolve(srcTauriDir, "windows/nsis-hooks.nsh");

  assert.equal(
    nsis.installMode,
    "currentUser",
    "Client NSIS installer should avoid a per-machine Program Files install so users are not forced into UAC just to install Veslo",
  );
  assert.deepEqual(
    nsis.languages,
    ["Czech", "English"],
    "Client NSIS installer should offer Czech first with English as fallback",
  );
  assert.deepEqual(
    nsis.customLanguageFiles,
    {
      Czech: "windows/locales/Czech.nsh",
    },
    "Client NSIS installer should provide Czech translations for Tauri-specific installer messages",
  );
  assert.equal(
    nsis.installerHooks,
    "windows/nsis-hooks.nsh",
    "Client NSIS installer should run the post-install runtime setup hook",
  );
  assert.ok(existsSync(hookPath), "Expected the NSIS installer hook file to exist");
  const czechLanguagePath = resolve(srcTauriDir, "windows/locales/Czech.nsh");
  assert.ok(existsSync(czechLanguagePath), "Expected the NSIS Czech language file to exist");

  const hook = readFileSync(hookPath, "utf8");
  assert.match(hook, /NSIS_HOOK_POSTINSTALL/);
  assert.match(
    hook,
    /nsExec::ExecToLog/,
    "NSIS hook should run PowerShell through nsExec so no console window is shown during install",
  );
  assert.doesNotMatch(
    hook,
    /\bExecWait\b/,
    "NSIS hook must not launch powershell.exe directly through ExecWait because that can flash a console window",
  );
  assert.match(hook, /wsl2-client-installer\.ps1/);
  assert.match(hook, /-NoProfile\s+-NonInteractive\s+-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass/);
  assert.doesNotMatch(
    hook,
    /-Verb\s+RunAs/,
    "NSIS hook should delegate elevation decisions to the client runtime installer instead of forcing installer-wide elevation",
  );

  const czechLanguage = readFileSync(czechLanguagePath, "utf8");
  assert.match(czechLanguage, /LangString\s+alreadyInstalled\s+\$\{LANG_CZECH\}/);
  assert.match(czechLanguage, /LangString\s+webview2InstallSuccess\s+\$\{LANG_CZECH\}/);
  assert.match(czechLanguage, /LangString\s+deleteAppData\s+\$\{LANG_CZECH\}/);
});

test("Windows runtime process launches stay hidden", () => {
  const supervisedProcess = readFileSync(resolve(srcTauriDir, "src/supervised_process.rs"), "utf8");
  const windowsPlatform = readFileSync(resolve(srcTauriDir, "src/platform/windows.rs"), "utf8");
  const wslSandboxCommand = readFileSync(resolve(srcTauriDir, "src/commands/wsl_sandbox.rs"), "utf8");
  const vesloServer = readFileSync(resolve(srcTauriDir, "src/veslo_server/mod.rs"), "utf8");

  assert.match(supervisedProcess, /const\s+CREATE_NO_WINDOW:\s*u32\s*=\s*0x0800_0000/);
  assert.match(supervisedProcess, /command\.creation_flags\(CREATE_NO_WINDOW\)/);
  assert.match(
    supervisedProcess,
    /pub fn spawn\(self\)[\s\S]*?spawn_hidden_command/,
    "Windows supervised sidecars should route through the hidden native spawn wrapper",
  );
  assert.match(windowsPlatform, /const\s+CREATE_NO_WINDOW:\s*u32\s*=\s*0x08000000/);
  assert.match(windowsPlatform, /pub fn configure_hidden[\s\S]*?command\.creation_flags\(CREATE_NO_WINDOW\)/);
  assert.match(wslSandboxCommand, /Command::new\("powershell\.exe"\)[\s\S]*?configure_hidden\(&mut command\)/);
  assert.match(wslSandboxCommand, /Start-Process[\s\S]*?-WindowStyle Hidden[\s\S]*?-Verb RunAs/);
  assert.match(vesloServer, /Command::new\("powershell"\)[\s\S]*?configure_hidden\(&mut command\)/);
  assert.match(vesloServer, /Command::new\("wsl\.exe"\)[\s\S]*?configure_hidden\(&mut command\)/);
});
