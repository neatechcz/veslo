import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readRepoFile(relativePath) {
  return readFileSync(resolve(import.meta.dirname, "../..", relativePath), "utf8");
}

test("production release workflow only builds macOS and Windows desktop targets", () => {
  const workflow = readRepoFile(".github/workflows/release-macos-aarch64.yml");

  assert.match(workflow, /aarch64-apple-darwin/);
  assert.match(workflow, /x86_64-apple-darwin/);
  assert.match(workflow, /x86_64-pc-windows-msvc/);
  assert.doesNotMatch(workflow, /unknown-linux/);
  assert.doesNotMatch(workflow, /os_type: linux/);
  assert.doesNotMatch(workflow, /Install Linux build dependencies/);
  assert.doesNotMatch(workflow, /Publish AUR/);
});

test("prerelease workflow only builds macOS and Windows desktop targets", () => {
  const workflow = readRepoFile(".github/workflows/prerelease.yml");

  assert.match(workflow, /aarch64-apple-darwin/);
  assert.match(workflow, /x86_64-apple-darwin/);
  assert.match(workflow, /x86_64-pc-windows-msvc/);
  assert.match(workflow, /bun-version:\s+"?1\.3\.11"?/);
  assert.doesNotMatch(workflow, /unknown-linux/);
  assert.doesNotMatch(workflow, /os_type: linux/);
  assert.doesNotMatch(workflow, /Install Linux build dependencies/);
});

test("desktop build workflow no longer runs Linux app builds", () => {
  const workflow = readRepoFile(".github/workflows/build-desktop.yml");
  const windowsWorkflow = readRepoFile(".github/workflows/build-windows-msi.yml");

  assert.match(workflow, /x86_64-pc-windows-msvc/);
  assert.match(workflow, /bun-version:\s+"?1\.3\.11"?/);
  assert.match(windowsWorkflow, /bun-version:\s+"?1\.3\.11"?/);
  assert.doesNotMatch(workflow, /build-linux/);
  assert.doesNotMatch(workflow, /unknown-linux/);
  assert.doesNotMatch(workflow, /Tauri Build \(Linux\)/);
  assert.doesNotMatch(workflow, /Install Linux build dependencies/);
});

test("orchestrator release packaging only builds macOS and Windows sidecars", () => {
  const orchestratorPackage = JSON.parse(readRepoFile("packages/orchestrator/package.json"));
  const serverPackage = JSON.parse(readRepoFile("packages/server/package.json"));
  const routerPackage = JSON.parse(readRepoFile("packages/opencode-router/package.json"));
  const buildSidecars = readRepoFile("packages/orchestrator/scripts/build-sidecars.mjs");
  const publishNpm = readRepoFile("packages/orchestrator/scripts/publish-npm.mjs");
  const productionWorkflow = readRepoFile(".github/workflows/release-macos-aarch64.yml");
  const prepareSidecar = readRepoFile("packages/desktop/scripts/prepare-sidecar.mjs");
  const serverBuild = readRepoFile("packages/server/script/build.ts");
  const routerBuild = readRepoFile("packages/opencode-router/script/build.ts");
  const orchestratorBuild = readRepoFile("packages/orchestrator/script/build.ts");

  assert.match(productionWorkflow, /bun-version:\s+"?1\.3\.11"?/);
  assert.match(prepareSidecar, /bun-windows-x64-baseline\.zip/);
  assert.match(prepareSidecar, /BUN_WINDOWS_X64_BASELINE_EXECUTABLE/);
  assert.match(serverBuild, /--compile-executable-path/);
  assert.match(routerBuild, /--compile-executable-path/);
  assert.match(orchestratorBuild, /executablePath/);

  for (const command of [
    orchestratorPackage.scripts["build:bin:all"],
    serverPackage.scripts["build:bin:all"],
    routerPackage.scripts["build:bin:all"],
  ]) {
    assert.match(command, /bun-darwin-arm64/);
    assert.match(command, /bun-darwin-x64/);
    assert.match(command, /bun-windows-x64-baseline/);
    assert.doesNotMatch(command, /bun-linux/);
  }

  for (const source of [buildSidecars, publishNpm]) {
    assert.match(source, /darwin/);
    assert.match(source, /windows/);
    assert.match(source, /bun-windows-x64-baseline/);
    assert.doesNotMatch(source, /linux-x64/);
    assert.doesNotMatch(source, /linux-arm64/);
    assert.doesNotMatch(source, /bun-linux/);
  }
});
