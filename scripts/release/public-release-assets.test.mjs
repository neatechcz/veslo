import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  DEFAULT_PUBLIC_RELEASE_REPO,
  isPublicDesktopReleaseAsset,
  publicUpdaterEndpoint,
} from "./public-release-assets.mjs";

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

test("builds the updater endpoint from the public release repo", () => {
  assert.equal(
    publicUpdaterEndpoint(),
    "https://github.com/neatechcz/veslo-updates/releases/latest/download/latest.json",
  );
});

test("desktop updater config points at the public release repo", () => {
  const tauriConfigPath = resolve(import.meta.dirname, "../../packages/desktop/src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));

  assert.deepEqual(tauriConfig.plugins.updater.endpoints, [publicUpdaterEndpoint()]);
});

test("release workflow mirrors desktop artifacts to veslo-updates", () => {
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
