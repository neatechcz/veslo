import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveWindowsWixVersion } from "./windows-version.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const outputJson = args.includes("--json");
const strict = args.includes("--strict");
const calverPattern = /^\d{4}\.(?:[1-9]|1[0-2])\.\d+$/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(path, "utf8");

const readCargoVersion = (path) => {
  const content = readText(path);
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
};

const appPkg = readJson(resolve(root, "packages", "app", "package.json"));
const desktopPkg = readJson(resolve(root, "packages", "desktop", "package.json"));
const orchestratorPkg = readJson(resolve(root, "packages", "orchestrator", "package.json"));
const serverPkg = readJson(resolve(root, "packages", "server", "package.json"));
const opencodeRouterPkg = readJson(resolve(root, "packages", "opencode-router", "package.json"));
const tauriConfig = readJson(resolve(root, "packages", "desktop", "src-tauri", "tauri.conf.json"));
const cargoVersion = readCargoVersion(resolve(root, "packages", "desktop", "src-tauri", "Cargo.toml"));
const tauriBundleResources = tauriConfig.bundle?.resources ?? {};
const tauriWindowsWix = tauriConfig.bundle?.windows?.wix ?? {};
const tauriWindowsNsis = tauriConfig.bundle?.windows?.nsis ?? {};

const versions = {
  app: appPkg.version ?? null,
  desktop: desktopPkg.version ?? null,
  tauri: tauriConfig.version ?? null,
  windowsMsi: tauriConfig.bundle?.windows?.wix?.version ?? null,
  windowsMsiUpgradeCode: tauriConfig.bundle?.windows?.wix?.upgradeCode ?? null,
  cargo: cargoVersion ?? null,
  server: serverPkg.version ?? null,
  orchestrator: orchestratorPkg.version ?? null,
  opencodeRouter: opencodeRouterPkg.version ?? null,
  opencode: {
    desktop: desktopPkg.opencodeVersion ?? null,
    orchestrator: orchestratorPkg.opencodeVersion ?? null,
  },
  opencodeRouterVersionPinned: desktopPkg.opencodeRouterVersion ?? null,
  orchestratorVesloServerRange: orchestratorPkg.dependencies?.["veslo-server"] ?? null,
  orchestratorVesloCodeRouterRange: orchestratorPkg.dependencies?.["veslo-code-router"] ?? null,
};

const checks = [];
const warnings = [];
let ok = true;

const addCheck = (label, pass, details) => {
  checks.push({ label, ok: pass, details });
  if (!pass) ok = false;
};

const addWarning = (message) => warnings.push(message);

const manifestEntryVersion = (manifest, name) =>
  manifest?.[name]?.version ?? manifest?.entries?.[name]?.version ?? null;

const addManifestEntryVersionCheck = (manifest, name, expectedVersion, label) => {
  const actualVersion = manifestEntryVersion(manifest, name);
  addCheck(
    label,
    Boolean(expectedVersion && actualVersion === expectedVersion),
    `${actualVersion ?? "?"} vs ${expectedVersion ?? "?"}`,
  );
};

const hostSidecarName = (name) => (process.platform === "win32" ? `${name}.exe` : name);

