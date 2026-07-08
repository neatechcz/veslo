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
  const check = report.checks.find((entry) => entry.label === "Veslo-code-router dependency matches router version");

  assert.ok(check, "expected release review to report the veslo-code-router dependency check");
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
    (entry) => entry.label === "Windows MSI version matches derived CalVer mapping",
  );

  assert.ok(check, "expected release review to report the Windows MSI version check");
  assert.equal(check.ok, true);
});

test("release review verifies Windows installer WSL provisioning stays dormant by default", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const labels = new Set(report.checks.map((entry) => entry.label));

  for (const label of [
    "Windows MSI bundles desktop package manifest for WSL provisioning version pin",
    "Windows MSI bundles WSL sandbox provisioner",
    "Windows MSI bundles WSL prerequisite installer for first-run repair",
    "Windows MSI bundles WSL sandbox installer wrapper",
    "Windows MSI keeps WSL sandbox provisioning action dormant by default",
  ]) {
    assert.ok(labels.has(label), `expected release review to report: ${label}`);
    assert.equal(report.checks.find((entry) => entry.label === label)?.ok, true);
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
  ]) {
    assert.ok(labels.has(label), `expected release review to report: ${label}`);
    assert.equal(report.checks.find((entry) => entry.label === label)?.ok, true);
  }

  const reviewSource = readFileSync(scriptPath, "utf8");
  assert.match(reviewSource, /extractWorkflowJob\(releaseWorkflow,\s*"publish-tauri"\)/);
  assert.match(reviewSource, /extractWorkflowJob\(releaseWorkflow,\s*"publish-tauri-windows"\)/);
  assert.match(reviewSource, /extractWorkflowJob\(prereleaseWorkflow,\s*"publish-tauri"\)/);
  assert.match(reviewSource, /hasGlitchTipReleaseEnv\(releaseMacosTauriJob,\s*\{\s*requireStrict:\s*true\s*\}\)/);
  assert.match(reviewSource, /hasGlitchTipReleaseEnv\(releaseWindowsTauriJob,\s*\{\s*requireStrict:\s*true\s*\}\)/);
  assert.match(reviewSource, /hasGlitchTipReleaseEnv\(prereleaseTauriJob,\s*\{\s*requireStrict:\s*true\s*\}\)/);
});

test("release review verifies document runtime metadata preflight and desktop bundle gates", () => {
  const scriptPath = resolve(import.meta.dirname, "./review.mjs");
  const output = execFileSync("node", [scriptPath, "--json"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
  });

  const report = JSON.parse(output);
  const metadataCheck = report.checks.find(
    (entry) => entry.label === "Release workflow validates document runtime metadata before build",
  );
  const windowsCheck = report.checks.find(
    (entry) => entry.label === "Release workflow verifies Windows document runtime after assembly",
  );
  const macosCheck = report.checks.find(
    (entry) => entry.label === "Release workflow verifies macOS document runtime before Tauri build",
  );
  const prereleaseMacosCheck = report.checks.find(
    (entry) => entry.label === "Prerelease workflow verifies macOS document runtime before Tauri build",
  );

  assert.ok(metadataCheck, "expected release review to report the document runtime metadata check");
  assert.equal(metadataCheck.ok, true);
  assert.ok(macosCheck, "expected release review to report the macOS document runtime bundle check");
  assert.equal(macosCheck.ok, true);
  assert.ok(windowsCheck, "expected release review to report the Windows document runtime bundle check");
  assert.equal(windowsCheck.ok, true);
  assert.ok(prereleaseMacosCheck, "expected release review to report the prerelease macOS document runtime bundle check");
  assert.equal(prereleaseMacosCheck.ok, true);

  const workflow = readFileSync(
    resolve(import.meta.dirname, "../../.github/workflows/release-macos-aarch64.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /Verify document runtime package metadata[\s\S]*node scripts\/release\/verify-document-runtime-packages\.mjs --profile remote-docs-only --json/,
  );
  assert.match(
    workflow,
    /Install macOS document runtime resource[\s\S]*install-package-resource\.mjs[\s\S]*Verify macOS document runtime bundle[\s\S]*verify-document-runtime-macos\.mjs[\s\S]*--profile local-docs-required[\s\S]*pnpm exec tauri -vvv build/,
  );
  assert.match(
    workflow,
    /Assemble Windows document runtime[\s\S]*Verify Windows document runtime bundle[\s\S]*node scripts\/release\/verify-document-runtime-windows\.mjs --profile local-docs-required --json[\s\S]*Build Windows bundle/,
  );
  const prereleaseWorkflow = readFileSync(
    resolve(import.meta.dirname, "../../.github/workflows/prerelease.yml"),
    "utf8",
  );
  assert.match(
    prereleaseWorkflow,
    /Install macOS document runtime resource[\s\S]*install-package-resource\.mjs[\s\S]*Verify macOS document runtime bundle[\s\S]*verify-document-runtime-macos\.mjs[\s\S]*--profile local-docs-required[\s\S]*tauri-apps\/tauri-action/,
  );

  const reviewSource = readFileSync(scriptPath, "utf8");
  assert.match(reviewSource, /extractWorkflowJob\(releaseWorkflow,\s*"verify-release"\)/);
  assert.match(reviewSource, /hasDocumentRuntimeMetadataGate\(releaseVerifyJob\)/);
  assert.match(reviewSource, /hasMacosDocumentRuntimeBundleGate\(releaseMacosTauriJob\)/);
  assert.match(reviewSource, /hasWindowsDocumentRuntimeBundleGate\(releaseWindowsTauriJob\)/);
  assert.match(reviewSource, /hasMacosDocumentRuntimeBundleGate\(prereleaseTauriJob\)/);
});
