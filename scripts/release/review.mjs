import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
const tauriWindowsReleaseConfig = readJson(
  resolve(root, "packages", "desktop", "src-tauri", "tauri.windows.release.conf.json"),
);
const tauriWindowsConfig = readJson(
  resolve(root, "packages", "desktop", "src-tauri", "tauri.windows.conf.json"),
);
const tauriStagingConfig = readJson(
  resolve(root, "packages", "desktop", "src-tauri", "tauri.staging.conf.json"),
);
const tauriWindowsStagingConfig = readJson(
  resolve(root, "packages", "desktop", "src-tauri", "tauri.windows.staging.conf.json"),
);
const cargoVersion = readCargoVersion(resolve(root, "packages", "desktop", "src-tauri", "Cargo.toml"));
const tauriBundleResources = tauriConfig.bundle?.resources ?? {};
const tauriWindowsReleaseBundleResources = tauriWindowsReleaseConfig.bundle?.resources ?? {};
const tauriWindowsNsis = tauriConfig.bundle?.windows?.nsis ?? {};
const windowsInstallerConfigs = [
  tauriConfig,
  tauriWindowsConfig,
  tauriWindowsReleaseConfig,
  tauriStagingConfig,
  tauriWindowsStagingConfig,
];
const tauriWindowsWebviewInstallMode = tauriConfig.bundle?.windows?.webviewInstallMode ?? {};
const releaseWorkflow = readText(resolve(root, ".github", "workflows", "release-macos-aarch64.yml"));
const prereleaseWorkflow = readText(resolve(root, ".github", "workflows", "prerelease.yml"));
const buildDesktopWorkflow = readText(resolve(root, ".github", "workflows", "build-desktop.yml"));
const buildWindowsMsiWorkflow = readText(resolve(root, ".github", "workflows", "build-windows-msi.yml"));
const buildStagingWorkflow = readText(resolve(root, ".github", "workflows", "build-staging-app.yml"));
const releaseDoc = readText(resolve(root, "RELEASE.md"));
const stateConfigDoc = readText(resolve(root, "docs", "dev", "state-and-config-reference.md"));
const applicationLogsDoc = readText(resolve(root, "docs", "dev", "veslo-application-logs.md"));
const workflowRoot = resolve(root, ".github", "workflows");
const activeWorkflows = readdirSync(workflowRoot)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((name) => ({ name, text: readText(resolve(workflowRoot, name)) }));

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

const extractWorkflowJob = (text, jobName) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) return "";

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n");
};

const releaseMacosTauriJob = extractWorkflowJob(releaseWorkflow, "publish-tauri");
const releaseWindowsTauriJob = extractWorkflowJob(releaseWorkflow, "publish-tauri-windows");
const releaseVerifyJob = extractWorkflowJob(releaseWorkflow, "verify-release");
const prereleaseTauriJob = extractWorkflowJob(prereleaseWorkflow, "publish-tauri");
const buildDesktopWindowsMsiJob = extractWorkflowJob(buildDesktopWorkflow, "build-windows-msi");
const buildWindowsMsiJob = extractWorkflowJob(buildWindowsMsiWorkflow, "build-windows-msi");
const buildStagingJob = extractWorkflowJob(buildStagingWorkflow, "build");

