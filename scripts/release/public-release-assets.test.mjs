import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  DEFAULT_PUBLIC_RELEASE_REPO,
  DOCUMENT_RUNTIME_PACKAGE_FEED_NAME,
  isPublicDesktopReleaseAsset,
  isPublicDocumentRuntimeReleaseAsset,
  isPublicReleaseAsset,
  publicDocumentRuntimePackageFeedEndpoint,
  publicDocumentRuntimeReleaseAssetName,
  publicDesktopReleaseAssetName,
  publicReleaseAssetName,
  publicUpdaterEndpoint,
} from "./public-release-assets.mjs";

const OLD_UPDATER_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDUwNDdCNTAwMTcxNUUxQTQKUldTazRSVVhBTFZIVUpNRi9OQnNRaElZY1NUWUQxS1ZJOTFUeUdPd2d6ZnFmMW5QV2xJQ1hXTTkK";

test("uses veslo-updates as the default public release repo", () => {
  assert.equal(DEFAULT_PUBLIC_RELEASE_REPO, "neatechcz/veslo-updates");
});

test("includes only macOS and Windows desktop release artifacts", () => {
  assert.equal(isPublicDesktopReleaseAsset("veslo-desktop-darwin-aarch64.app.tar.gz"), true);
  assert.equal(isPublicDesktopReleaseAsset("veslo-desktop-darwin-aarch64.app.tar.gz.sig"), true);
  assert.equal(isPublicDesktopReleaseAsset("veslo-desktop-windows-x86_64.msi"), true);
  assert.equal(isPublicDesktopReleaseAsset("veslo-desktop-windows-x86_64.msi.sig"), true);

  assert.equal(isPublicDesktopReleaseAsset("veslo-desktop-linux-x86_64.deb"), false);
  assert.equal(isPublicDesktopReleaseAsset("veslo-desktop-linux-x86_64.rpm"), false);
  assert.equal(isPublicDesktopReleaseAsset("veslo-desktop-linux-x86_64.AppImage"), false);
  assert.equal(isPublicDesktopReleaseAsset("veslo-orchestrator-sidecars.json"), false);
});

test("includes document runtime package release artifacts", () => {
  assert.equal(DOCUMENT_RUNTIME_PACKAGE_FEED_NAME, "document-runtime-packages.json");
  assert.equal(isPublicDocumentRuntimeReleaseAsset("document-runtime-packages.json"), true);
  assert.equal(
    isPublicDocumentRuntimeReleaseAsset("veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg"),
    true,
  );
  assert.equal(
    isPublicDocumentRuntimeReleaseAsset("veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg.sig"),
    true,
  );
  assert.equal(isPublicDocumentRuntimeReleaseAsset("veslo-document-runtime-windows-native-x64.zip"), false);
  assert.equal(isPublicDocumentRuntimeReleaseAsset("document-runtime-packages.json.sig"), false);

  assert.equal(isPublicReleaseAsset("veslo-desktop-windows-x86_64.msi"), true);
  assert.equal(isPublicReleaseAsset("veslo-document-runtime-macos-arm64-2026.7.0.veslopkg"), true);
  assert.equal(isPublicReleaseAsset("veslo-orchestrator-sidecars.json"), false);
});

test("uses stable public labels when source release asset names are installer-native", () => {
  assert.equal(
    publicDesktopReleaseAssetName({
      name: "Veslo.by.Neatech_2026.5.3_x64_en-US.msi",
      label: "veslo-desktop-windows-x64.msi",
    }),
    "veslo-desktop-windows-x64.msi",
  );

  assert.equal(
    publicDesktopReleaseAssetName({
      name: "veslo-desktop-darwin-aarch64.app.tar.gz",
      label: "veslo-desktop-darwin-aarch64.app.tar.gz",
    }),
    "veslo-desktop-darwin-aarch64.app.tar.gz",
  );

  assert.equal(
    publicDesktopReleaseAssetName({
      name: "veslo-orchestrator-sidecars.json",
      label: "veslo-orchestrator-sidecars.json",
    }),
    "",
  );
});

test("uses stable public labels for document runtime package assets", () => {
  assert.equal(
    publicDocumentRuntimeReleaseAssetName({
      name: "runtime-from-ci.zip",
      label: "veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg",
    }),
    "veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg",
  );
  assert.equal(
    publicReleaseAssetName({
      name: "runtime-signature.txt",
      label: "veslo-document-runtime-macos-arm64-2026.7.0.veslopkg.sig",
    }),
    "veslo-document-runtime-macos-arm64-2026.7.0.veslopkg.sig",
  );
  assert.equal(publicReleaseAssetName("document-runtime-packages.json"), "document-runtime-packages.json");
});

test("builds the updater endpoint from the public release repo", () => {
  assert.equal(
    publicUpdaterEndpoint(),
    "https://github.com/neatechcz/veslo-updates/releases/latest/download/latest.json",
  );
  assert.equal(
    publicDocumentRuntimePackageFeedEndpoint(),
    "https://github.com/neatechcz/veslo-updates/releases/latest/download/document-runtime-packages.json",
  );
});

test("desktop updater config points at the public release repo", () => {
  const tauriConfigPath = resolve(import.meta.dirname, "../../packages/desktop/src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));

  assert.deepEqual(tauriConfig.plugins.updater.endpoints, [publicUpdaterEndpoint()]);
});

test("desktop updater config no longer uses the previous updater public key", () => {
  const tauriConfigPath = resolve(import.meta.dirname, "../../packages/desktop/src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));

  assert.notEqual(tauriConfig.plugins.updater.pubkey, OLD_UPDATER_PUBKEY);
});

test("release workflow mirrors public release artifacts to veslo-updates", () => {
  const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/release-macos-aarch64.yml");
  const workflow = readFileSync(workflowPath, "utf8");
  const mirrorScriptPath = resolve(import.meta.dirname, "./mirror-public-release.mjs");

  assert.equal(existsSync(mirrorScriptPath), true);
  assert.match(workflow, /RELEASE_UPDATES_REPO/);
  assert.match(workflow, /RELEASE_UPDATES_GH_TOKEN/);
  assert.match(workflow, /mirror-public-release\.mjs/);
  assert.match(workflow, /publish-public-release:/);
});

test("manual release shipping script points to the public updates repo", () => {
  const shipScriptPath = resolve(import.meta.dirname, "./ship.mjs");
  const shipScript = readFileSync(shipScriptPath, "utf8");

  assert.match(shipScript, /DEFAULT_PUBLIC_RELEASE_REPO/);
  assert.match(shipScript, /Public release:/);
});

test("owned-server deployment docs define the desktop updater hosting boundary", () => {
  const docsPath = resolve(import.meta.dirname, "../../docs/dev/cloud-deployments.md");
  const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/release-macos-aarch64.yml");
  const docs = readFileSync(docsPath, "utf8");
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(docs, /not served by the owned-server stack/i);
  assert.match(docs, /static public GitHub release assets/i);
  assert.match(docs, /GitHub-hosted Windows runner/i);
  assert.match(docs, /dedicated Windows self-hosted runner/i);
  assert.match(workflow, /windows-2022/);
  assert.match(workflow, /ubuntu-latest/);
});
