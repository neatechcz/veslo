import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  documentRuntimePackageAssetName,
  documentRuntimePackageSignatureName,
} from "../../packages/document-runtime/src/index.mjs";
import { verifyDocumentRuntimeWindows } from "./verify-document-runtime-windows.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const sha = (char) => char.repeat(64);

const writeText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
};

const manifest = {
  schemaVersion: 1,
  packageId: "veslo-document-runtime",
  runtimeId: "veslo-document-runtime",
  packageVersion: "2026.7.0",
  version: "2026.7.0",
  platform: "windows-native-x64",
  channel: "stable",
  minimumAppVersion: "2026.7.0",
  tools: {
    soffice: "24.8.x",
    pandoc: "3.6.x",
    poppler: "24.x",
    qpdf: "11.x",
    python: "3.11.x",
    node: "22.x",
  },
  manifestSha256: sha("1"),
  pythonPackagesHash: sha("2"),
  nodePackagesHash: sha("3"),
  fontsHash: sha("4"),
};

const feedFor = (entry) => ({
  schemaVersion: 1,
  packageId: "veslo-document-runtime",
  releaseTag: "v2026.7.0",
  channel: "stable",
  generatedAt: "2026-07-02T00:00:00Z",
  packages: [entry],
});

const windowsEntry = {
  packageId: "veslo-document-runtime",
  packageVersion: "2026.7.0",
  platform: "windows-native-x64",
  channel: "stable",
  minimumAppVersion: "2026.7.0",
  artifactName: "veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg",
  url: "https://github.com/neatechcz/veslo-updates/releases/download/v2026.7.0/veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg",
  signature: "trusted-minisign-signature",
  contentSha256: sha("a"),
  manifestSha256: sha("1"),
  sizeBytes: 12,
};

test("passes when local-docs-required Windows package and signature are present", () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-doc-runtime-win-"));
  try {
    const manifestPath = join(root, "windows-native-x64.json");
    const feedPath = join(root, "document-runtime-packages.json");
    const packageDir = join(root, "packages");
    const packageName = documentRuntimePackageAssetName({
      platform: "windows-native-x64",
      packageVersion: "2026.7.0",
    });
    const sigName = documentRuntimePackageSignatureName({
      platform: "windows-native-x64",
      packageVersion: "2026.7.0",
    });
    writeText(manifestPath, JSON.stringify(manifest, null, 2));
    writeText(feedPath, JSON.stringify(feedFor(windowsEntry), null, 2));
    writeText(join(packageDir, packageName), "package-bytes");
    writeText(join(packageDir, sigName), "signature");

    const report = verifyDocumentRuntimeWindows({
      repoRoot,
      manifestPath,
      feedPath,
      packageDir,
      profile: "local-docs-required",
    });

    assert.equal(report.ok, true);
    assert.equal(report.checks.find((check) => check.label === "Windows native document runtime package artifact exists")?.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails local-docs-required Windows release when package artifact is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-doc-runtime-win-missing-"));
  try {
    const manifestPath = join(root, "windows-native-x64.json");
    const feedPath = join(root, "document-runtime-packages.json");
    const packageDir = join(root, "packages");
    writeText(manifestPath, JSON.stringify(manifest, null, 2));
    writeText(feedPath, JSON.stringify(feedFor(windowsEntry), null, 2));

    const report = verifyDocumentRuntimeWindows({
      repoRoot,
      manifestPath,
      feedPath,
      packageDir,
      profile: "local-docs-required",
    });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.label === "Windows native document runtime package artifact exists")?.ok, false);
    assert.equal(report.checks.find((check) => check.label === "Windows native document runtime package signature exists")?.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allows explicit remote-docs-only profile without local package artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-doc-runtime-win-remote-"));
  try {
    const manifestPath = join(root, "windows-native-x64.json");
    const feedPath = join(root, "document-runtime-packages.json");
    writeText(manifestPath, JSON.stringify(manifest, null, 2));
    writeText(feedPath, JSON.stringify(feedFor(windowsEntry), null, 2));

    const report = verifyDocumentRuntimeWindows({
      repoRoot,
      manifestPath,
      feedPath,
      packageDir: join(root, "missing"),
      profile: "remote-docs-only",
    });

    assert.equal(report.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo Windows installer policy keeps WSL document runtime path dormant", () => {
  const report = verifyDocumentRuntimeWindows({
    repoRoot,
    profile: "remote-docs-only",
  });

  assert.equal(
    report.checks.find((check) => check.label === "Windows document runtime keeps WSL installer disabled by default")?.ok,
    true,
  );
  assert.equal(
    report.checks.find((check) => check.label === "Windows document runtime does not use WSL scripts as package readiness")?.ok,
    true,
  );
});

test("CLI emits JSON report on Windows document runtime verification", () => {
  const output = execFileSync(
    "node",
    ["scripts/release/verify-document-runtime-windows.mjs", "--profile", "remote-docs-only", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  const report = JSON.parse(output);
  assert.equal(report.ok, true);
  assert.equal(report.profile, "remote-docs-only");
  assert.equal(report.platform, "windows-native-x64");
});