const hasGlitchTipReleaseEnv = (text, options = {}) => {
  const requireStrict = Boolean(options.requireStrict);
  return (
    /VESLO_GLITCHTIP_DSN:\s*\$\{\{\s*vars\.VESLO_GLITCHTIP_DSN\s*\}\}/.test(text) &&
    /VITE_VESLO_GLITCHTIP_DSN:\s*\$\{\{\s*vars\.VESLO_GLITCHTIP_DSN\s*\}\}/.test(text) &&
    /VESLO_GLITCHTIP_ENVIRONMENT:\s*production/.test(text) &&
    /VITE_VESLO_GLITCHTIP_ENVIRONMENT:\s*production/.test(text) &&
    /VESLO_GLITCHTIP_TRACES_SAMPLE_RATE:\s*\$\{\{\s*vars\.VESLO_GLITCHTIP_TRACES_SAMPLE_RATE\s*\|\|\s*'0'\s*\}\}/.test(
      text,
    ) &&
    /VITE_VESLO_GLITCHTIP_TRACES_SAMPLE_RATE:\s*\$\{\{\s*vars\.VESLO_GLITCHTIP_TRACES_SAMPLE_RATE\s*\|\|\s*'0'\s*\}\}/.test(
      text,
    ) &&
    /Verify GlitchTip release monitoring env/.test(text) &&
    /verify-glitchtip-release-env\.mjs/.test(text) &&
    (!requireStrict || /VESLO_REQUIRE_GLITCHTIP_RELEASE_ENV:\s*["']?1["']?/.test(text))
  );
};

const hasOrderedFragments = (text, fragments) => {
  let cursor = 0;
  for (const fragment of fragments) {
    const index = text.indexOf(fragment, cursor);
    if (index === -1) return false;
    cursor = index + fragment.length;
  }
  return true;
};

const hasForcedSidecarBuild = (text) => /VESLO_SIDECAR_FORCE_BUILD:\s*["']?1["']?/.test(text);

const findDeprecatedActionRefs = (actionRef, maxMajor = 4) => {
  const escaped = actionRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`uses:\\s*${escaped}@v([0-${maxMajor}])\\b`, "g");
  const refs = [];
  for (const workflow of activeWorkflows) {
    for (const match of workflow.text.matchAll(pattern)) {
      refs.push(`${workflow.name}: ${actionRef}@v${match[1]}`);
    }
  }
  return refs;
};

const setupNodeImplicitCacheGaps = () => {
  const gaps = [];
  for (const workflow of activeWorkflows) {
    const lines = workflow.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/uses:\s*actions\/setup-node@v[5-9]\b/.test(line)) continue;
      const setupIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      const stepIndent = line.trimStart().startsWith("- uses:") ? setupIndent : Math.max(0, setupIndent - 2);
      const nextStepPattern = new RegExp(`^ {${stepIndent}}-\\s+`);
      let end = lines.length;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (nextStepPattern.test(lines[next])) {
          end = next;
          break;
        }
      }
      const block = lines.slice(index, end).join("\n");
      if (!/^\s*node-version\s*:/m.test(block)) continue;
      if (/^\s*cache\s*:/m.test(block)) continue;
      if (/^\s*package-manager-cache\s*:\s*false\s*$/m.test(block)) continue;
      gaps.push(workflow.name);
    }
  }
  return gaps;
};

const hasWindowsBundledSidecarHashGate = (text, buildFragment = "Build Windows bundle") =>
  hasOrderedFragments(text, [
    buildFragment,
    "node scripts/release/verify-bundled-versions.mjs",
    "Verify Windows signatures",
  ]);

const hasWindowsMsiRuntimeGate = (text, buildFragment, publishFragment) =>
  hasOrderedFragments(text, [
    buildFragment,
    "node scripts/release/verify-bundled-versions.mjs",
    "Verify extracted MSI payload runtime",
    "verify-windows-msi-runtime.ps1",
    "Upload extracted Windows MSI payload verification",
    "Verify Windows signatures",
    publishFragment,
  ]) &&
  /if:\s*always\(\)/.test(text) &&
  /veslo-windows-msi-runtime-summary\.json/.test(text);

const hasWindowsStagingMsiRuntimeGate = (text) =>
  hasOrderedFragments(text, [
    "Build Windows staging MSI",
    "Verify bundled Windows staging sidecars",
    "verify-bundled-versions.mjs",
    "Verify extracted Windows staging MSI payload runtime",
    "verify-windows-msi-runtime.ps1",
    "Upload extracted Windows staging MSI payload verification",
    "Verify Windows staging signatures",
    "Upload staging app artifact",
  ]) &&
  /if:\s*always\(\)/.test(text) &&
  /veslo-windows-staging-msi-runtime-summary\.json/.test(text);

