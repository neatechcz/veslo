import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  documentRuntimePackageAssetName,
  documentRuntimePackageSignatureName,
} from "../../packages/document-runtime/src/index.mjs";
import { verifyDocumentRuntime } from "./verify-document-runtime.mjs";
import { verifyDocumentRuntimePackages } from "./verify-document-runtime-packages.mjs";
import { verifyDocumentRuntimePolicy } from "./verify-document-runtime-policy.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const packageVersion = "2026.7.0";

const writeText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
};

const writePackagePair = (dir, platform) => {
  const artifact = documentRuntimePackageAssetName({ platform, packageVersion });
  const signature = documentRuntimePackageSignatureName({ platform, packageVersion });
  writeText(join(dir, artifact), `${platform} package bytes`);
  writeText(join(dir, signature), `${platform} signature`);
};

test("aggregate package gate passes only when all local runtime artifacts are present", () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-doc-runtime-aggregate-"));
  try {
    const windowsPackageDir = join(root, "windows");
    const macosPackageDir = join(root, "macos");
    writePackagePair(windowsPackageDir, "windows-native-x64");
    writePackagePair(macosPackageDir, "macos-arm64");
    writePackagePair(macosPackageDir, "macos-x64");

    const report = verifyDocumentRuntimePackages({
      repoRoot,
      profile: "local-docs-required",
      windowsPackageDir,
      macosPackageDir,
    });

    assert.equal(report.ok, true);
    assert.equal(report.checks.some((check) => check.scope === "windows" && !check.ok), false);
    assert.equal(report.checks.some((check) => check.scope === "macos" && !check.ok), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregate package gate fails normal releases when any platform artifact is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-doc-runtime-aggregate-missing-"));
  try {
    const windowsPackageDir = join(root, "windows");
    const macosPackageDir = join(root, "macos");
    writePackagePair(windowsPackageDir, "windows-native-x64");
    writePackagePair(macosPackageDir, "macos-arm64");

    const report = verifyDocumentRuntimePackages({
      repoRoot,
      profile: "local-docs-required",
      windowsPackageDir,
      macosPackageDir,
    });

    assert.equal(report.ok, false);
    assert.equal(
      report.checks.find((check) => check.scope === "macos" && check.label === "macOS document runtime package artifact exists for macos-x64")?.ok,
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("top-level document runtime gate delegates to package verification", () => {
  const report = verifyDocumentRuntime({
    repoRoot,
    profile: "remote-docs-only",
  });

  assert.equal(report.ok, true);
  assert.equal(report.packages.ok, true);
  assert.equal(report.profile, "remote-docs-only");
});

test("document runtime policy gate keeps Windows WSL path dormant", () => {
  const report = verifyDocumentRuntimePolicy({ repoRoot });

  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 2);
  assert.equal(report.checks.every((check) => check.scope === "windows" && check.ok), true);
});

test("aggregate package gate CLI emits JSON", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/release/verify-document-runtime-packages.mjs", "--profile", "remote-docs-only", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.profile, "remote-docs-only");
  assert.equal(report.reports.windows.ok, true);
  assert.equal(report.reports.macos.ok, true);
});
