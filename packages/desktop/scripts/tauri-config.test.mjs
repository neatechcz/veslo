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
const runtimePreferencesPath = resolve(srcTauriDir, "src/runtime_preferences.rs");

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

test("desktop runtime preferences default to shared non-sandbox engine on supported desktop platforms", () => {
  const source = readFileSync(runtimePreferencesPath, "utf8");

  assert.match(
    source,
    /fn default_shared_unsandboxed_engine_enabled\(\) -> bool \{\s*cfg!\(any\(windows,\s*target_os = "macos"\)\)\s*\}/,
    "Missing desktop runtime preferences should enable the shared non-sandbox engine on supported desktop platforms",
  );
  assert.doesNotMatch(
    source,
    /fn default_shared_unsandboxed_engine_enabled\(\) -> bool \{\s*false\s*\}/,
    "Desktop runtime preferences must not silently fall back to sandbox-on defaults after the shared engine migration",
  );
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

test("Windows MSI does not run a nested WebView2 installer custom action", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const webviewInstallMode = config?.bundle?.windows?.webviewInstallMode;

  assert.deepEqual(
    webviewInstallMode,
    {
      type: "skip",
    },
    "Windows validation MSI must not run a generated WebView2 installer custom action; nested WebView2 installers can turn runtime install/restart return codes into a generic MSI failure after Veslo's WSL setup has already succeeded",
  );
});

test("default desktop capability does not expose tauri-pilot", () => {
  const defaultCapability = JSON.parse(readFileSync(resolve(srcTauriDir, "capabilities/default.json"), "utf8"));
  const generatedCapabilities = JSON.parse(readFileSync(resolve(srcTauriDir, "gen/schemas/capabilities.json"), "utf8"));
  const e2eConfig = JSON.parse(readFileSync(resolve(srcTauriDir, "tauri.e2e.conf.json"), "utf8"));
  const defaultPermissions = defaultCapability?.permissions ?? [];
  const generatedDefaultPermissions = generatedCapabilities?.["veslo-default"]?.permissions ?? [];
  const e2eCapabilities = e2eConfig?.app?.security?.capabilities ?? [];

  assert.ok(!defaultPermissions.includes("pilot:default"), "pilot permission must stay out of the release/default capability");
  assert.ok(
    !generatedDefaultPermissions.includes("pilot:default"),
    "generated capability snapshot must not reintroduce pilot into the release/default capability",
  );
  assert.ok(
    JSON.stringify(e2eCapabilities).includes("pilot:default"),
    "E2E config should be the place that enables tauri-pilot automation",
  );
});

test("desktop sandbox environment command mirrors the server backend resolver", () => {
  const lib = readFileSync(resolve(srcTauriDir, "src/lib.rs"), "utf8");
  const misc = readFileSync(resolve(srcTauriDir, "src/commands/misc.rs"), "utf8");
  const spawn = readFileSync(resolve(srcTauriDir, "src/veslo_server/spawn.rs"), "utf8");

  assert.match(spawn, /pub fn resolve_server_sandbox_backend\(\) -> String/);
  assert.match(misc, /pub fn desktop_sandbox_environment\(\) -> DesktopSandboxEnvironment/);
  assert.match(misc, /crate::veslo_server::spawn::resolve_server_sandbox_backend\(\)/);
  assert.match(lib, /desktop_sandbox_environment/);
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

test("Windows MSI keeps managed WSL sandbox provisioning opt-in during installer setup", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const resources = config?.bundle?.resources ?? {};
  const wix = config?.bundle?.windows?.wix ?? {};

  assert.equal(
    resources["../package.json"],
    "package.json",
    "MSI must bundle the desktop package manifest so the installer wrapper passes the pinned OpenCode version",
  );
  assert.equal(
    resources["sidecars/chrome-devtools-mcp-package"],
    "chrome-devtools-mcp-package",
    "MSI must bundle the vendored Chrome DevTools MCP runtime package beside the sidecar executable",
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
    "Windows installers keep the client runtime installer bundled for explicit WSL rollback builds",
  );
  assert.equal(
    resources["windows/wsl2-sandbox-installer.ps1"],
    "wsl2-sandbox-installer.ps1",
    "MSI keeps the installer wrapper bundled for explicit WSL rollback builds",
  );
  assert.ok(
    wix.fragmentPaths?.includes("windows/wsl2-sandbox-installer.wxs"),
    "MSI keeps the WiX fragment available while WSL provisioning is disabled by default",
  );
  assert.ok(
    wix.componentGroupRefs?.includes("VesloWslProvisioningInstallerComponents"),
    "MSI keeps the WSL provisioning component group linked for explicit rollback builds",
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
  assert.match(
    fragment,
    /<Property\s+Id="MsiLogging"\s+Value="voicewarmupx!"\s*\/>/,
    "Double-clicked MSI installs must create a verbose Windows Installer MSI*.LOG for early bootstrap failures",
  );
  assert.match(
    fragment,
    /Property\s+Id="VESLO_ENABLE_WSL_INSTALLER"\s+Value="0"/,
    "WSL installer provisioning must stay behind the explicit installer rollback flag",
  );
  assert.match(fragment, /RemoveOldVesloWslClientInstaller/);
  assert.match(fragment, /RemoveOldVesloWslPrerequisiteInstaller/);
  assert.match(fragment, /RemoveOldVesloWslSandboxInstaller/);
  assert.match(fragment, /RemoveOldVesloWslSandboxProvisioner/);
  assert.match(fragment, /Name="wsl2-client-installer\.ps1"\s+On="install"/);
  assert.match(fragment, /ComponentGroup\s+Id="VesloWslProvisioningInstallerComponents"/);
  assert.match(fragment, /CustomAction\s+[^>]*Id="VesloProvisionWslSandbox"/s);
  assert.match(fragment, /After="InstallFiles"/);
  assert.match(
    fragment,
    /Custom Action="VesloProvisionWslSandbox"\s+After="InstallFiles"><!\[CDATA\[VESLO_ENABLE_WSL_INSTALLER="1" AND NOT REMOVE~="ALL"\]\]><\/Custom>/,
    "MSI must not run WSL provisioning unless the sandbox installer rollback flag is explicitly enabled",
  );
  assert.match(
    fragment,
    /Id="VesloProvisionWslSandbox"[\s\S]*?Impersonate="no"/,
    "MSI WSL setup must run non-impersonated (LocalSystem) so it can enable Windows WSL features silently without a UAC prompt",
  );
  assert.match(
    fragment,
    /Id="VesloProvisionWslSandbox"[\s\S]*?Return="check"/,
    "MSI WSL setup must use Return=check so a 3010 (reboot-required) exit surfaces the native Windows Installer restart prompt; genuine failures are masked to 0 by the helper itself",
  );
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
    /-AllowRestartContinuationSuccess/,
    "MSI custom action must NOT mask the reboot-required exit; it needs the 3010 to reach Windows Installer so the native restart prompt shows",
  );
  assert.match(
    fragment,
    /-AllowDeferredRuntimeRepairSuccess/,
    "MSI custom action should still mask genuine (non-reboot) failures to exit 0 and defer runtime repair to first-run onboarding",
  );
  assert.match(
    fragment,
    /-MachineSetupOnly/,
    "MSI custom action must run the client installer in machine-setup-only mode so it enables WSL silently and leaves per-user distro import to the Veslo app",
  );
  assert.doesNotMatch(
    fragment,
    /VesloPromptWslRuntimeRestart/,
    "MSI must not force a Windows restart from a popup/shutdown action; restart is surfaced by the app and standard Windows reboot handling",
  );
  assert.doesNotMatch(
    fragment,
    /-PromptForRestartIfRequired/,
    "MSI must not run the client installer in restart-prompt mode; that flow was removed in favor of app-driven restart handling",
  );
  assert.match(
    fragment,
    /Id="VesloDisableExitDialogLaunchCheckbox"[\s\S]*?Property="WIXUI_EXITDIALOGOPTIONALCHECKBOX"[\s\S]*?Value="0"/,
    "MSI should disable Tauri's default launch checkbox because Veslo may still need WSL runtime continuation after install",
  );
  assert.match(
    fragment,
    /Id="VesloClearExitDialogLaunchCheckboxText"[\s\S]*?Property="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT"[\s\S]*?Value=""/,
    "MSI should hide Tauri's default launch checkbox text on the finish dialog",
  );
  assert.match(
    fragment,
    /Custom Action="VesloDisableExitDialogLaunchCheckbox"\s+Before="ExecuteAction"><!\[CDATA\[VESLO_ENABLE_WSL_INSTALLER="1" AND NOT Installed\]\]><\/Custom>/,
    "MSI should only disable the finish-dialog launch checkbox for the dormant WSL installer rollback flow",
  );
  assert.match(
    fragment,
    /Custom Action="VesloDisableAutoLaunchApp"\s+Before="LaunchApplication"><!\[CDATA\[VESLO_ENABLE_WSL_INSTALLER="1" AND AUTOLAUNCHAPP AND NOT Installed\]\]><\/Custom>/,
    "MSI should only clear passive auto-launch for the dormant WSL installer rollback flow",
  );
  assert.doesNotMatch(
    fragment,
    /\[INSTALLDIR\]resources\\wsl2-sandbox-installer\.ps1/,
    "Tauri MSI installs script resources into INSTALLDIR on Windows, so the custom action must not point at a resources subdirectory",
  );
  const prerequisite = readFileSync(prerequisitePath, "utf8");
  assert.match(prerequisite, /\$NativeCommandTimeoutExitCode\s*=\s*1460/);
  assert.match(prerequisite, /features-msix-no-localsystem-wsl-20260624/);
  assert.match(prerequisite, /Script revision:/);
  assert.match(
    prerequisite,
    /SecurityProtocol[\s\S]*?Tls12/,
    "WSL prerequisite helper must force TLS 1.2 so downloads succeed on a fresh Windows where PowerShell 5.1 may default to TLS 1.0",
  );
  assert.match(
    prerequisite,
    /function\s+Install-WslAppPackage\b/,
    "WSL prerequisite helper must stage the WSL app package so a single Windows restart finishes setup instead of needing a second pass",
  );
  assert.match(prerequisite, /Add-AppxProvisionedPackage\s+-Online\s+-PackagePath/);
  assert.match(prerequisite, /function\s+Invoke-IsolatedNativeCommand\b/);
  assert.match(prerequisite, /Start-Job\s+-ScriptBlock/);
  assert.match(prerequisite, /Wait-Job\s+-Job\s+\$job\s+-Timeout\s+\$TimeoutSeconds/);
  assert.match(prerequisite, /function\s+Stop-HiddenNativeProcessTree\b/);
  assert.match(prerequisite, /Native command timed out after/);
  assert.match(prerequisite, /WaitForExit\(\$timeoutMilliseconds\)/);
  assert.match(
    prerequisite,
    /@\(("--status"|'--status')\)\s+-TimeoutSeconds\s+45/,
    "WSL status checks must timeout quickly instead of hanging the installer indefinitely",
  );
  assert.match(prerequisite, /function\s+Resolve-WslExecutable\b/);
  assert.match(prerequisite, /function\s+Resolve-DismExecutable\b/);
  assert.match(prerequisite, /Sysnative/);
  assert.match(prerequisite, /System32/);
  // Silent, LocalSystem-safe machine setup: enable the WSL Windows features and
  // provision the WSL app package, deciding state via DISM/AppX
  // (Get-WindowsOptionalFeature / Get-AppxProvisionedPackage) rather than
  // wsl.exe. The install flow must NOT call wsl.exe (WSL refuses to run as
  // LocalSystem: WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED) and must NOT start a nested
  // Windows Installer (msiexec), which deadlocks against the in-progress Veslo MSI.
  assert.match(prerequisite, /Microsoft-Windows-Subsystem-Linux/);
  assert.match(prerequisite, /VirtualMachinePlatform/);
  assert.match(
    prerequisite,
    /function\s+Test-WslFeaturesEnabled\b/,
    "WSL prerequisite helper must decide install state via DISM feature state, not wsl.exe (LocalSystem-safe)",
  );
  assert.match(prerequisite, /Get-WindowsOptionalFeature/);
  assert.match(prerequisite, /Get-AppxProvisionedPackage/);
  assert.doesNotMatch(
    prerequisite,
    /wsl_update_x64\.msi/,
    "WSL prerequisite helper must not install the kernel MSI inside the Veslo MSI (a nested msiexec deadlocks on the _MSIExecute mutex)",
  );
  assert.doesNotMatch(
    prerequisite,
    /msiexec\.exe/i,
    "WSL prerequisite helper must not start a nested Windows Installer transaction",
  );
  assert.doesNotMatch(
    prerequisite,
    /Invoke-NativeCommand[^\n]*--install/,
    "WSL prerequisite helper must not run interactive wsl --install (it opens a console and self-elevates)",
  );
  assert.doesNotMatch(
    prerequisite,
    /Invoke-NativeCommand[^\n]*--update/,
    "WSL prerequisite helper must not run interactive wsl --update (it opens a console and self-elevates)",
  );
  assert.match(prerequisite, /function\s+Enable-WslFeaturesWithPowerShell\b/);
  assert.match(prerequisite, /function\s+Enable-WslFeaturesWithPowerShellThenDism\b/);
  assert.match(prerequisite, /Enable-WindowsOptionalFeature/);
  assert.match(
    prerequisite,
    /PowerShell optional feature enablement failed[\s\S]*?falling back to DISM feature enablement/,
    "WSL prerequisite helper should prefer PowerShell optional feature enablement and only then fall back to DISM",
  );
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
  assert.match(clientInstaller, /\$NativeCommandTimeoutExitCode\s*=\s*1460/);
  assert.match(clientInstaller, /startup-continuation-20260624/);
  assert.match(clientInstaller, /Script revision:/);
  assert.match(clientInstaller, /function\s+Invoke-IsolatedNativeCommand\b/);
  assert.match(clientInstaller, /Start-Job\s+-ScriptBlock/);
  assert.match(clientInstaller, /Wait-Job\s+-Job\s+\$job\s+-Timeout\s+\$TimeoutSeconds/);
  assert.match(clientInstaller, /function\s+Stop-HiddenNativeProcessTree\b/);
  assert.match(clientInstaller, /Native command timed out after/);
  assert.match(clientInstaller, /WaitForExit\(\$timeoutMilliseconds\)/);
  assert.match(
    clientInstaller,
    /@\(("--status"|'--status')\)\s+-TimeoutSeconds\s+45/,
    "client runtime installer must bound wsl.exe --status so MSI can finish with a useful log",
  );
  assert.match(clientInstaller, /AllowRestartContinuationSuccess/);
  assert.match(clientInstaller, /AllowDeferredRuntimeRepairSuccess/);
  assert.match(clientInstaller, /\[switch\]\$StartupContinuation/);
  assert.match(
    clientInstaller,
    /\[switch\]\$MachineSetupOnly/,
    "client runtime installer must support machine-setup-only mode for the elevated MSI LocalSystem flow",
  );
  assert.match(
    clientInstaller,
    /function\s+Invoke-MachineWslSetup\b/,
    "client runtime installer must own the silent, no-UAC machine WSL setup path used by the MSI",
  );
  assert.match(
    clientInstaller,
    /function\s+Register-MachineStartupContinuation\b[\s\S]*?-StartupContinuation[\s\S]*?-SkipPrerequisiteInstall[\s\S]*?Active Setup/,
    "client runtime installer must register a non-interactive user-context startup continuation from the MSI machine setup",
  );
  assert.match(
    clientInstaller,
    /function\s+Invoke-StartupContinuation\b[\s\S]*?Wait-WslUsable[\s\S]*?Invoke-LocalPowerShellScript\s+-ScriptPath\s+\$SandboxInstallerScript/s,
    "client runtime installer must finish VesloSandbox provisioning after reboot from a user-context startup continuation",
  );
  assert.match(
    clientInstaller,
    /function\s+Register-CurrentUserStartupRetry\b[\s\S]*?-StartupContinuation[\s\S]*?-SkipPrerequisiteInstall[\s\S]*?RunOnce/,
    "startup continuation should retry on the next user logon without elevating when WSL is still settling",
  );
  assert.match(
    clientInstaller,
    /function\s+Invoke-UserWslSetup\b/,
    "client runtime installer must keep the per-user flow used by the NSIS per-user installer hook",
  );
  assert.match(clientInstaller, /Resolve-RestartRequiredMarkerPath/);
  assert.match(clientInstaller, /runtime-setup-restart-required\.marker/);
  assert.doesNotMatch(
    clientInstaller,
    /Show-RestartPromptIfRequired/,
    "client runtime installer must not show a restart popup or force shutdown; restart is surfaced by the app",
  );
  assert.doesNotMatch(
    clientInstaller,
    /shutdown\.exe/,
    "client runtime installer must not run shutdown.exe to force a Windows restart",
  );
  assert.match(clientInstaller, /Set-Content\s+-LiteralPath\s+\$markerPath/);
  assert.match(clientInstaller, /VESLO_RUNTIME_SETUP_RESULT=restart_required/);
  assert.match(clientInstaller, /function\s+Write-RecentPrerequisiteLogTail\b/);
  assert.match(clientInstaller, /Latest WSL prerequisite helper transcript/);
  assert.match(clientInstaller, /Start-Sleep\s+-Milliseconds\s+500/);
  assert.match(clientInstaller, /Windows PowerShell transcript start/);
  assert.match(clientInstaller, /Get-Content\s+-LiteralPath\s+\$prereqLogPath\s+-ErrorAction\s+Stop/);
  assert.match(
    clientInstaller,
    /-not\s+\$restartContinuation[\s\S]*?first-run onboarding\/Settings repair will retry[\s\S]*?\$installerExitCode\s*=\s*0/,
    "client runtime installer should let MSI complete with a clear log when runtime repair must continue in onboarding",
  );
  assert.match(
    clientInstaller,
    /Cannot prepare Veslo WSL runtime under SYSTEM[\s\S]*?Finish-ClientInstaller 5/,
    "client runtime installer must fail under SYSTEM because WSL distro and RunOnce state are per-user",
  );
  assert.match(clientInstaller, /VESLO_RUNTIME_SETUP_RESULT=ready/);
  assert.match(clientInstaller, /VESLO_RUNTIME_SETUP_RESULT=restart_required/);
  assert.match(clientInstaller, /VESLO_RUNTIME_SETUP_RESULT=failed/);
  assert.match(clientInstaller, /wsl2-prerequisite-installer\.ps1/);
  assert.match(clientInstaller, /wsl2-sandbox-installer\.ps1/);
  assert.match(clientInstaller, /function\s+Resolve-WslExecutable\b/);
  assert.match(clientInstaller, /function\s+Resolve-PowerShellExecutable\b/);
  assert.match(clientInstaller, /Sysnative/);
  assert.match(clientInstaller, /System32/);
  assert.match(
    clientInstaller,
    /Invoke-ElevatedPowerShellScript\s+-ScriptPath\s+\$[Pp]rerequisiteScript\s+-ScriptArguments\s+@\("-Install"\)\s+-TimeoutSeconds\s+3600/,
    "client runtime installer per-user flow must still elevate the prerequisite helper once for WSL feature enablement",
  );
  assert.match(
    clientInstaller,
    /WSL status already failed; skipping redundant prerequisite check/,
    "client runtime installer should go directly to elevated prerequisite install after the initial WSL status failure",
  );
  assert.doesNotMatch(
    clientInstaller,
    /Invoke-LocalPowerShellScript\s+-ScriptPath\s+\$prerequisiteScript\s+-ScriptArguments\s+@\("-CheckOnly"\)/,
    "client runtime installer should not run a second local prerequisite check after wsl.exe --status already failed",
  );
  assert.match(clientInstaller, /-Verb\s+RunAs/);
  assert.match(clientInstaller, /RunOnce/);
  const commandBuilderFunction = clientInstaller.match(/function\s+New-ClientInstallerCommand[\s\S]*?\n}\r?\n/);
  assert.ok(commandBuilderFunction, "Expected client runtime installer to define the shared PowerShell command builder");
  assert.match(
    commandBuilderFunction[0],
    /\$ClientInstallerScriptPath/,
    "PowerShell continuations must use the script-scoped path; function-local MyInvocation can produce an empty -File",
  );
  assert.doesNotMatch(
    commandBuilderFunction[0],
    /\$MyInvocation\.MyCommand\.Path/,
    "PowerShell continuation command builder must not use function-local MyInvocation for the PowerShell -File path",
  );
  const runOnceFunction = clientInstaller.match(/function\s+Register-ClientInstallerRunOnce[\s\S]*?\n}\r?\n/);
  assert.ok(runOnceFunction, "Expected client runtime installer to define RunOnce continuation");
  assert.doesNotMatch(
    runOnceFunction[0],
    /-SkipPrerequisiteInstall/,
    "RunOnce continuation must retry WSL prerequisites after reboot instead of skipping WSL package download",
  );
  assert.doesNotMatch(
    runOnceFunction[0],
    /\$MyInvocation\.MyCommand\.Path/,
    "RunOnce continuation must not use function-local MyInvocation for the PowerShell -File path",
  );
  assert.match(
    clientInstaller,
    /Elevated prerequisite installer exited without an ExitCode[\s\S]*?ExitCode\s*=\s*\$exitCode/,
    "client runtime installer must not treat a null elevated process ExitCode as success",
  );
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
  assert.match(clientInstaller, /Native command finished with exit code \$exitCode\./);
  assert.doesNotMatch(
    clientInstaller,
    /&\s+(?:wsl|powershell)\.exe\b/i,
    "client runtime installer should not invoke WSL or nested PowerShell children through PowerShell's call operator",
  );
  const wrapper = readFileSync(wrapperPath, "utf8");
  assert.match(wrapper, /\$NativeCommandTimeoutExitCode\s*=\s*1460/);
  assert.match(wrapper, /native-timeout-isolation-20260623/);
  assert.match(wrapper, /Script revision:/);
  assert.match(wrapper, /function\s+Invoke-IsolatedNativeCommand\b/);
  assert.match(wrapper, /Start-Job\s+-ScriptBlock/);
  assert.match(wrapper, /Wait-Job\s+-Job\s+\$job\s+-Timeout\s+\$TimeoutSeconds/);
  assert.match(wrapper, /function\s+Stop-HiddenNativeProcessTree\b/);
  assert.match(wrapper, /Native command timed out after/);
  assert.match(wrapper, /WaitForExit\(\$timeoutMilliseconds\)/);
  assert.match(
    wrapper,
    /@\(("--status"|'--status')\)\s+-TimeoutSeconds\s+45/,
    "MSI sandbox wrapper must bound wsl.exe --status so a wedged WSL service does not hang setup",
  );
  assert.doesNotMatch(
    wrapper,
    /best-effort/,
    "sandbox provisioning wrapper must not describe package setup failures as best-effort",
  );
  assert.match(
    wrapper,
    /Cannot provision Veslo WSL runtime under SYSTEM[\s\S]*?Finish-Installer 5/,
    "sandbox provisioning wrapper must fail under SYSTEM because WSL distros are per-user",
  );
  assert.match(wrapper, /package\.json/);
  assert.match(wrapper, /function\s+Resolve-WslExecutable\b/);
  assert.match(wrapper, /function\s+Resolve-PowerShellExecutable\b/);
  assert.match(wrapper, /Sysnative/);
  assert.match(wrapper, /System32/);
  assert.match(
    wrapper,
    /Invoke-HiddenNativeCommand\s+-FilePath\s+\$wslCommand\s+-Arguments\s+@\("--status"\)\s+-TimeoutSeconds\s+45/,
  );
  assert.match(
    wrapper,
    /Write-InstallerLog "wsl\.exe was not found[\s\S]*?Finish-Installer 127/,
    "sandbox provisioning wrapper must not report success when WSL is missing",
  );
  assert.match(
    wrapper,
    /Write-InstallerLog "powershell\.exe was not found[\s\S]*?Finish-Installer 127/,
    "sandbox provisioning wrapper must not report success when PowerShell is missing",
  );
  assert.match(
    wrapper,
    /Invoke-HiddenNativeCommand\s+-FilePath\s+\$powershellCommand\s+-Arguments\s+@\(\$baseArgs\s+\+\s+@\("-CheckOnly"\)\)\s+-TimeoutSeconds\s+600/,
  );
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
  assert.match(provisioner, /\$NativeCommandTimeoutExitCode\s*=\s*1460/);
  assert.match(provisioner, /tls-opencode-version-guard-20260623/);
  assert.match(provisioner, /Script revision:/);
  assert.match(provisioner, /SecurityProtocol[\s\S]*?Tls12/);
  assert.match(provisioner, /function\s+Invoke-ProvisionWebRequest\b/);
  assert.match(provisioner, /Invoke-WebRequest[\s\S]*?-TimeoutSec\s+\$TimeoutSeconds/);
  assert.match(provisioner, /Join-Path\s+\$PSScriptRoot\s+"package\.json"/);
  assert.match(provisioner, /Join-Path\s+\$PSScriptRoot\s+"\.\.\\package\.json"/);
  assert.match(provisioner, /test "\$actual" = "__EXPECTED_OPENCODE_VERSION__"/);
  assert.doesNotMatch(
    provisioner,
    /opencode --version \| grep -F/,
    "CheckOnly must compare the parsed OpenCode version exactly instead of accepting substring matches",
  );
  assert.match(provisioner, /catch\s*\{[\s\S]*?Unhandled provisioning error/);
  assert.match(provisioner, /function\s+Invoke-IsolatedNativeCommand\b/);
  assert.match(provisioner, /Start-Job\s+-ScriptBlock/);
  assert.match(provisioner, /Wait-Job\s+-Job\s+\$job\s+-Timeout\s+\$TimeoutSeconds/);
  assert.match(provisioner, /function\s+Stop-HiddenNativeProcessTree\b/);
  assert.match(provisioner, /Timed out after \$TimeoutSeconds seconds/);
  assert.match(provisioner, /WaitForExit\(\$timeoutMilliseconds\)/);
  assert.match(
    provisioner,
    /Invoke-Wsl\s+-WslArgs\s+@\(("--status"|'--status')\)\s+-TimeoutSeconds\s+45/,
    "provisioning helper must bound wsl.exe --status before importing the managed distro",
  );
  assert.match(
    provisioner,
    /New-Object\s+System\.Diagnostics\.ProcessStartInfo[\s\S]*?\$startInfo\.UseShellExecute\s*=\s*\$false[\s\S]*?\$startInfo\.CreateNoWindow\s*=\s*\$true/,
    "WSL provisioner should run every wsl.exe command through hidden ProcessStartInfo",
  );
  assert.match(
    provisioner,
    /Invoke-HiddenNativeCommand\s+-FilePath\s+"wsl\.exe"\s+-Arguments\s+\$WslArgs/,
    "WSL provisioner should route Invoke-Wsl through the hidden native command helper",
  );
  assert.doesNotMatch(
    provisioner,
    /&\s+wsl\.exe\b/i,
    "WSL provisioner should not invoke wsl.exe through PowerShell's call operator",
  );
});

test("Windows NSIS builds a current-user client installer with dormant WSL runtime hook", () => {
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
    "Client NSIS installer should keep the dormant post-install WSL runtime setup hook available",
  );
  assert.ok(existsSync(hookPath), "Expected the NSIS installer hook file to exist");
  const czechLanguagePath = resolve(srcTauriDir, "windows/locales/Czech.nsh");
  assert.ok(existsSync(czechLanguagePath), "Expected the NSIS Czech language file to exist");

  const hook = readFileSync(hookPath, "utf8");
  assert.match(hook, /NSIS_HOOK_POSTINSTALL/);
  assert.match(
    hook,
    /!ifdef VESLO_ENABLE_WSL_INSTALLER/,
    "NSIS WSL runtime preparation must be behind an explicit rollback define",
  );
  assert.match(
    hook,
    /Skipping Veslo WSL runtime preparation; shared non-sandbox runtime is enabled by default\./,
    "NSIS installer should not run default sandbox preparation while shared non-sandbox runtime is the desktop default",
  );
  assert.match(
    hook,
    /nsExec::ExecToLog/,
    "NSIS rollback hook should run PowerShell through nsExec so no console window is shown when explicitly enabled",
  );
  assert.doesNotMatch(
    hook,
    /\bExecWait\b/,
    "NSIS hook must not launch powershell.exe directly through ExecWait because that can flash a console window",
  );
  assert.match(hook, /wsl2-client-installer\.ps1/);
  assert.match(hook, /-NoProfile\s+-NonInteractive\s+-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass/);
  assert.match(hook, /SetRebootFlag\s+true/);
  assert.match(hook, /MessageBox\s+MB_ICONINFORMATION/);
  assert.match(hook, /MessageBox\s+MB_ICONEXCLAMATION/);
  assert.match(hook, /Abort\s+"Veslo Windows runtime preparation failed/);
  assert.match(hook, /wsl2-client-installer\.log/);
  assert.match(
    hook,
    /\$COMMONAPPDATA\\Veslo\\logs\\wsl2-prerequisite-installer\.log/,
    "NSIS hook should print the standard NSIS ProgramData variable for prerequisite setup logs",
  );
  assert.doesNotMatch(
    hook,
    /\$PROGRAMDATA/,
    "NSIS hook must not use a non-standard $PROGRAMDATA variable when printing log paths",
  );
  assert.match(hook, /wsl2-prerequisite-installer\.log/);
  assert.match(hook, /wsl2-sandbox-installer\.log/);
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
