import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

test("stable desktop release bundles macOS document runtime and keeps Windows package-only", () => {
  const workflow = read(".github/workflows/release-macos-aarch64.yml");

  assert.match(workflow, /Install macOS document runtime resource/);
  assert.match(workflow, /install-package-resource\.mjs/);
  assert.match(workflow, /Verify macOS document runtime bundle/);
  assert.doesNotMatch(workflow, /Assemble Windows document runtime/);
  assert.doesNotMatch(workflow, /Verify Windows document runtime bundle/);
});

test("prerelease desktop builds bundle macOS document runtime and keep Windows package-only", () => {
  const workflow = read(".github/workflows/prerelease.yml");

  assert.match(workflow, /Verify macOS document runtime bundle/);
  assert.match(workflow, /verify-document-runtime-macos\.mjs[\s\S]*VESLO_DOCUMENT_RUNTIME_RELEASE_PROFILE:-local-docs-required[\s\S]*--json/);
  assert.doesNotMatch(workflow, /Assemble Windows document runtime/);
  assert.doesNotMatch(workflow, /Verify Windows document runtime bundle/);
  assert.doesNotMatch(workflow, /verify-document-runtime-windows\.mjs --profile local-docs-required --json/);
});

test("macOS Tauri configs expose document runtime as a bundled resource while Windows stays package-only", () => {
  const windowsReleaseConfig = read("packages/desktop/src-tauri/tauri.windows.release.conf.json");
  const macosArm64ReleaseConfig = read("packages/desktop/src-tauri/tauri.macos.aarch64.release.conf.json");
  const macosX64ReleaseConfig = read("packages/desktop/src-tauri/tauri.macos.x64.release.conf.json");

  assert.doesNotMatch(windowsReleaseConfig, /"resources\/document-runtime\/windows-native-x64": "document-runtime"/);
  assert.match(macosArm64ReleaseConfig, /"resources\/document-runtime\/macos-arm64": "document-runtime"/);
  assert.match(macosX64ReleaseConfig, /"resources\/document-runtime\/macos-x64": "document-runtime"/);
});
