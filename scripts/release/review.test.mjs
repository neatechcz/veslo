import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("release review verifies the veslo-code-router dependency pin", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const check = report.checks.find(
    (entry) =>
      entry.label === "Veslo-code-router dependency matches router version",
  );

  assert.ok(
    check,
    "expected release review to report the veslo-code-router dependency check",
  );
  assert.equal(check.ok, true);
});

test("release review verifies the Windows MSI version derived from CalVer", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const check = report.checks.find(
    (entry) =>
      entry.label === "Windows MSI version matches derived CalVer mapping",
  );

  assert.ok(
    check,
    "expected release review to report the Windows MSI version check",
  );
  assert.equal(check.ok, true);
});

test("release review requires a supported WebView2 fresh-install mode", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const check = report.checks.find(
    (entry) =>
      entry.label ===
      "Windows MSI embeds WebView2 bootstrapper for fresh installs",
  );

  assert.ok(
    check,
    "expected release review to report the WebView2 fresh-install check",
  );
  assert.equal(check.ok, true);
  assert.match(
    readFileSync(scriptPath, "utf8"),
    /tauriWindowsWebviewInstallMode\.type === "embedBootstrapper"/,
  );
});

test("release review verifies Windows installers exclude WSL sandbox setup", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const labels = new Set(report.checks.map((entry) => entry.label));

  for (const label of [
    "Windows MSI bundles desktop package manifest",
    "Windows installers exclude WSL sandbox payload and setup hooks",
    "Windows NSIS installer is current-user without WSL setup hook",
    "Release docs describe the current non-WSL Windows installer contract",
  ]) {
    assert.ok(labels.has(label), `expected release review to report: ${label}`);
    assert.equal(
      report.checks.find((entry) => entry.label === label)?.ok,
      true,
    );
  }
});

test("release review verifies GlitchTip release monitoring wiring", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const labels = new Set(report.checks.map((entry) => entry.label));

  for (const label of [
    "macOS release builds embed GlitchTip DSN for frontend and native monitoring",
    "Windows release builds embed GlitchTip DSN for frontend and native monitoring",
    "Prerelease desktop builds embed GlitchTip DSN for frontend and native monitoring",
    "Manual Windows MSI workflows embed GlitchTip DSN for frontend and native monitoring",
    "Release docs describe GlitchTip DSN as public and release-owned",
    "Publish workflows fail closed for GlitchTip source-map upload",
    "Tauri bundles the injected hidden-source-map frontend build",
    "Staging renderer canary is opt-in and absent from regular desktop builds",
  ]) {
    assert.ok(labels.has(label), `expected release review to report: ${label}`);
    assert.equal(
      report.checks.find((entry) => entry.label === label)?.ok,
      true,
    );
  }

  const reviewSource = readFileSync(scriptPath, "utf8");
  assert.match(
    reviewSource,
    /extractWorkflowJob\(releaseWorkflow,\s*"publish-tauri"\)/,
  );
  assert.match(
    reviewSource,
    /extractWorkflowJob\(releaseWorkflow,\s*"publish-tauri-windows"\)/,
  );
  assert.match(
    reviewSource,
    /extractWorkflowJob\(prereleaseWorkflow,\s*"publish-tauri"\)/,
  );
  assert.match(
    reviewSource,
    /hasGlitchTipReleaseEnv\(releaseMacosTauriJob,\s*\{\s*requireStrict:\s*true\s*\}\)/,
  );
  assert.match(
    reviewSource,
    /hasGlitchTipReleaseEnv\(releaseWindowsTauriJob,\s*\{\s*requireStrict:\s*true\s*\}\)/,
  );
  assert.match(
    reviewSource,
    /hasGlitchTipReleaseEnv\(prereleaseTauriJob,\s*\{\s*requireStrict:\s*true\s*\}\)/,
  );
  assert.match(reviewSource, /hasGlitchTipSourceMapUpload\(releaseMacosTauriJob\)/);
  assert.match(reviewSource, /hasGlitchTipSourceMapUpload\(releaseWindowsTauriJob\)/);
  assert.match(reviewSource, /hasGlitchTipSourceMapUpload\(prereleaseTauriJob\)/);
});

