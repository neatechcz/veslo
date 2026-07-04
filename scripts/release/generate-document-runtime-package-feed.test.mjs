import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  documentRuntimePackageAssetName,
  documentRuntimePackageSignatureName,
} from "../../packages/document-runtime/src/index.mjs";
import { generateDocumentRuntimePackageFeed } from "./generate-document-runtime-package-feed.mjs";

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

const writeFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-doc-runtime-feed-"));
  const manifestRoot = join(root, "manifests");
  const packageRoot = join(root, "packages");
  const platforms = ["windows-native-x64", "macos-arm64", "macos-x64"];
  for (const [index, platform] of platforms.entries()) {
    const marker = String(index + 1);
    writeText(join(manifestRoot, `${platform}.json`), JSON.stringify(manifestFor(platform, marker), null, 2));
    const packageName = documentRuntimePackageAssetName({ platform, packageVersion: "2026.7.0" });
    const sigName = documentRuntimePackageSignatureName({ platform, packageVersion: "2026.7.0" });
    writeText(join(packageRoot, platform, packageName), `${platform} package bytes`);
    writeText(join(packageRoot, platform, sigName), `${platform} signature`);
  }
  return { root, manifestRoot, packageRoot, platforms };
};

test("generates a validated document runtime package feed from local package artifacts", () => {
  const fixture = writeFixture();
  try {
    const feed = generateDocumentRuntimePackageFeed({
      tag: "v2026.7.0",
      repo: "neatechcz/veslo-updates",
      channel: "stable",
      packageRoot: fixture.packageRoot,
      manifestRoot: fixture.manifestRoot,
      generatedAt: "2026-07-02T00:00:00Z",
      platforms: fixture.platforms,
    });

    assert.equal(feed.packages.length, 3);
    assert.deepEqual(feed.packages.map((entry) => entry.platform), fixture.platforms);
    assert.match(feed.packages[0].url, /github\.com\/neatechcz\/veslo-updates\/releases\/download\/v2026\.7\.0/);
    assert.match(feed.packages[0].contentSha256, /^[a-f0-9]{64}$/);
    assert.equal(feed.packages[0].signature, "windows-native-x64 signature");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fails when a required runtime package artifact is missing", () => {
  const fixture = writeFixture();
  try {
    rmSync(join(fixture.packageRoot, "macos-x64"), { recursive: true, force: true });
    assert.throws(
      () =>
        generateDocumentRuntimePackageFeed({
          tag: "v2026.7.0",
          repo: "neatechcz/veslo-updates",
          channel: "stable",
          packageRoot: fixture.packageRoot,
          manifestRoot: fixture.manifestRoot,
          generatedAt: "2026-07-02T00:00:00Z",
          platforms: fixture.platforms,
        }),
      /Missing document runtime package artifact veslo-document-runtime-macos-x64-2026\.7\.0\.veslopkg/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI writes document-runtime-packages.json", () => {
  const fixture = writeFixture();
  try {
    const output = join(fixture.root, "document-runtime-packages.json");
    const stdout = execFileSync(
      "node",
      [
        "scripts/release/generate-document-runtime-package-feed.mjs",
        "--tag",
        "v2026.7.0",
        "--package-root",
        fixture.packageRoot,
        "--manifest-root",
        fixture.manifestRoot,
        "--generated-at",
        "2026-07-02T00:00:00Z",
        "--output",
        output,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    assert.match(stdout, /Wrote/);
    const feed = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(feed.packages.length, 3);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