const readHostSidecarVersion = (path) => {
  try {
    const result = spawnSync(path, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch {
    // ignore
  }
  return null;
};

const addHostSidecarVersionCheck = (sidecarDir, name, expectedVersion, label) => {
  const sidecarPath = resolve(sidecarDir, hostSidecarName(name));
  if (!existsSync(sidecarPath)) {
    addWarning(`Desktop sidecar binary missing (${hostSidecarName(name)}). Run pnpm --filter @neatech/veslo prepare:sidecar before packaging.`);
    return;
  }

  const actualVersion = readHostSidecarVersion(sidecarPath);
  addCheck(
    label,
    Boolean(expectedVersion && actualVersion === expectedVersion),
    `${actualVersion ?? "?"} vs ${expectedVersion ?? "?"}`,
  );
};

const versionChecks = [
  ["app", versions.app],
  ["desktop", versions.desktop],
  ["tauri", versions.tauri],
  ["cargo", versions.cargo],
  ["veslo-orchestrator", versions.orchestrator],
  ["veslo-server", versions.server],
  ["veslo-code-router", versions.opencodeRouter],
];
for (const [label, value] of versionChecks) {
  addCheck(
    `${label} uses CalVer (YYYY.M.P)`,
    typeof value === "string" && calverPattern.test(value),
    value ?? "?",
  );
}

addCheck(
  "App/desktop versions match",
  versions.app && versions.desktop && versions.app === versions.desktop,
  `${versions.app ?? "?"} vs ${versions.desktop ?? "?"}`,
);
addCheck(
  "App/veslo-orchestrator versions match",
  versions.app && versions.orchestrator && versions.app === versions.orchestrator,
  `${versions.app ?? "?"} vs ${versions.orchestrator ?? "?"}`,
);
addCheck(
  "App/veslo-server versions match",
  versions.app && versions.server && versions.app === versions.server,
  `${versions.app ?? "?"} vs ${versions.server ?? "?"}`,
);
addCheck(
  "App/veslo-code-router versions match",
  versions.app && versions.opencodeRouter && versions.app === versions.opencodeRouter,
  `${versions.app ?? "?"} vs ${versions.opencodeRouter ?? "?"}`,
);
addCheck(
  "Desktop/Tauri versions match",
  versions.desktop && versions.tauri && versions.desktop === versions.tauri,
  `${versions.desktop ?? "?"} vs ${versions.tauri ?? "?"}`,
);
addCheck(
  "Desktop/Cargo versions match",
  versions.desktop && versions.cargo && versions.desktop === versions.cargo,
  `${versions.desktop ?? "?"} vs ${versions.cargo ?? "?"}`,
);
if (versions.app) {
  const expectedWindowsMsi = deriveWindowsWixVersion(versions.app);
  addCheck(
    "Windows MSI version matches derived CalVer mapping",
    versions.windowsMsi === expectedWindowsMsi,
    `${versions.windowsMsi ?? "?"} vs ${expectedWindowsMsi}`,
  );
}
addCheck(
  "Windows MSI upgrade code is pinned",
  typeof versions.windowsMsiUpgradeCode === "string" && versions.windowsMsiUpgradeCode.trim().length > 0,
  versions.windowsMsiUpgradeCode ?? "?",
);
addCheck(
  "Windows MSI bundles desktop package manifest for WSL provisioning version pin",
  tauriBundleResources["../package.json"] === "package.json" &&
    existsSync(resolve(root, "packages", "desktop", "package.json")),
  tauriBundleResources["../package.json"] ?? "?",
);
addCheck(
  "Windows MSI bundles WSL sandbox provisioner",
  tauriBundleResources["../../orchestrator/scripts/windows-wsl2-sandbox-provision.ps1"] ===
    "windows-wsl2-sandbox-provision.ps1" &&
    existsSync(resolve(root, "packages", "orchestrator", "scripts", "windows-wsl2-sandbox-provision.ps1")),
  tauriBundleResources["../../orchestrator/scripts/windows-wsl2-sandbox-provision.ps1"] ?? "?",
);
const wslPrerequisiteInstallerPath = resolve(
  root,
  "packages",
  "desktop",
  "src-tauri",
  "windows",
  "wsl2-prerequisite-installer.ps1",
);
const wslPrerequisiteInstaller = existsSync(wslPrerequisiteInstallerPath)
  ? readText(wslPrerequisiteInstallerPath)
  : "";
const hiddenProcessStartInfoPattern =
  /New-Object\s+System\.Diagnostics\.ProcessStartInfo[\s\S]*?\$startInfo\.UseShellExecute\s*=\s*\$false[\s\S]*?\$startInfo\.CreateNoWindow\s*=\s*\$true/;
const nativeCommandTimeoutPattern =
  /\$NativeCommandTimeoutExitCode\s*=\s*1460[\s\S]*?function\s+Stop-HiddenNativeProcessTree\b[\s\S]*?WaitForExit\(\$timeoutMilliseconds\)/;
const hasIsolatedWslCommandGuard = (text) =>
  /(?:native-timeout-isolation|skip-redundant-prereq-check|wsl-install-dism-fallback|optional-feature-fallback|expanded-prereq-log-tail|optional-feature-first|runonce-elevated-exit-guard|tls-opencode-version-guard)-20260623/.test(text) &&
  /Script revision:/.test(text) &&
  /function\s+Invoke-IsolatedNativeCommand\b/.test(text) &&
  /Start-Job\s+-ScriptBlock/.test(text) &&
  /Wait-Job\s+-Job\s+\$job\s+-Timeout\s+\$TimeoutSeconds/.test(text);
const wslStatusTimeoutPattern = /@\(("--status"|'--status')\)\s+-TimeoutSeconds\s+45/;
addCheck(
  "Windows MSI bundles WSL prerequisite installer for first-run repair",
  tauriBundleResources["windows/wsl2-prerequisite-installer.ps1"] ===
    "wsl2-prerequisite-installer.ps1" &&
    /Invoke-NativeCommand\s+-FilePath\s+\$WslCommand\s+-Arguments\s+@\("--install",\s+"--no-distribution",\s+"--web-download"\)\s+-TimeoutSeconds\s+1800/.test(
      wslPrerequisiteInstaller,
    ) &&
    /Invoke-NativeCommand\s+-FilePath\s+\$WslCommand\s+-Arguments\s+@\("--install",\s+"--no-distribution"\)\s+-TimeoutSeconds\s+1800/.test(
      wslPrerequisiteInstaller,
    ) &&
    /Invoke-NativeCommand\s+-FilePath\s+\$WslCommand\s+-Arguments\s+@\("--update",\s+"--web-download"\)\s+-TimeoutSeconds\s+1800/.test(
      wslPrerequisiteInstaller,
    ) &&
    /function\s+Resolve-WslExecutable\b/.test(wslPrerequisiteInstaller) &&
    /function\s+Resolve-DismExecutable\b/.test(wslPrerequisiteInstaller) &&
    /Sysnative/.test(wslPrerequisiteInstaller) &&
    /System32/.test(wslPrerequisiteInstaller) &&
    /Microsoft-Windows-Subsystem-Linux/.test(wslPrerequisiteInstaller) &&
    /VirtualMachinePlatform/.test(wslPrerequisiteInstaller) &&
    /function\s+Test-WslInstallDismFallback\b/.test(wslPrerequisiteInstaller) &&
    /Invoke-FeatureEnablementFallbackAfterWslInstallFailure/.test(wslPrerequisiteInstaller) &&
    /Enabling Windows WSL optional features so Windows can finish WSL setup after restart/.test(
      wslPrerequisiteInstaller,
    ) &&
    /function\s+Enable-WslFeaturesWithPowerShell\b/.test(wslPrerequisiteInstaller) &&
    /function\s+Enable-WslFeaturesWithPowerShellThenDism\b/.test(wslPrerequisiteInstaller) &&
    /Enable-WindowsOptionalFeature/.test(wslPrerequisiteInstaller) &&
    /PowerShell optional feature enablement failed[\s\S]*?falling back to DISM feature enablement/.test(
      wslPrerequisiteInstaller,
    ) &&
    hiddenProcessStartInfoPattern.test(wslPrerequisiteInstaller) &&
    nativeCommandTimeoutPattern.test(wslPrerequisiteInstaller) &&
    hasIsolatedWslCommandGuard(wslPrerequisiteInstaller) &&
    /Native command timed out after/.test(wslPrerequisiteInstaller) &&
    wslStatusTimeoutPattern.test(wslPrerequisiteInstaller) &&
    !/&\s+\$FilePath\b/.test(wslPrerequisiteInstaller),
  tauriBundleResources["windows/wsl2-prerequisite-installer.ps1"] ?? "?",
);
const wslClientInstallerPath = resolve(
  root,
  "packages",
  "desktop",
  "src-tauri",
  "windows",
  "wsl2-client-installer.ps1",
);
const wslClientInstaller = existsSync(wslClientInstallerPath) ? readText(wslClientInstallerPath) : "";
addCheck(
  "Windows installers bundle client WSL runtime setup",
  tauriBundleResources["windows/wsl2-client-installer.ps1"] === "wsl2-client-installer.ps1" &&
    /AllowRestartContinuationSuccess/.test(wslClientInstaller) &&
    /AllowDeferredRuntimeRepairSuccess/.test(wslClientInstaller) &&
    /function\s+Write-RecentPrerequisiteLogTail\b/.test(wslClientInstaller) &&
    /Latest WSL prerequisite helper transcript/.test(wslClientInstaller) &&
    /Start-Sleep\s+-Milliseconds\s+500/.test(wslClientInstaller) &&
    /Windows PowerShell transcript start/.test(wslClientInstaller) &&
    /Get-Content\s+-LiteralPath\s+\$prereqLogPath\s+-ErrorAction\s+Stop/.test(wslClientInstaller) &&
    /first-run onboarding\/Settings repair will retry[\s\S]*?\$installerExitCode\s*=\s*0/.test(
      wslClientInstaller,
    ) &&
    /VESLO_RUNTIME_SETUP_RESULT=ready/.test(wslClientInstaller) &&
    /VESLO_RUNTIME_SETUP_RESULT=restart_required/.test(wslClientInstaller) &&
    /VESLO_RUNTIME_SETUP_RESULT=failed/.test(wslClientInstaller) &&
    /wsl2-prerequisite-installer\.ps1/.test(wslClientInstaller) &&
    /wsl2-sandbox-installer\.ps1/.test(wslClientInstaller) &&
    /function\s+Resolve-WslExecutable\b/.test(wslClientInstaller) &&
    /function\s+Resolve-PowerShellExecutable\b/.test(wslClientInstaller) &&
    /Sysnative/.test(wslClientInstaller) &&
    /System32/.test(wslClientInstaller) &&
    /Cannot prepare Veslo WSL runtime under SYSTEM[\s\S]*?Finish-ClientInstaller 5/.test(
      wslClientInstaller,
    ) &&
    /Invoke-ElevatedPowerShellScript\s+-ScriptPath\s+\$prerequisiteScript\s+-ScriptArguments\s+@\("-Install"\)\s+-TimeoutSeconds\s+3600/.test(wslClientInstaller) &&
    /WSL status already failed; skipping redundant prerequisite check/.test(wslClientInstaller) &&
    !/Invoke-LocalPowerShellScript\s+-ScriptPath\s+\$prerequisiteScript\s+-ScriptArguments\s+@\("-CheckOnly"\)/.test(wslClientInstaller) &&
    /-Verb\s+RunAs/.test(wslClientInstaller) &&
    /RunOnce/.test(wslClientInstaller) &&
    /\$ClientInstallerScriptPath/.test(wslClientInstaller) &&
    !/function\s+Register-ClientInstallerRunOnce[\s\S]*?\$MyInvocation\.MyCommand\.Path[\s\S]*?\n}/.test(
      wslClientInstaller,
    ) &&
    /Elevated prerequisite installer exited without an ExitCode[\s\S]*?ExitCode\s*=\s*\$exitCode/.test(
      wslClientInstaller,
    ) &&
    hiddenProcessStartInfoPattern.test(wslClientInstaller) &&
    nativeCommandTimeoutPattern.test(wslClientInstaller) &&
    hasIsolatedWslCommandGuard(wslClientInstaller) &&
    /Native command timed out after/.test(wslClientInstaller) &&
    wslStatusTimeoutPattern.test(wslClientInstaller) &&
    !/&\s+(?:wsl|powershell)\.exe\b/i.test(wslClientInstaller),
  tauriBundleResources["windows/wsl2-client-installer.ps1"] ?? "?",
);
const wslSandboxInstallerPath = resolve(
  root,
  "packages",
  "desktop",
  "src-tauri",
  "windows",
  "wsl2-sandbox-installer.ps1",
);
const wslSandboxInstaller = existsSync(wslSandboxInstallerPath) ? readText(wslSandboxInstallerPath) : "";
addCheck(
  "Windows MSI bundles WSL sandbox installer wrapper",
  tauriBundleResources["windows/wsl2-sandbox-installer.ps1"] === "wsl2-sandbox-installer.ps1" &&
    !/best-effort/.test(wslSandboxInstaller) &&
    /Cannot provision Veslo WSL runtime under SYSTEM[\s\S]*?Finish-Installer 5/.test(
      wslSandboxInstaller,
    ) &&
    hiddenProcessStartInfoPattern.test(wslSandboxInstaller) &&
    nativeCommandTimeoutPattern.test(wslSandboxInstaller) &&
    hasIsolatedWslCommandGuard(wslSandboxInstaller) &&
    /Native command timed out after/.test(wslSandboxInstaller) &&
    wslStatusTimeoutPattern.test(wslSandboxInstaller) &&
    !/&\s+(?:wsl|powershell)\.exe\b/i.test(wslSandboxInstaller),
  tauriBundleResources["windows/wsl2-sandbox-installer.ps1"] ?? "?",
);
const wslSandboxProvisionerPath = resolve(
  root,
  "packages",
  "orchestrator",
  "scripts",
  "windows-wsl2-sandbox-provision.ps1",
);
const wslSandboxProvisioner = existsSync(wslSandboxProvisionerPath) ? readText(wslSandboxProvisionerPath) : "";
addCheck(
  "Windows MSI bundles hidden WSL sandbox provisioner",
    tauriBundleResources["../../orchestrator/scripts/windows-wsl2-sandbox-provision.ps1"] ===
    "windows-wsl2-sandbox-provision.ps1" &&
    hiddenProcessStartInfoPattern.test(wslSandboxProvisioner) &&
    nativeCommandTimeoutPattern.test(wslSandboxProvisioner) &&
    hasIsolatedWslCommandGuard(wslSandboxProvisioner) &&
    /Timed out after \$TimeoutSeconds seconds/.test(wslSandboxProvisioner) &&
    /SecurityProtocol[\s\S]*?Tls12/.test(wslSandboxProvisioner) &&
    /function\s+Invoke-ProvisionWebRequest\b/.test(wslSandboxProvisioner) &&
    /Invoke-WebRequest[\s\S]*?-TimeoutSec\s+\$TimeoutSeconds/.test(wslSandboxProvisioner) &&
    /Join-Path\s+\$PSScriptRoot\s+"package\.json"/.test(wslSandboxProvisioner) &&
    /Join-Path\s+\$PSScriptRoot\s+"\.\.\\package\.json"/.test(wslSandboxProvisioner) &&
    /test "\$actual" = "__EXPECTED_OPENCODE_VERSION__"/.test(wslSandboxProvisioner) &&
    !/opencode --version \| grep -F/.test(wslSandboxProvisioner) &&
    /catch\s*\{[\s\S]*?Unhandled provisioning error/.test(wslSandboxProvisioner) &&
    /Invoke-Wsl\s+-WslArgs\s+@\(("--status"|'--status')\)\s+-TimeoutSeconds\s+45/.test(
      wslSandboxProvisioner,
    ) &&
    /Invoke-HiddenNativeCommand\s+-FilePath\s+"wsl\.exe"\s+-Arguments\s+\$WslArgs/.test(wslSandboxProvisioner) &&
    !/&\s+wsl\.exe\b/i.test(wslSandboxProvisioner),
  tauriBundleResources["../../orchestrator/scripts/windows-wsl2-sandbox-provision.ps1"] ?? "?",
);
const wslInstallerFragmentPath = resolve(
  root,
  "packages",
  "desktop",
  "src-tauri",
  "windows",
  "wsl2-sandbox-installer.wxs",
);
const wslInstallerFragment = existsSync(wslInstallerFragmentPath) ? readText(wslInstallerFragmentPath) : "";
addCheck(
  "Windows MSI schedules WSL sandbox provisioning action",
  Array.isArray(tauriWindowsWix.fragmentPaths) &&
    tauriWindowsWix.fragmentPaths.includes("windows/wsl2-sandbox-installer.wxs") &&
    Array.isArray(tauriWindowsWix.componentGroupRefs) &&
    tauriWindowsWix.componentGroupRefs.includes("VesloWslProvisioningInstallerComponents") &&
    /<Property\s+Id="MsiLogging"\s+Value="voicewarmupx!"\s*\/>/.test(wslInstallerFragment) &&
    /RemoveOldVesloWslClientInstaller/.test(wslInstallerFragment) &&
    /RemoveOldVesloWslPrerequisiteInstaller/.test(wslInstallerFragment) &&
    /RemoveOldVesloWslSandboxInstaller/.test(wslInstallerFragment) &&
    /RemoveOldVesloWslSandboxProvisioner/.test(wslInstallerFragment) &&
    /Name="wsl2-client-installer\.ps1"\s+On="install"/.test(wslInstallerFragment) &&
    /ComponentGroup\s+Id="VesloWslProvisioningInstallerComponents"/.test(wslInstallerFragment) &&
    /Id="VesloProvisionWslSandbox"/.test(wslInstallerFragment) &&
    /After="InstallFiles"/.test(wslInstallerFragment) &&
    /Return="check"/.test(wslInstallerFragment) &&
    /\[System64Folder\]WindowsPowerShell\\v1\.0\\powershell\.exe/.test(wslInstallerFragment) &&
    !/\[SystemFolder\]WindowsPowerShell\\v1\.0\\powershell\.exe/.test(wslInstallerFragment) &&
    /-NoProfile\s+-NonInteractive\s+-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass/.test(wslInstallerFragment) &&
    /\[INSTALLDIR\]wsl2-client-installer\.ps1/.test(wslInstallerFragment) &&
    /-AllowRestartContinuationSuccess/.test(wslInstallerFragment) &&
    /-AllowDeferredRuntimeRepairSuccess/.test(wslInstallerFragment) &&
    /function\s+Resolve-WslExecutable\b/.test(wslSandboxInstaller) &&
    /function\s+Resolve-PowerShellExecutable\b/.test(wslSandboxInstaller) &&
    /Sysnative/.test(wslSandboxInstaller) &&
    /System32/.test(wslSandboxInstaller) &&
    /Write-InstallerLog "wsl\.exe was not found[\s\S]*?Finish-Installer 127/.test(
      wslSandboxInstaller,
    ) &&
    /Write-InstallerLog "powershell\.exe was not found[\s\S]*?Finish-Installer 127/.test(
      wslSandboxInstaller,
    ) &&
    /package\.json/.test(wslSandboxInstaller),
  Array.isArray(tauriWindowsWix.fragmentPaths)
    ? tauriWindowsWix.fragmentPaths.join(", ")
    : "?",
);
const nsisHookPath = resolve(root, "packages", "desktop", "src-tauri", "windows", "nsis-hooks.nsh");
const nsisHook = existsSync(nsisHookPath) ? readText(nsisHookPath) : "";
const nsisCzechLanguagePath = resolve(root, "packages", "desktop", "src-tauri", "windows", "locales", "Czech.nsh");
const nsisCzechLanguage = existsSync(nsisCzechLanguagePath) ? readText(nsisCzechLanguagePath) : "";
addCheck(
  "Windows NSIS client installer is current-user and prepares runtime",
  tauriWindowsNsis.installMode === "currentUser" &&
    Array.isArray(tauriWindowsNsis.languages) &&
    tauriWindowsNsis.languages[0] === "Czech" &&
    tauriWindowsNsis.languages.includes("English") &&
    tauriWindowsNsis.customLanguageFiles?.Czech === "windows/locales/Czech.nsh" &&
    /LangString\s+alreadyInstalled\s+\$\{LANG_CZECH\}/.test(nsisCzechLanguage) &&
    /LangString\s+webview2InstallSuccess\s+\$\{LANG_CZECH\}/.test(nsisCzechLanguage) &&
    /LangString\s+deleteAppData\s+\$\{LANG_CZECH\}/.test(nsisCzechLanguage) &&
    tauriWindowsNsis.installerHooks === "windows/nsis-hooks.nsh" &&
    /NSIS_HOOK_POSTINSTALL/.test(nsisHook) &&
    /nsExec::ExecToLog/.test(nsisHook) &&
    !/\bExecWait\b/.test(nsisHook) &&
    /wsl2-client-installer\.ps1/.test(nsisHook) &&
    /-NoProfile\s+-NonInteractive\s+-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass/.test(nsisHook) &&
    /SetRebootFlag\s+true/.test(nsisHook) &&
    /MessageBox\s+MB_ICONINFORMATION/.test(nsisHook) &&
    /MessageBox\s+MB_ICONEXCLAMATION/.test(nsisHook) &&
    /Abort\s+"Veslo Windows runtime preparation failed/.test(nsisHook) &&
    /wsl2-client-installer\.log/.test(nsisHook) &&
    /\$COMMONAPPDATA\\Veslo\\logs\\wsl2-prerequisite-installer\.log/.test(nsisHook) &&
    !/\$PROGRAMDATA/.test(nsisHook) &&
    /wsl2-prerequisite-installer\.log/.test(nsisHook) &&
    /wsl2-sandbox-installer\.log/.test(nsisHook) &&
    !/-Verb\s+RunAs/.test(nsisHook),
  `${tauriWindowsNsis.installMode ?? "?"}; ${tauriWindowsNsis.installerHooks ?? "?"}`,
);
const supervisedProcessPath = resolve(root, "packages", "desktop", "src-tauri", "src", "supervised_process.rs");
const supervisedProcess = existsSync(supervisedProcessPath) ? readText(supervisedProcessPath) : "";
const windowsPlatformPath = resolve(root, "packages", "desktop", "src-tauri", "src", "platform", "windows.rs");
const windowsPlatform = existsSync(windowsPlatformPath) ? readText(windowsPlatformPath) : "";
const wslSandboxCommandPath = resolve(root, "packages", "desktop", "src-tauri", "src", "commands", "wsl_sandbox.rs");
const wslSandboxCommand = existsSync(wslSandboxCommandPath) ? readText(wslSandboxCommandPath) : "";
const vesloServerDesktopPath = resolve(root, "packages", "desktop", "src-tauri", "src", "veslo_server", "mod.rs");
const vesloServerDesktop = existsSync(vesloServerDesktopPath) ? readText(vesloServerDesktopPath) : "";
addCheck(
  "Windows runtime sidecars and repair helpers launch without console windows",
  /const\s+CREATE_NO_WINDOW:\s*u32\s*=\s*0x0800_0000/.test(supervisedProcess) &&
    /command\.creation_flags\(CREATE_NO_WINDOW\)/.test(supervisedProcess) &&
    /pub fn spawn\(self\)[\s\S]*?spawn_hidden_command/.test(supervisedProcess) &&
    /pub fn configure_hidden[\s\S]*?command\.creation_flags\(CREATE_NO_WINDOW\)/.test(windowsPlatform) &&
    /Command::new\("powershell\.exe"\)[\s\S]*?configure_hidden\(&mut command\)/.test(wslSandboxCommand) &&
    /Start-Process[\s\S]*?-WindowStyle Hidden[\s\S]*?-Verb RunAs/.test(wslSandboxCommand) &&
    /Command::new\("powershell"\)[\s\S]*?configure_hidden\(&mut command\)/.test(vesloServerDesktop) &&
    /Command::new\("wsl\.exe"\)[\s\S]*?configure_hidden\(&mut command\)/.test(vesloServerDesktop),
  "CREATE_NO_WINDOW + hidden PowerShell paths",
);
addCheck(
  "OpenCodeRouter version pinned in desktop",
  versions.opencodeRouter && versions.opencodeRouterVersionPinned && versions.opencodeRouter === versions.opencodeRouterVersionPinned,
  `${versions.opencodeRouterVersionPinned ?? "?"} vs ${versions.opencodeRouter ?? "?"}`,
);
if (versions.opencode.desktop || versions.opencode.orchestrator) {
  addCheck(
    "OpenCode version matches (desktop/orchestrator)",
    versions.opencode.desktop &&
      versions.opencode.orchestrator &&
      versions.opencode.desktop === versions.opencode.orchestrator,
    `${versions.opencode.desktop ?? "?"} vs ${versions.opencode.orchestrator ?? "?"}`,
  );
} else {
  addWarning(
    "OpenCode version is not pinned (packages/desktop + packages/orchestrator). Sidecar bundling will default to the latest OpenCode release at build time.",
  );
}

