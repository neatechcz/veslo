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
import { verifyDocumentRuntimeMacos } from "./verify-document-runtime-macos.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const sha = (char) => char.repeat(64);

const writeText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
};

const manifestFor = (platform, marker) => ({
  schemaVersion: 1,
  packageId: "veslo-document-runtime",
  runtimeId: "veslo-document-runtime",
  packageVersion: "2026.7.0",
  version: "2026.7.0",
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

const entryFor = (platform, marker) => ({
  packageId: "veslo-document-runtime",
  packageVersion: "2026.7.0",
  platform,
  channel: "stable",
  minimumAppVersion: "2026.7.0",
  artifactName: documentRuntimePackageAssetName({ platform, packageVersion: "2026.7.0" }),
  url: `https://github.com/neatechcz/veslo-updates/releases/download/v2026.7.0/${documentRuntimePackageAssetName({
    platform,
    packageVersion: "2026.7.0",
  })}`,
  signature: "trusted-minisign-signature",
  contentSha256: sha(marker),
  manifestSha256: sha(marker),
  sizeBytes: 12,
});

const writeFixture = ({ withArtifacts }) => {
  const root = mkdtempSync(join(tmpdir(), "veslo-doc-runtime-macos-"));
  const manifestRoot = join(root, "manifests");
  const packageDir = join(root, "packages");
  const platforms = ["macos-arm64", "macos-x64"];

  for (const [index, platform] of platforms.entries()) {
    const marker = index === 0 ? "a" : "b";
    writeText(join(manifestRoot, `${platform}.json`), JSON.stringify(manifestFor(platform, marker), null, 2));
    if (withArtifacts) {
      const packageName = documentRuntimePackageAssetName({ platform, packageVersion: "2026.7.0" });
      const sigName = documentRuntimePackageSignatureName({ platform, packageVersion: "2026.7.0" });
      writeText(join(packageDir, packageName), "package-bytes");
      writeText(join(packageDir, sigName), "signature");
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
        packages: [entryFor("macos-arm64", "a"), entryFor("macos-x64", "b")],
      },
      null,
      2,
    ),
  );

  return { root, manifestRoot, packageDir, feedPath };
};

test("passes when local-docs-required macOS packages and signatures are present", () => {
  const fixture = writeFixture({ withArtifacts: true });
  try {
    const report = verifyDocumentRuntimeMacos({
      repoRoot,
      manifestRoot: fixture.manifestRoot,
      feedPath: fixture.feedPath,
      packageDir: fixture.packageDir,
      profile: "local-docs-required",
    });

    assert.equal(report.ok, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails local-docs-required macOS release when package artifacts are missing", () => {
  const fixture = writeFixture({ withArtifacts: false });
  try {
    const report = verifyDocumentRuntimeMacos({
      repoRoot,
      manifestRoot: fixture.manifestRoot,
      feedPath: fixture.feedPath,
      packageDir: fixture.packageDir,
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