test("release review verifies document runtime metadata preflight and desktop bundle gates", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const metadataCheck = report.checks.find(
    (entry) =>
      entry.label ===
      "Release workflow validates document runtime metadata before build",
  );
  const windowsCheck = report.checks.find(
    (entry) =>
      entry.label ===
      "Release workflow keeps Windows document runtime outside the MSI",
  );
  const macosCheck = report.checks.find(
    (entry) =>
      entry.label ===
      "Release workflow verifies macOS document runtime before Tauri build",
  );
  const prereleaseMacosCheck = report.checks.find(
    (entry) =>
      entry.label ===
      "Prerelease workflow verifies macOS document runtime before Tauri build",
  );

  assert.ok(
    metadataCheck,
    "expected release review to report the document runtime metadata check",
  );
  assert.equal(metadataCheck.ok, true);
  assert.ok(
    macosCheck,
    "expected release review to report the macOS document runtime bundle check",
  );
  assert.equal(macosCheck.ok, true);
  assert.ok(
    windowsCheck,
    "expected release review to report the Windows document runtime package-only check",
  );
  assert.equal(windowsCheck.ok, true);
  assert.ok(
    prereleaseMacosCheck,
    "expected release review to report the prerelease macOS document runtime bundle check",
  );
  assert.equal(prereleaseMacosCheck.ok, true);

  const workflow = readFileSync(
    resolve(
      import.meta.dirname,
      "../../.github/workflows/release-macos-aarch64.yml",
    ),
    "utf8",
  );
  assert.match(
    workflow,
    /Verify document runtime package metadata[\s\S]*node scripts\/release\/verify-document-runtime-packages\.mjs --profile remote-docs-only --json/,
  );
  assert.match(
    workflow,
    /Install macOS document runtime resource[\s\S]*mkdir -p "packages\/desktop\/src-tauri\/resources\/document-runtime\/\$\{\{ matrix\.doc_runtime_platform \}\}"[\s\S]*install-package-resource\.mjs[\s\S]*Verify macOS document runtime bundle[\s\S]*verify-document-runtime-macos\.mjs[\s\S]*VESLO_DOCUMENT_RUNTIME_RELEASE_PROFILE[\s\S]*pnpm exec tauri -vvv build/,
  );
  assert.doesNotMatch(workflow, /Assemble Windows document runtime/);
  assert.doesNotMatch(
    workflow,
    /verify-document-runtime-windows\.mjs --profile local-docs-required --json/,
  );
  assert.match(workflow, /Build Windows bundle/);
  const prereleaseWorkflow = readFileSync(
    resolve(import.meta.dirname, "../../.github/workflows/prerelease.yml"),
    "utf8",
  );
  assert.match(
    prereleaseWorkflow,
    /Install macOS document runtime resource[\s\S]*mkdir -p "packages\/desktop\/src-tauri\/resources\/document-runtime\/\$\{\{ matrix\.doc_runtime_platform \}\}"[\s\S]*install-package-resource\.mjs[\s\S]*Verify macOS document runtime bundle[\s\S]*verify-document-runtime-macos\.mjs[\s\S]*VESLO_DOCUMENT_RUNTIME_RELEASE_PROFILE[\s\S]*tauri-apps\/tauri-action/,
  );

  const reviewSource = readFileSync(scriptPath, "utf8");
  assert.match(
    reviewSource,
    /extractWorkflowJob\(releaseWorkflow,\s*"verify-release"\)/,
  );
  assert.match(
    reviewSource,
    /hasDocumentRuntimeMetadataGate\(releaseVerifyJob\)/,
  );
  assert.match(
    reviewSource,
    /hasMacosDocumentRuntimeBundleGate\(releaseMacosTauriJob\)/,
  );
  assert.match(
    reviewSource,
    /hasWindowsDocumentRuntimePackageOnlyGate\(releaseWindowsTauriJob\)/,
  );
  assert.match(
    reviewSource,
    /hasMacosDocumentRuntimeBundleGate\(prereleaseTauriJob\)/,
  );
});

