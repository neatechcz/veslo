import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_RUNTIME_PACKAGE_FEED_NAME,
  compareCalVerVersions,
  documentRuntimePackageAssetName,
  documentRuntimePackageSignatureName,
  packageFeedEndpoint,
  selectPackageFeedEntry,
  validateDependencyInventory,
  validateDocumentRuntimeManifest,
  validatePackageFeed,
} from "./manifest.mjs";

const sha = (char) => char.repeat(64);

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
  manifestSha256: sha("a"),
  pythonPackagesHash: sha("b"),
  nodePackagesHash: sha("c"),
  fontsHash: sha("d"),
};

test("validates a document runtime package manifest", () => {
  assert.equal(validateDocumentRuntimeManifest(manifest), manifest);
});

test("rejects host-ambiguous or incomplete manifests", () => {
  assert.throws(
    () => validateDocumentRuntimeManifest({ ...manifest, platform: "windows-wsl2-x64" }),
    /platform: must be one of/,
  );
  assert.throws(
    () => validateDocumentRuntimeManifest({ ...manifest, tools: { ...manifest.tools, python: "" } }),
    /tools\.python: must be a non-empty string/,
  );
  assert.throws(
    () => validateDocumentRuntimeManifest({ ...manifest, tools: { ...manifest.tools, qpdf: "" } }),
    /tools\.qpdf: must be a non-empty string/,
  );
});

test("validates dependency inventory required tools", () => {
  const inventory = {
    schemaVersion: 1,
    packageId: "veslo-document-runtime",
    systemTools: [
      { id: "soffice", name: "LibreOffice headless", versionRequirement: "24.8.x", requiredFor: ["docx"] },
      { id: "pandoc", name: "Pandoc", versionRequirement: "3.6.x", requiredFor: ["docx", "pdf"] },
      { id: "poppler", name: "Poppler utilities", versionRequirement: "24.x", requiredFor: ["pdf"] },
      { id: "qpdf", name: "QPDF", versionRequirement: "11.x", requiredFor: ["pdf"] },
      { id: "python", name: "Python runtime", versionRequirement: "3.11.x", requiredFor: ["docx"] },
      { id: "node", name: "Node runtime", versionRequirement: "22.x", requiredFor: ["docx"] },
    ],
    pythonPackages: ["openpyxl"],
    nodePackages: ["docx"],
    fonts: ["Noto Core"],
    platforms: ["windows-native-x64"],
  };

  assert.equal(validateDependencyInventory(inventory), inventory);
  assert.throws(
    () => validateDependencyInventory({
      ...inventory,
      systemTools: inventory.systemTools.filter((tool) => tool.id !== "qpdf"),
    }),
    /systemTools: must include required tool qpdf/,
  );
});

test("builds stable artifact and feed names", () => {
  assert.equal(
    documentRuntimePackageAssetName({
      platform: "windows-native-x64",
      packageVersion: "2026.7.0",
    }),
    "veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg",
  );
  assert.equal(
    documentRuntimePackageSignatureName({
      platform: "macos-arm64",
      packageVersion: "2026.7.0",
    }),
    "veslo-document-runtime-macos-arm64-2026.7.0.veslopkg.sig",
  );
  assert.equal(DOCUMENT_RUNTIME_PACKAGE_FEED_NAME, "document-runtime-packages.json");
  assert.equal(
    packageFeedEndpoint(),
    "https://github.com/neatechcz/veslo-updates/releases/latest/download/document-runtime-packages.json",
  );
});