const vesloServerRange = versions.orchestratorVesloServerRange ?? "";
const vesloServerPinned = calverPattern.test(vesloServerRange);
if (!vesloServerRange) {
  addWarning("veslo-orchestrator is missing a veslo-server dependency.");
} else if (!vesloServerPinned) {
  addWarning(`veslo-orchestrator veslo-server dependency is not pinned (${vesloServerRange}).`);
} else {
  addCheck(
    "Veslo-server dependency matches server version",
    versions.server && vesloServerRange === versions.server,
    `${vesloServerRange} vs ${versions.server ?? "?"}`,
  );
}

const vesloCodeRouterRange = versions.orchestratorVesloCodeRouterRange ?? "";
const vesloCodeRouterPinned = calverPattern.test(vesloCodeRouterRange);
if (!vesloCodeRouterRange) {
  addWarning("veslo-orchestrator is missing a veslo-code-router dependency.");
} else if (!vesloCodeRouterPinned) {
  addWarning(
    `veslo-orchestrator veslo-code-router dependency is not pinned (${vesloCodeRouterRange}).`,
  );
} else {
  addCheck(
    "Veslo-code-router dependency matches router version",
    versions.opencodeRouter && vesloCodeRouterRange === versions.opencodeRouter,
    `${vesloCodeRouterRange} vs ${versions.opencodeRouter ?? "?"}`,
  );
}