test("release review rejects Node 20 GitHub action runtime pins", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  for (const label of [
    "Active workflows use Node 24 checkout action runtime",
    "Active workflows use Node 24 setup-node action runtime",
    "Active workflows use Node 24 cache action runtime",
    "Active workflows use Node 24 upload-artifact action runtime",
    "Active workflows use Node 24 pnpm setup action runtime",
    "Active workflows use Node 24 Bun setup action runtime",
    "Setup Node implicit package-manager cache is disabled",
  ]) {
    const check = report.checks.find((entry) => entry.label === label);
    assert.ok(check, `expected release review to report: ${label}`);
    assert.equal(check.ok, true);
  }

  const workflowRoot = resolve(import.meta.dirname, "../../.github/workflows");
  const activeWorkflowPaths = [
    "release-macos-aarch64.yml",
    "prerelease.yml",
    "build-desktop.yml",
    "build-windows-msi.yml",
    "build-staging-app.yml",
    "ci.yml",
    "ci-tests.yml",
    "e2e-ui.yml",
    "download-stats.yml",
    "opencode-agents.yml",
  ];
  const workflows = activeWorkflowPaths
    .map((name) => readFileSync(resolve(workflowRoot, name), "utf8"))
    .join("\n");

  assert.doesNotMatch(workflows, /actions\/checkout@v[0-4]\b/);
  assert.doesNotMatch(workflows, /actions\/setup-node@v[0-4]\b/);
  assert.doesNotMatch(workflows, /actions\/cache@v[0-4]\b/);
  assert.doesNotMatch(workflows, /actions\/upload-artifact@v[0-4]\b/);
  assert.doesNotMatch(workflows, /pnpm\/action-setup@v[0-4]\b/);
  assert.doesNotMatch(workflows, /oven-sh\/setup-bun@v[0-1]\b/);
  assert.match(workflows, /actions\/checkout@v7\b/);
  assert.match(workflows, /actions\/setup-node@v7\b/);
  assert.match(workflows, /actions\/cache@v6\b/);
  assert.match(workflows, /actions\/upload-artifact@v7\b/);
  assert.match(workflows, /pnpm\/action-setup@v6\b/);
  assert.match(workflows, /oven-sh\/setup-bun@v2\b/);
});

