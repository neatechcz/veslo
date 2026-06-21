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
addCheck(
  "Windows MSI bundles WSL prerequisite installer for first-run repair",
  tauriBundleResources["windows/wsl2-prerequisite-installer.ps1"] ===
    "wsl2-prerequisite-installer.ps1" &&
    /wsl\.exe"\s+@\("--install",\s+"--no-distribution"\)/.test(wslPrerequisiteInstaller) &&
    /Microsoft-Windows-Subsystem-Linux/.test(wslPrerequisiteInstaller) &&
    /VirtualMachinePlatform/.test(wslPrerequisiteInstaller) &&
    hiddenProcessStartInfoPattern.test(wslPrerequisiteInstaller) &&
    !/&\s+\$FilePath\b/.test(wslPrerequisiteInstaller),
  tauriBundleResources["windows/wsl2-prerequisite-installer.ps1"] ?? "?",
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
    hiddenProcessStartInfoPattern.test(wslSandboxInstaller) &&
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
    /Invoke-HiddenNativeCommand\s+"wsl\.exe"\s+\$WslArgs/.test(wslSandboxProvisioner) &&
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
    /ComponentGroup\s+Id="VesloWslProvisioningInstallerComponents"/.test(wslInstallerFragment) &&
    /Id="VesloProvisionWslSandbox"/.test(wslInstallerFragment) &&
    /After="InstallFiles"/.test(wslInstallerFragment) &&
    /Return="ignore"/.test(wslInstallerFragment) &&
    /-NoProfile\s+-NonInteractive\s+-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass/.test(wslInstallerFragment) &&
    /package\.json/.test(wslSandboxInstaller),
  Array.isArray(tauriWindowsWix.fragmentPaths)
    ? tauriWindowsWix.fragmentPaths.join(", ")
    : "?",
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