const desktopSidecarDir = resolve(root, "packages", "desktop", "src-tauri", "sidecars");
const desktopSidecarManifestPath = resolve(desktopSidecarDir, "versions.json");
if (existsSync(desktopSidecarManifestPath)) {
  const desktopSidecarManifest = readJson(desktopSidecarManifestPath);
  addManifestEntryVersionCheck(
    desktopSidecarManifest,
    "veslo-server",
    versions.server,
    "Desktop sidecar manifest veslo-server version matches",
  );
  addManifestEntryVersionCheck(
    desktopSidecarManifest,
    "veslo-code-router",
    versions.opencodeRouter,
    "Desktop sidecar manifest veslo-code-router version matches",
  );
  addManifestEntryVersionCheck(
    desktopSidecarManifest,
    "veslo-orchestrator",
    versions.orchestrator,
    "Desktop sidecar manifest veslo-orchestrator version matches",
  );
  if (versions.opencode.desktop) {
    addManifestEntryVersionCheck(
      desktopSidecarManifest,
      "veslo-code",
      versions.opencode.desktop,
      "Desktop sidecar manifest veslo-code version matches",
    );
  }
} else {
  addWarning(
    "Desktop sidecar manifest missing (run pnpm --filter @neatech/veslo prepare:sidecar before packaging).",
  );
}