test("release review verifies installer workflows force sidecar rebuilds from source", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  for (const label of [
    "Release desktop jobs force source sidecar rebuilds",
    "Prerelease desktop job forces source sidecar rebuilds",
    "Manual Windows MSI jobs force source sidecar rebuilds",
    "Release Windows workflow verifies bundled sidecar hashes after build",
    "Prerelease Windows workflow verifies bundled sidecar hashes after build",
    "Manual Windows MSI workflows verify bundled sidecar hashes after build",
    "Release Windows workflow validates the final MSI before publish",
    "Prerelease Windows workflow validates the final MSI before publish",
    "Prerelease MSI runtime gate resolves the matrix target",
    "Manual Windows MSI workflows validate the final MSI before artifact upload",
    "Staging Windows workflow validates the final MSI before artifact upload",
  ]) {
    const check = report.checks.find((entry) => entry.label === label);
    assert.ok(check, `expected release review to report: ${label}`);
    assert.equal(check.ok, true);
  }

  const releaseWorkflow = readFileSync(
    resolve(
      import.meta.dirname,
      "../../.github/workflows/release-macos-aarch64.yml",
    ),
    "utf8",
  );
  const prereleaseWorkflow = readFileSync(
    resolve(import.meta.dirname, "../../.github/workflows/prerelease.yml"),
    "utf8",
  );
  const buildDesktopWorkflow = readFileSync(
    resolve(import.meta.dirname, "../../.github/workflows/build-desktop.yml"),
    "utf8",
  );
  const buildWindowsMsiWorkflow = readFileSync(
    resolve(
      import.meta.dirname,
      "../../.github/workflows/build-windows-msi.yml",
    ),
    "utf8",
  );
  const buildStagingWorkflow = readFileSync(
    resolve(import.meta.dirname, "../../.github/workflows/build-staging-app.yml"),
    "utf8",
  );

  assert.match(
    releaseWorkflow,
    /publish-tauri:[\s\S]*?VESLO_SIDECAR_FORCE_BUILD:\s*"1"[\s\S]*?publish-tauri-windows:[\s\S]*?VESLO_SIDECAR_FORCE_BUILD:\s*"1"/,
  );
  assert.match(
    releaseWorkflow,
    /Build Windows bundle[\s\S]*?verify-bundled-versions\.mjs[\s\S]*?Verify extracted MSI payload runtime[\s\S]*?verify-windows-msi-runtime\.ps1[\s\S]*?Upload extracted Windows MSI payload verification[\s\S]*?Verify Windows signatures[\s\S]*?Upload Windows release assets/,
  );
  assert.match(
    prereleaseWorkflow,
    /publish-tauri:[\s\S]*?VESLO_SIDECAR_FORCE_BUILD:\s*"1"/,
  );
  assert.match(
    prereleaseWorkflow,
    /Build Windows MSI[\s\S]*?if: matrix\.os_type == 'windows'[\s\S]*?verify-bundled-versions\.mjs[\s\S]*?Verify extracted MSI payload runtime[\s\S]*?verify-windows-msi-runtime\.ps1[\s\S]*?Upload extracted Windows MSI payload verification[\s\S]*?Verify Windows signatures[\s\S]*?Upload Windows prerelease assets/,
  );
  assert.doesNotMatch(
    prereleaseWorkflow,
    /- name: Build \+ upload\s+if: matrix\.os_type == 'windows'[\s\S]*?tauri-apps\/tauri-action/,
  );
  assert.match(
    buildDesktopWorkflow,
    /build-windows-msi:[\s\S]*?VESLO_SIDECAR_FORCE_BUILD:\s*"1"/,
  );
  assert.match(
    buildDesktopWorkflow,
    /Build Windows MSI[\s\S]*?verify-bundled-versions\.mjs[\s\S]*?Verify extracted MSI payload runtime[\s\S]*?verify-windows-msi-runtime\.ps1[\s\S]*?Upload extracted Windows MSI payload verification[\s\S]*?Verify Windows signatures[\s\S]*?Upload MSI artifact/,
  );
  assert.match(
    buildWindowsMsiWorkflow,
    /build-windows-msi:[\s\S]*?VESLO_SIDECAR_FORCE_BUILD:\s*"1"/,
  );
  assert.match(
    buildWindowsMsiWorkflow,
    /Build Windows MSI[\s\S]*?verify-bundled-versions\.mjs[\s\S]*?Verify extracted MSI payload runtime[\s\S]*?verify-windows-msi-runtime\.ps1[\s\S]*?Upload extracted Windows MSI payload verification[\s\S]*?Verify Windows signatures[\s\S]*?Upload MSI artifact/,
  );
  assert.match(
    buildStagingWorkflow,
    /Build Windows staging MSI[\s\S]*?Verify bundled Windows staging sidecars[\s\S]*?verify-bundled-versions\.mjs[\s\S]*?Verify extracted Windows staging MSI payload runtime[\s\S]*?verify-windows-msi-runtime\.ps1[\s\S]*?Upload extracted Windows staging MSI payload verification[\s\S]*?Verify Windows staging signatures[\s\S]*?Upload staging app artifact/,
  );

  const reviewSource = readFileSync(scriptPath, "utf8");
  assert.match(reviewSource, /hasForcedSidecarBuild\(releaseMacosTauriJob\)/);
  assert.match(reviewSource, /hasForcedSidecarBuild\(releaseWindowsTauriJob\)/);
  assert.match(reviewSource, /hasForcedSidecarBuild\(prereleaseTauriJob\)/);
  assert.match(
    reviewSource,
    /hasWindowsBundledSidecarHashGate\(releaseWindowsTauriJob\)/,
  );
  assert.match(
    reviewSource,
    /hasWindowsBundledSidecarHashGate\(\s*prereleaseTauriJob/,
  );
  assert.match(
    reviewSource,
    /hasWindowsMsiRuntimeGate\(releaseWindowsTauriJob,\s*"Build Windows bundle",\s*"Upload Windows release assets"\)/,
  );
  assert.match(reviewSource, /hasWindowsMsiRuntimeGate\(\s*prereleaseTauriJob/);
  assert.match(
    reviewSource,
    /hasPrereleaseMsiRuntimeMatrixPath\(prereleaseTauriJob\)/,
  );
  assert.match(reviewSource, /hasWindowsStagingMsiRuntimeGate\(buildStagingJob\)/);
});