const hasPrereleaseMsiRuntimeMatrixPath = (text) =>
  /TARGET_TRIPLE:\s*\$\{\{\s*matrix\.target\s*\}\}/.test(text) &&
  /target\\\$env:TARGET_TRIPLE\\release\\bundle\\msi/.test(text) &&
  !/\$\{gha\}/.test(text);

const hasDocumentRuntimeMetadataGate = (text) =>
  /Verify document runtime package metadata/.test(text) &&
  /verify-document-runtime-packages\.mjs\s+--profile\s+remote-docs-only\s+--json/.test(text);

const hasMacosDocumentRuntimeBundleGate = (text) =>
  ["pnpm exec tauri -vvv build", "tauri-apps/tauri-action"].some((buildFragment) =>
    hasOrderedFragments(text, [
      "Install macOS document runtime resource",
      "node scripts/document-runtime/install-package-resource.mjs",
      "--platform \"${{ matrix.doc_runtime_platform }}\"",
      "Verify macOS document runtime bundle",
      "node scripts/release/verify-document-runtime-macos.mjs",
      "VESLO_DOCUMENT_RUNTIME_RELEASE_PROFILE",
      "--platform \"${{ matrix.doc_runtime_platform }}\"",
      buildFragment,
    ]),
  );

const hasWindowsDocumentRuntimePackageOnlyGate = (text) =>
  /Build Windows bundle/.test(text) &&
  !/node scripts\/document-runtime\/assemble-windows\.mjs/.test(text) &&
  !/node scripts\/release\/verify-document-runtime-windows\.mjs --profile local-docs-required --json/.test(text);

const releaseDocsText = [releaseDoc, stateConfigDoc, applicationLogsDoc].join("\n");
const releaseDocsDescribeGlitchTipDsn =
  /VESLO_GLITCHTIP_DSN/.test(releaseDocsText) &&
  /GitHub Actions variable/.test(releaseDocsText) &&
  /public/.test(releaseDocsText) &&
  /release-owned/.test(releaseDocsText) &&
  /not user-configurable/.test(releaseDocsText);
const releaseDocsDescribeNoWslInstallerContract =
  /Current Windows installers must not install, enable, repair, or import WSL\/VesloSandbox\./.test(
    stateConfigDoc,
  ) &&
  /The MSI contains no WSL payload, WiX\/NSIS setup hook, Active Setup continuation, or RunOnce repair path;/.test(
    stateConfigDoc,
  ) &&
  /The current installer deliberately contains no WSL provisioner, WSL helper, WiX\/NSIS WSL hook, Active Setup continuation, or onboarding\/Settings repair path\./.test(
    applicationLogsDoc,
  ) &&
  !/MSI package installs run the machine prerequisite phase as `SYSTEM`/.test(releaseDocsText) &&
  !/After reboot, Veslo registers a non-interactive user-context startup continuation through Active Setup\./.test(
    releaseDocsText,
  ) &&
  !/For clean-install WSL runtime setup issues/.test(releaseDocsText);

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
  "Windows MSI embeds WebView2 bootstrapper for fresh installs",
  tauriWindowsWebviewInstallMode.type === "embedBootstrapper",
  `${tauriWindowsWebviewInstallMode.type ?? "?"}`,
);
const hasBundledWslSandboxPayload = windowsInstallerConfigs.some((config) =>
  Object.entries(config.bundle?.resources ?? {}).some(([source, destination]) =>
    /(?:wsl2-|windows-wsl2-|veslosandbox)/i.test(`${source}\n${destination}`),
  ),
);

const hasBundledWslSandboxWix = windowsInstallerConfigs
  .flatMap((config) => {
    const wix = config.bundle?.windows?.wix ?? {};
    return [...(wix.fragmentPaths ?? []), ...(wix.componentGroupRefs ?? [])];
  })
  .some((entry) => /(?:wsl|sandbox)/i.test(entry));

