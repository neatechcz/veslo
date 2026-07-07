import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const readJson = (path) => JSON.parse(read(path));

test("staging Tauri config is a side-by-side app with updater artifacts disabled", () => {
  const staging = readJson("packages/desktop/src-tauri/tauri.staging.conf.json");

  assert.equal(staging.productName, "Veslo Staging");
  assert.equal(staging.identifier, "com.neatech.veslo.staging");
  assert.equal(staging.bundle.createUpdaterArtifacts, false);
});

test("staging Windows config uses a distinct upgrade code", () => {
  const production = readJson("packages/desktop/src-tauri/tauri.conf.json");
  const stagingWindows = readJson("packages/desktop/src-tauri/tauri.windows.staging.conf.json");

  assert.notEqual(
    stagingWindows.bundle.windows.wix.upgradeCode,
    production.bundle.windows.wix.upgradeCode,
  );
});

test("staging app workflow bakes staging endpoints and never publishes public updater assets", () => {
  const workflow = read(".github/workflows/build-staging-app.yml");

  for (const requiredText of [
    "name: Build Staging App",
    "workflow_dispatch",
    "contents: write",
    "prepare-staging-release:",
    "release_tag: ${{ steps.staging-release-meta.outputs.release_tag }}",
    "gh release create \"$RELEASE_TAG\"",
    "--prerelease",
    "--target \"$RELEASE_TARGET\"",
    "VESLO_DEPLOYMENT_DOMAIN: ${{ vars.VESLO_STAGING_DEPLOYMENT_DOMAIN || 'staging.veslo.work' }}",
    "VITE_VESLO_DEPLOYMENT_DOMAIN: ${{ vars.VESLO_STAGING_DEPLOYMENT_DOMAIN || 'staging.veslo.work' }}",
    "VITE_VESLO_UPDATER_ENABLED: false",
    "VESLO_GLITCHTIP_ENVIRONMENT: staging",
    "VITE_VESLO_GLITCHTIP_ENVIRONMENT: staging",
    "Resolve macOS staging signing",
    "OS_TYPE: macos",
    "MACOS_NOTARIZE: true",
    "ALLOW_UNSIGNED_MACOS: false",
    "APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}",
    "APPLE_CERTIFICATE: ${{ secrets.APPLE_CODESIGN_CERT_P12_BASE64 }}",
    "APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CODESIGN_CERT_PASSWORD }}",
    "APPLE_API_KEY: ${{ secrets.APPLE_NOTARY_API_KEY_ID }}",
    "APPLE_API_ISSUER: ${{ secrets.APPLE_NOTARY_API_ISSUER_ID }}",
    "APPLE_NOTARY_API_KEY_P8_BASE64: ${{ secrets.APPLE_NOTARY_API_KEY_P8_BASE64 }}",
    "APPLE_ID: ${{ secrets.APPLE_NOTARY_APPLE_ID }}",
    "APPLE_PASSWORD: ${{ secrets.APPLE_NOTARY_APP_SPECIFIC_PASSWORD }}",
    "APPLE_TEAM_ID: ${{ vars.APPLE_TEAM_ID || secrets.APPLE_TEAM_ID }}",
    "Write staging notary API key",
    "Validate staging notary API key",
    "Notarize, staple, and verify macOS staging assets",
    "scripts/release/notarize-macos-assets.sh",
    "VESLO_REQUIRE_UPDATER_ARTIFACTS: false",
    "tauri.staging.conf.json",
    "tauri.windows.staging.conf.json",
    "actions/upload-artifact",
    "gh release upload \"$RELEASE_TAG\"",
  ]) {
    assert.match(workflow, new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const forbiddenText of [
    "VITE_DEN_API_BASE: https://api.staging.veslo.work",
    "VITE_MANAGED_AI_GATEWAY_BASE_URL: https://ai.staging.veslo.work",
    "VESLO_MANAGED_AI_BASE_URL: https://ai.staging.veslo.work",
    "VITE_VESLO_CONNECT_APP_URL: https://app.staging.veslo.work",
  ]) {
    assert.equal(workflow.includes(forbiddenText), false, `staging app workflow must derive ${forbiddenText}`);
  }

  for (const forbiddenText of [
    "neatechcz/veslo-updates",
    "mirror-public-release",
    "generate-latest-json",
    "publish-updater-json",
    "Release App",
  ]) {
    assert.equal(workflow.includes(forbiddenText), false, `staging app workflow must not include ${forbiddenText}`);
  }
});
