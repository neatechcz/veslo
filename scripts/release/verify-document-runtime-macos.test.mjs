import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  documentRuntimePackageAssetName,
  documentRuntimePackageSignatureName,
} from "../../packages/document-runtime/src/index.mjs";
import { verifyDocumentRuntimeMacos } from "./verify-document-runtime-macos.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const sha = (char) => char.repeat(64);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const writeText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
};

const manifestFor = (platform, marker, packageVersion = "2026.7.0") => ({
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
  manifestSha256: sha(marker),
  pythonPackagesHash: sha("2"),
  nodePackagesHash: sha("3"),
  fontsHash: sha("4"),
});

const packageBytesFor = (platform, packageVersion) => `${platform}:${packageVersion}:package-bytes`;

const entryFor = (platform, marker, packageVersion = "2026.7.0") => ({
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
  signature: "trusted-minisign-signature",
  contentSha256: sha256(packageBytesFor(platform, packageVersion)),
  manifestSha256: sha(marker),
  sizeBytes: 12,
});

const writeRuntimeResource = (resourceRoot, platform, marker, packageVersion = "2026.7.0") => {
  writeText(join(resourceRoot, platform, "manifest.json"), JSON.stringify(manifestFor(platform, marker, packageVersion), null, 2));
  for (const command of ["soffice", "pandoc", "pdftoppm", "pdftotext", "pdfimages", "qpdf", "python", "node", "weasyprint"]) {
    writeText(join(resourceRoot, platform, "bin", command), "binary");
  }
  writeText(join(resourceRoot, platform, "fonts", ".keep"), "");
  writeText(join(resourceRoot, platform, "python", ".keep"), "");
  writeText(join(resourceRoot, platform, "node_modules", ".keep"), "");
};

const writeFixture = ({ withArtifacts, withResources = withArtifacts, feedPackageVersion = "2026.7.0" }) => {
  const root = mkdtempSync(join(tmpdir(), "veslo-doc-runtime-macos-"));
  const manifestRoot = join(root, "manifests");
  const packageDir = join(root, "packages");
  const resourceRoot = join(root, "resources");
  const platforms = ["macos-arm64", "macos-x64"];

  for (const [index, platform] of platforms.entries()) {
    const marker = index === 0 ? "a" : "b";
    writeText(join(manifestRoot, `${platform}.json`), JSON.stringify(manifestFor(platform, marker), null, 2));
    if (withArtifacts) {
      const packageName = documentRuntimePackageAssetName({ platform, packageVersion: feedPackageVersion });
      const sigName = documentRuntimePackageSignatureName({ platform, packageVersion: feedPackageVersion });
      writeText(join(packageDir, packageName), packageBytesFor(platform, feedPackageVersion));
      writeText(join(packageDir, sigName), "trusted-minisign-signature");
    }
    if (withResources) {
      writeRuntimeResource(resourceRoot, platform, marker, feedPackageVersion);
    }
  }

  const feedPath = join(root, "document-runtime-packages.json");
  writeText(
    feedPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        packageId: "veslo-document-runtime",
        releaseTag: "v2026.7.0",
        channel: "stable",
        generatedAt: "2026-07-02T00:00:00Z",
        packages: [entryFor("macos-arm64", "a", feedPackageVersion), entryFor("macos-x64", "b", feedPackageVersion)],
      },
      null,
      2,
    ),
  );

  return { root, manifestRoot, packageDir, resourceRoot, feedPath };
};

test("passes when local-docs-required macOS packages and signatures are present", () => {
  const fixture = writeFixture({ withArtifacts: true });
  try {
    const report = verifyDocumentRuntimeMacos({
      repoRoot,
      manifestRoot: fixture.manifestRoot,
      feedPath: fixture.feedPath,
      packageDir: fixture.packageDir,
      resourceRoot: fixture.resourceRoot,
      profile: "local-docs-required",
    });

    assert.equal(report.ok, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("local-docs-required macOS verification follows the package feed version for bundled resources", () => {
  const fixture = writeFixture({ withArtifacts: true, feedPackageVersion: "2026.8.0" });
  try {
    const report = verifyDocumentRuntimeMacos({
      repoRoot,
      manifestRoot: fixture.manifestRoot,
      feedPath: fixture.feedPath,
      packageDir: fixture.packageDir,
      resourceRoot: fixture.resourceRoot,
      profile: "local-docs-required",
      platforms: ["macos-arm64"],
    });

    assert.equal(report.ok, true);
    assert.equal(
      report.checks.find((check) => check.label === "macOS bundled document runtime version matches package feed for macos-arm64")?.ok,
      true,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails local-docs-required macOS release when package artifacts are missing", () => {
  const fixture = writeFixture({ withArtifacts: false, withResources: false });
  try {
    const report = verifyDocumentRuntimeMacos({
      repoRoot,
      manifestRoot: fixture.manifestRoot,
      feedPath: fixture.feedPath,
      packageDir: fixture.packageDir,
      resourceRoot: fixture.resourceRoot,
      profile: "local-docs-required",
    });

    assert.equal(report.ok, false);
    assert.equal(
      report.checks.find((check) => check.label === "macOS document runtime package artifact exists for macos-arm64")?.ok,
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails local-docs-required macOS release when package hash or signature differs from feed", () => {
  const fixture = writeFixture({ withArtifacts: true });
  try {
    const packageName = documentRuntimePackageAssetName({ platform: "macos-arm64", packageVersion: "2026.7.0" });
    const sigName = documentRuntimePackageSignatureName({ platform: "macos-arm64", packageVersion: "2026.7.0" });
    writeText(join(fixture.packageDir, packageName), "tampered-package-bytes");
    writeText(join(fixture.packageDir, sigName), "tampered-signature");

    const report = verifyDocumentRuntimeMacos({
      repoRoot,
      manifestRoot: fixture.manifestRoot,
      feedPath: fixture.feedPath,
      packageDir: fixture.packageDir,
      resourceRoot: fixture.resourceRoot,
      profile: "local-docs-required",
      platforms: ["macos-arm64"],
    });

    assert.equal(report.ok, false);
    assert.equal(
      report.checks.find((check) => check.label === "macOS document runtime package sha256 matches feed for macos-arm64")?.ok,
      false,
    );
    assert.equal(
      report.checks.find((check) => check.label === "macOS document runtime package signature matches feed for macos-arm64")?.ok,
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("allows explicit remote-docs-only profile without local macOS artifacts", () => {
  const fixture = writeFixture({ withArtifacts: false });
  try {
    const report = verifyDocumentRuntimeMacos({
      repoRoot,
      manifestRoot: fixture.manifestRoot,
      feedPath: fixture.feedPath,
      packageDir: fixture.packageDir,
      profile: "remote-docs-only",
    });

    assert.equal(report.ok, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI emits JSON report on macOS document runtime verification", () => {
  const output = execFileSync(
    "node",
    ["scripts/release/verify-document-runtime-macos.mjs", "--profile", "remote-docs-only", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  const report = JSON.parse(output);
  assert.equal(report.ok, true);
  assert.equal(report.profile, "remote-docs-only");
  assert.deepEqual(report.platforms, ["macos-arm64", "macos-x64"]);
});