const hasBundledWslSandboxNsisHook = windowsInstallerConfigs
  .map((config) => config.bundle?.windows?.nsis?.installerHooks)
  .some((hook) => /(?:wsl|sandbox)/i.test(hook ?? ""));

addCheck(
  "Windows MSI bundles desktop package manifest",
  tauriBundleResources["../package.json"] === "package.json" &&
    tauriWindowsReleaseBundleResources["../package.json"] === "package.json" &&
    existsSync(resolve(root, "packages", "desktop", "package.json")),
  tauriBundleResources["../package.json"] ?? "?",
);
addCheck(
  "Windows installers exclude WSL sandbox payload and setup hooks",
  !hasBundledWslSandboxPayload &&
    !hasBundledWslSandboxWix &&
    !hasBundledWslSandboxNsisHook,
  "no WSL resources, WiX fragments/component groups, or NSIS hooks",
);
addCheck(
  "Release docs describe the current non-WSL Windows installer contract",
  releaseDocsDescribeNoWslInstallerContract,
  "RELEASE.md + docs/dev",
);
addCheck(
  "macOS release builds embed GlitchTip DSN for frontend and native monitoring",
  hasGlitchTipReleaseEnv(releaseMacosTauriJob, { requireStrict: true }),
  ".github/workflows/release-macos-aarch64.yml#publish-tauri",
);
addCheck(
  "Windows release builds embed GlitchTip DSN for frontend and native monitoring",
  hasGlitchTipReleaseEnv(releaseWindowsTauriJob, { requireStrict: true }),
  ".github/workflows/release-macos-aarch64.yml#publish-tauri-windows",
);
addCheck(
  "Prerelease desktop builds embed GlitchTip DSN for frontend and native monitoring",
  hasGlitchTipReleaseEnv(prereleaseTauriJob, { requireStrict: true }),
  ".github/workflows/prerelease.yml#publish-tauri",
);
addCheck(
  "Manual Windows MSI workflows embed GlitchTip DSN for frontend and native monitoring",
  hasGlitchTipReleaseEnv(buildDesktopWorkflow) && hasGlitchTipReleaseEnv(buildWindowsMsiWorkflow),
  ".github/workflows/build-desktop.yml + .github/workflows/build-windows-msi.yml",
);
addCheck(
  "Release docs describe GlitchTip DSN as public and release-owned",
  releaseDocsDescribeGlitchTipDsn,
  "RELEASE.md + docs/dev",
);

const deprecatedCheckoutRefs = findDeprecatedActionRefs("actions/checkout");
addCheck(
  "Active workflows use Node 24 checkout action runtime",
  deprecatedCheckoutRefs.length === 0,
  deprecatedCheckoutRefs.length ? deprecatedCheckoutRefs.join(", ") : "no actions/checkout@v0-v4 refs",
);

const deprecatedSetupNodeRefs = findDeprecatedActionRefs("actions/setup-node");
addCheck(
  "Active workflows use Node 24 setup-node action runtime",
  deprecatedSetupNodeRefs.length === 0,
  deprecatedSetupNodeRefs.length ? deprecatedSetupNodeRefs.join(", ") : "no actions/setup-node@v0-v4 refs",
);

const deprecatedCacheRefs = findDeprecatedActionRefs("actions/cache");
addCheck(
  "Active workflows use Node 24 cache action runtime",
  deprecatedCacheRefs.length === 0,
  deprecatedCacheRefs.length ? deprecatedCacheRefs.join(", ") : "no actions/cache@v0-v4 refs",
);

const deprecatedUploadArtifactRefs = findDeprecatedActionRefs("actions/upload-artifact");
addCheck(
  "Active workflows use Node 24 upload-artifact action runtime",
  deprecatedUploadArtifactRefs.length === 0,
  deprecatedUploadArtifactRefs.length
    ? deprecatedUploadArtifactRefs.join(", ")
    : "no actions/upload-artifact@v0-v4 refs",
);

