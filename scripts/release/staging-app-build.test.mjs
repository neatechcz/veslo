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
    "VESLO_DEPLOYMENT_DOMAIN: ${{ vars.VESLO_STAGING_DEPLOYMENT_DOMAIN || 'staging.veslo.work' }}",
    "VITE_VESLO_DEPLOYMENT_DOMAIN: ${{ vars.VESLO_STAGING_DEPLOYMENT_DOMAIN || 'staging.veslo.work' }}",
    "VITE_VESLO_UPDATER_ENABLED: false",
    "VESLO_GLITCHTIP_ENVIRONMENT: staging",
    "VITE_VESLO_GLITCHTIP_ENVIRONMENT: staging",
    "tauri.staging.conf.json",
    "tauri.windows.staging.conf.json",
    "actions/upload-artifact",
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