test("validates package feed entries and stable artifact names", () => {
  const feed = {
    schemaVersion: 1,
    packageId: "veslo-document-runtime",
    releaseTag: "v2026.7.0",
    channel: "stable",
    generatedAt: "2026-07-02T00:00:00Z",
    packages: [
      {
        packageId: "veslo-document-runtime",
        packageVersion: "2026.7.0",
        platform: "windows-native-x64",
        channel: "stable",
        minimumAppVersion: "2026.7.0",
        artifactName: "veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg",
        url: "https://github.com/neatechcz/veslo-updates/releases/download/v2026.7.0/veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg",
        signature: "trusted-minisign-signature",
        contentSha256: sha("e"),
        manifestSha256: sha("f"),
        sizeBytes: 123456,
      },
    ],
  };

  assert.equal(validatePackageFeed(feed), feed);
});

test("rejects package feed entries with unstable artifact names", () => {
  const feed = {
    schemaVersion: 1,
    packageId: "veslo-document-runtime",
    releaseTag: "v2026.7.0",
    channel: "stable",
    generatedAt: "2026-07-02T00:00:00Z",
    packages: [
      {
        packageId: "veslo-document-runtime",
        packageVersion: "2026.7.0",
        platform: "macos-arm64",
        channel: "stable",
        minimumAppVersion: "2026.7.0",
        artifactName: "runtime.zip",
        url: "https://github.com/neatechcz/veslo-updates/releases/download/v2026.7.0/runtime.zip",
        signature: "trusted-minisign-signature",
        contentSha256: sha("a"),
        manifestSha256: sha("b"),
        sizeBytes: 1,
      },
    ],
  };

  assert.throws(() => validatePackageFeed(feed), /artifactName: must be veslo-document-runtime-macos-arm64/);
});

test("selects package feed entries by platform, channel, app version, and current version", () => {
  const feed = {
    schemaVersion: 1,
    packageId: "veslo-document-runtime",
    releaseTag: "v2026.8.0",
    channel: "stable",
    generatedAt: "2026-07-02T00:00:00Z",
    packages: [
      {
        packageId: "veslo-document-runtime",
        packageVersion: "2026.8.0",
        platform: "windows-native-x64",
        channel: "stable",
        minimumAppVersion: "2026.8.0",
        artifactName: "veslo-document-runtime-windows-native-x64-2026.8.0.veslopkg",
        url: "https://github.com/neatechcz/veslo-updates/releases/download/v2026.8.0/veslo-document-runtime-windows-native-x64-2026.8.0.veslopkg",
        signature: "trusted-minisign-signature",
        contentSha256: sha("3"),
        manifestSha256: sha("4"),
        sizeBytes: 10,
      },
      {
        packageId: "veslo-document-runtime",
        packageVersion: "2026.8.0",
        platform: "macos-arm64",
        channel: "stable",
        minimumAppVersion: "2026.7.0",
        artifactName: "veslo-document-runtime-macos-arm64-2026.8.0.veslopkg",
        url: "https://github.com/neatechcz/veslo-updates/releases/download/v2026.8.0/veslo-document-runtime-macos-arm64-2026.8.0.veslopkg",
        signature: "trusted-minisign-signature",
        contentSha256: sha("5"),
        manifestSha256: sha("6"),
        sizeBytes: 10,
      },
    ],
  };

  assert.equal(compareCalVerVersions("2026.8.0", "2026.7.0") > 0, true);
  assert.equal(
    selectPackageFeedEntry(feed, {
      platform: "windows-native-x64",
      appVersion: "2026.7.0",
    }),
    null,
  );
  assert.equal(
    selectPackageFeedEntry(feed, {
      platform: "windows-native-x64",
      appVersion: "2026.8.0",
      currentVersion: "2026.7.0",
    })?.packageVersion,
    "2026.8.0",
  );
  assert.equal(
    selectPackageFeedEntry(feed, {
      platform: "windows-native-x64",
      appVersion: "2026.8.0",
      currentVersion: "2026.8.0",
    }),
    null,
  );
  assert.equal(
    selectPackageFeedEntry(feed, {
      platform: "macos-arm64",
      appVersion: "2026.8.0",
    })?.artifactName,
    "veslo-document-runtime-macos-arm64-2026.8.0.veslopkg",
  );
});