const deprecatedPnpmActionSetupRefs = findDeprecatedActionRefs("pnpm/action-setup");
addCheck(
  "Active workflows use Node 24 pnpm setup action runtime",
  deprecatedPnpmActionSetupRefs.length === 0,
  deprecatedPnpmActionSetupRefs.length
    ? deprecatedPnpmActionSetupRefs.join(", ")
    : "no pnpm/action-setup@v0-v4 refs",
);

const deprecatedSetupBunRefs = findDeprecatedActionRefs("oven-sh/setup-bun", 1);
addCheck(
  "Active workflows use Node 24 Bun setup action runtime",
  deprecatedSetupBunRefs.length === 0,
  deprecatedSetupBunRefs.length ? deprecatedSetupBunRefs.join(", ") : "no oven-sh/setup-bun@v0-v1 refs",
);

const setupNodeCacheGaps = setupNodeImplicitCacheGaps();
addCheck(
  "Setup Node implicit package-manager cache is disabled",
  setupNodeCacheGaps.length === 0,
  setupNodeCacheGaps.length ? setupNodeCacheGaps.join(", ") : "package-manager-cache=false or explicit cache",
);

addCheck(
  "Release workflow validates document runtime metadata before build",
  hasDocumentRuntimeMetadataGate(releaseVerifyJob),
  ".github/workflows/release-macos-aarch64.yml#verify-release",
);
addCheck(
  "Release workflow verifies macOS document runtime before Tauri build",
  hasMacosDocumentRuntimeBundleGate(releaseMacosTauriJob),
  ".github/workflows/release-macos-aarch64.yml#publish-tauri",
);
addCheck(
  "Release workflow keeps Windows document runtime outside the MSI",
  hasWindowsDocumentRuntimePackageOnlyGate(releaseWindowsTauriJob),
  ".github/workflows/release-macos-aarch64.yml#publish-tauri-windows",
);
addCheck(
  "Prerelease workflow verifies macOS document runtime before Tauri build",
  hasMacosDocumentRuntimeBundleGate(prereleaseTauriJob),
  ".github/workflows/prerelease.yml#publish-tauri",
);
addCheck(
  "Release desktop jobs force source sidecar rebuilds",
  hasForcedSidecarBuild(releaseMacosTauriJob) && hasForcedSidecarBuild(releaseWindowsTauriJob),
  ".github/workflows/release-macos-aarch64.yml#publish-tauri + #publish-tauri-windows",
);
addCheck(
  "Prerelease desktop job forces source sidecar rebuilds",
  hasForcedSidecarBuild(prereleaseTauriJob),
  ".github/workflows/prerelease.yml#publish-tauri",
);
addCheck(
  "Manual Windows MSI jobs force source sidecar rebuilds",
  hasForcedSidecarBuild(buildDesktopWindowsMsiJob) && hasForcedSidecarBuild(buildWindowsMsiJob),
  ".github/workflows/build-desktop.yml + .github/workflows/build-windows-msi.yml",
);
addCheck(
  "Release Windows workflow verifies bundled sidecar hashes after build",
  hasWindowsBundledSidecarHashGate(releaseWindowsTauriJob),
  ".github/workflows/release-macos-aarch64.yml#publish-tauri-windows",
);
addCheck(
  "Prerelease Windows workflow verifies bundled sidecar hashes after build",
  hasWindowsBundledSidecarHashGate(
    prereleaseTauriJob,
    "Build Windows MSI",
  ),
  ".github/workflows/prerelease.yml#publish-tauri",
);
addCheck(
  "Manual Windows MSI workflows verify bundled sidecar hashes after build",
  hasWindowsBundledSidecarHashGate(buildDesktopWindowsMsiJob, "Build Windows MSI") &&
    hasWindowsBundledSidecarHashGate(buildWindowsMsiJob, "Build Windows MSI"),
  ".github/workflows/build-desktop.yml + .github/workflows/build-windows-msi.yml",
);
addCheck(
  "Release Windows workflow validates the final MSI before publish",
  hasWindowsMsiRuntimeGate(releaseWindowsTauriJob, "Build Windows bundle", "Upload Windows release assets"),
  ".github/workflows/release-macos-aarch64.yml#publish-tauri-windows",
);
addCheck(
  "Prerelease Windows workflow validates the final MSI before publish",
  hasWindowsMsiRuntimeGate(
    prereleaseTauriJob,
    "Build Windows MSI",
    "Upload Windows prerelease assets",
  ),
  ".github/workflows/prerelease.yml#publish-tauri",
);
addCheck(
  "Prerelease MSI runtime gate resolves the matrix target",
  hasPrereleaseMsiRuntimeMatrixPath(prereleaseTauriJob),
  ".github/workflows/prerelease.yml#publish-tauri",
);
addCheck(
  "Manual Windows MSI workflows validate the final MSI before artifact upload",
  hasWindowsMsiRuntimeGate(buildDesktopWindowsMsiJob, "Build Windows MSI", "Upload MSI artifact") &&
    hasWindowsMsiRuntimeGate(buildWindowsMsiJob, "Build Windows MSI", "Upload MSI artifact"),
  ".github/workflows/build-desktop.yml + .github/workflows/build-windows-msi.yml",
);
addCheck(
  "Staging Windows workflow validates the final MSI before artifact upload",
  hasWindowsStagingMsiRuntimeGate(buildStagingJob),
  ".github/workflows/build-staging-app.yml#build",
);
const nsisCzechLanguagePath = resolve(
  root,
  "packages",
  "desktop",
  "src-tauri",
  "windows",
  "locales",
  "Czech.nsh",
);
const nsisCzechLanguage = existsSync(nsisCzechLanguagePath) ? readText(nsisCzechLanguagePath) : "";
addCheck(
  "Windows NSIS installer is current-user without WSL setup hook",
  tauriWindowsNsis.installMode === "currentUser" &&
    Array.isArray(tauriWindowsNsis.languages) &&
    tauriWindowsNsis.languages[0] === "Czech" &&
    tauriWindowsNsis.languages.includes("English") &&
    tauriWindowsNsis.customLanguageFiles?.Czech === "windows/locales/Czech.nsh" &&
    /LangString\s+alreadyInstalled\s+\$\{LANG_CZECH\}/.test(nsisCzechLanguage) &&
    /LangString\s+webview2InstallSuccess\s+\$\{LANG_CZECH\}/.test(nsisCzechLanguage) &&
    /LangString\s+deleteAppData\s+\$\{LANG_CZECH\}/.test(nsisCzechLanguage) &&
    !tauriWindowsNsis.installerHooks,
  `${tauriWindowsNsis.installMode ?? "?"}; ${tauriWindowsNsis.installerHooks ?? "none"}`,
);
const supervisedProcessPath = resolve(root, "packages", "desktop", "src-tauri", "src", "supervised_process.rs");
const supervisedProcess = existsSync(supervisedProcessPath) ? readText(supervisedProcessPath) : "";
const windowsPlatformPath = resolve(root, "packages", "desktop", "src-tauri", "src", "platform", "windows.rs");
const windowsPlatform = existsSync(windowsPlatformPath) ? readText(windowsPlatformPath) : "";
addCheck(
  "Windows runtime sidecars launch without console windows",
  /const\s+CREATE_NO_WINDOW:\s*u32\s*=\s*0x0800_0000/.test(supervisedProcess) &&
    /command\.creation_flags\(CREATE_NO_WINDOW\)/.test(supervisedProcess) &&
    /pub fn spawn\(self\)[\s\S]*?spawn_hidden_command/.test(supervisedProcess) &&
    /pub fn configure_hidden[\s\S]*?command\.creation_flags\(CREATE_NO_WINDOW\)/.test(windowsPlatform),
  "CREATE_NO_WINDOW",
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