addHostSidecarVersionCheck(
  desktopSidecarDir,
  "veslo-server",
  versions.server,
  "Desktop veslo-server sidecar binary version matches",
);
addHostSidecarVersionCheck(
  desktopSidecarDir,
  "veslo-code-router",
  versions.opencodeRouter,
  "Desktop veslo-code-router sidecar binary version matches",
);
addHostSidecarVersionCheck(
  desktopSidecarDir,
  "veslo-orchestrator",
  versions.orchestrator,
  "Desktop veslo-orchestrator sidecar binary version matches",
);

const sidecarManifestPath = resolve(
  root,
  "packages",
  "orchestrator",
  "dist",
  "sidecars",
  "veslo-orchestrator-sidecars.json",
);
if (existsSync(sidecarManifestPath)) {
  const manifest = readJson(sidecarManifestPath);
  addCheck(
    "Sidecar manifest version matches veslo-orchestrator",
    versions.orchestrator && manifest.version === versions.orchestrator,
    `${manifest.version ?? "?"} vs ${versions.orchestrator ?? "?"}`,
  );
  const serverEntry = manifest.entries?.["veslo-server"]?.version;
  const routerEntry = manifest.entries?.["veslo-code-router"]?.version;
  if (serverEntry) {
    addCheck(
      "Sidecar manifest veslo-server version matches",
      versions.server && serverEntry === versions.server,
      `${serverEntry ?? "?"} vs ${versions.server ?? "?"}`,
    );
  }
  if (routerEntry) {
    addCheck(
      "Sidecar manifest veslo-code-router version matches",
      versions.opencodeRouter && routerEntry === versions.opencodeRouter,
      `${routerEntry ?? "?"} vs ${versions.opencodeRouter ?? "?"}`,
    );
  }
} else {
  addWarning(
    "Sidecar manifest missing (run pnpm --filter veslo-orchestrator build:sidecars).",
  );
}

if (!process.env.SOURCE_DATE_EPOCH) {
  addWarning("SOURCE_DATE_EPOCH is not set (sidecar manifests will include current time).");
}

const report = { ok, versions, checks, warnings };

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Release review");
  for (const check of checks) {
    const status = check.ok ? "ok" : "fail";
    console.log(`- ${status}: ${check.label} (${check.details})`);
  }
  if (warnings.length) {
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}

if (strict && !ok) {
  process.exit(1);
}
