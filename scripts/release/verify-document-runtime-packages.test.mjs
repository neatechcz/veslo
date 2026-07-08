import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  documentRuntimePackageAssetName,
  documentRuntimePackageSignatureName,
} from "../../packages/document-runtime/src/index.mjs";
import { assembleWindowsDocumentRuntime } from "../document-runtime/assemble-windows.mjs";
import { verifyDocumentRuntime } from "./verify-document-runtime.mjs";
import { verifyDocumentRuntimePackages } from "./verify-document-runtime-packages.mjs";
import { verifyDocumentRuntimePolicy } from "./verify-document-runtime-policy.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const packageVersion = "2026.7.0";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const writeText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
};

const writePackagePair = (dir, platform) => {
  const artifact = documentRuntimePackageAssetName({ platform, packageVersion });
  const signature = documentRuntimePackageSignatureName({ platform, packageVersion });
  const bytes = `${platform} package bytes`;
  writeText(join(dir, artifact), bytes);
  writeText(join(dir, signature), `${platform} signature`);
  return { artifact, signature, bytes };
};

const feedEntry = ({ platform, bytes, manifestSha256 }) => ({
  packageId: "veslo-document-runtime",
  packageVersion,
  platform,
  channel: "stable",
  minimumAppVersion: "2026.7.0",
  artifactName: documentRuntimePackageAssetName({ platform, packageVersion }),
  url: `https://github.com/neatechcz/veslo-updates/releases/download/v${packageVersion}/${documentRuntimePackageAssetName({
    platform,
    packageVersion,
  })}`,
  signature: `${platform} signature`,
  contentSha256: sha256(bytes),
  manifestSha256,
  sizeBytes: bytes.length,
});

const writeAggregateFeed = (path, entries) => {
  writeText(
    path,
    JSON.stringify(
      {
        schemaVersion: 1,
        packageId: "veslo-document-runtime",
        releaseTag: "v2026.7.0",
        channel: "stable",
        generatedAt: "2026-07-02T00:00:00Z",
        packages: entries,
      },
      null,
      2,
    ),
  );
};

const writeMacosResource = (root, platform) => {
  const marker = platform === "macos-arm64" ? "5" : "9";
  writeText(
    join(root, platform, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        packageId: "veslo-document-runtime",
        runtimeId: "veslo-document-runtime",
        packageVersion,
        version: packageVersion,
        platform,
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
        manifestSha256: marker.repeat(64),
        pythonPackagesHash: "6".repeat(64),
        nodePackagesHash: "7".repeat(64),
        fontsHash: "8".repeat(64),
      },
      null,
      2,
    ),
  );
  for (const command of ["soffice", "pandoc", "pdftoppm", "pdftotext", "pdfimages", "qpdf", "python", "node", "weasyprint"]) {
    writeText(join(root, platform, "bin", command), "binary");
  }
  writeText(join(root, platform, "fonts", ".keep"), "");
  writeText(join(root, platform, "python", ".keep"), "");
  writeText(join(root, platform, "node_modules", ".keep"), "");
};

test("aggregate package gate passes only when all local runtime artifacts are present", async () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-doc-runtime-aggregate-"));
  try {
    const windowsPackageDir = join(root, "windows-resource");
    const macosPackageDir = join(root, "macos");
    const macosResourceRoot = join(root, "macos-resource");
    const feedPath = join(root, "document-runtime-packages.json");
    await assembleWindowsDocumentRuntime({ targetDir: windowsPackageDir, dryRun: true });
    const arm64 = writePackagePair(macosPackageDir, "macos-arm64");
    const x64 = writePackagePair(macosPackageDir, "macos-x64");
    writeMacosResource(macosResourceRoot, "macos-arm64");
    writeMacosResource(macosResourceRoot, "macos-x64");
    writeAggregateFeed(feedPath, [
      feedEntry({ platform: "windows-native-x64", bytes: "windows package bytes", manifestSha256: "1".repeat(64) }),
      feedEntry({ platform: "macos-arm64", bytes: arm64.bytes, manifestSha256: "5".repeat(64) }),
      feedEntry({ platform: "macos-x64", bytes: x64.bytes, manifestSha256: "9".repeat(64) }),
    ]);

    const report = verifyDocumentRuntimePackages({
      repoRoot,
      profile: "local-docs-required",
      feedPath,
      windowsPackageDir,
      macosPackageDir,
      macosResourceRoot,
    });

    assert.equal(report.ok, true);
    assert.equal(report.checks.some((check) => check.scope === "windows" && !check.ok), false);
    assert.equal(report.checks.some((check) => check.scope === "macos" && !check.ok), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregate package gate fails normal releases when any platform artifact is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-doc-runtime-aggregate-missing-"));
  try {
    const windowsPackageDir = join(root, "windows-resource");
    const macosPackageDir = join(root, "macos");
    const macosResourceRoot = join(root, "macos-resource");
    const feedPath = join(root, "document-runtime-packages.json");
    await assembleWindowsDocumentRuntime({ targetDir: windowsPackageDir, dryRun: true });
    const arm64 = writePackagePair(macosPackageDir, "macos-arm64");
    writeMacosResource(macosResourceRoot, "macos-arm64");
    writeAggregateFeed(feedPath, [
      feedEntry({ platform: "windows-native-x64", bytes: "windows package bytes", manifestSha256: "1".repeat(64) }),
      feedEntry({ platform: "macos-arm64", bytes: arm64.bytes, manifestSha256: "5".repeat(64) }),
      feedEntry({ platform: "macos-x64", bytes: "missing package bytes", manifestSha256: "9".repeat(64) }),
    ]);

    const report = verifyDocumentRuntimePackages({
      repoRoot,
      profile: "local-docs-required",
      feedPath,
      windowsPackageDir,
      macosPackageDir,
      macosResourceRoot,
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
