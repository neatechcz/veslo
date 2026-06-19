import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const rustSourceUrl = (relativePath) =>
  new URL(`../src-tauri/src/${relativePath}`, import.meta.url);

const readRustSource = (relativePath) =>
  readFileSync(rustSourceUrl(relativePath), "utf8");

const rawCommandChildImport =
  /use\s+tauri_plugin_shell::process(?:::CommandChild|::\{[^}]*\bCommandChild\b[^}]*\})/;
const rawCommandChildReference = /tauri_plugin_shell::process::CommandChild/;

const assertSourceMatches = (source, pattern, message) => {
  assert.equal(pattern.test(source), true, message);
};

const assertSourceOmits = (source, pattern, message) => {
  assert.equal(pattern.test(source), false, message);
};

const coreSidecarLaunchSources = [
  "engine/spawn.rs",
  "veslo_server/spawn.rs",
  "opencode_router/spawn.rs",
  "orchestrator/mod.rs",
  "commands/orchestrator.rs",
];

const coreSidecarStateSources = [
  "engine/manager.rs",
  "veslo_server/manager.rs",
  "opencode_router/manager.rs",
  "orchestrator/manager.rs",
  "process_supervisor.rs",
];

test("Windows sidecar launches have a central hidden supervised process abstraction", () => {
  const supervisedProcessUrl = rustSourceUrl("supervised_process.rs");

  assert.equal(
    existsSync(supervisedProcessUrl),
    true,
    "expected packages/desktop/src-tauri/src/supervised_process.rs to centralize hidden Windows sidecar process spawning",
  );

  const supervisedProcessSource = readFileSync(supervisedProcessUrl, "utf8");

  assertSourceMatches(
    supervisedProcessSource,
    /#\[\s*cfg\s*\(\s*windows\s*\)\s*\]/,
    "supervised_process.rs should contain Windows-specific launch handling",
  );
  assertSourceMatches(
    supervisedProcessSource,
    /\bCREATE_NO_WINDOW\b/,
    "supervised_process.rs should opt Windows sidecars into CREATE_NO_WINDOW",
  );
  assertSourceMatches(
    supervisedProcessSource,
    /\bCommandExt\b/,
    "supervised_process.rs should use std::os::windows::process::CommandExt for Windows creation flags",
  );
  assertSourceMatches(
    supervisedProcessSource,
    /\.creation_flags\s*\(/,
    "supervised_process.rs should apply Windows creation flags before spawning",
  );
});

test("core sidecar launch sites route through the supervised process abstraction", () => {
  assertSourceMatches(
    readRustSource("lib.rs"),
    /\bmod\s+supervised_process\s*;/,
    "src-tauri/src/lib.rs should register the supervised_process module",
  );

  for (const relativePath of coreSidecarLaunchSources) {
    const source = readRustSource(relativePath);

    assertSourceMatches(
      source,
      /crate::supervised_process\b/,
      `${relativePath} should delegate sidecar spawning through crate::supervised_process`,
    );
    assertSourceOmits(
      source,
      rawCommandChildImport,
      `${relativePath} should not import raw tauri_plugin_shell CommandChild for sidecar supervision`,
    );
    assertSourceOmits(
      source,
      rawCommandChildReference,
      `${relativePath} should not reference raw tauri_plugin_shell CommandChild directly`,
    );
  }
});

test("core sidecar state stores supervised child handles instead of raw CommandChild", () => {
  for (const relativePath of coreSidecarStateSources) {
    const source = readRustSource(relativePath);

    assertSourceOmits(
      source,
      rawCommandChildImport,
      `${relativePath} should not import raw tauri_plugin_shell CommandChild for managed sidecars`,
    );
    assertSourceOmits(
      source,
      rawCommandChildReference,
      `${relativePath} should not reference raw tauri_plugin_shell CommandChild directly`,
    );
  }
});
