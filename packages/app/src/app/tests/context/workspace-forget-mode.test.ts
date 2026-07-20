import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { readContextSource, readWorkspaceBehaviorSources } from "./workspace-source";

const workspaceSource = readWorkspaceBehaviorSources();
const tauriSource = readFileSync(new URL("../../lib/tauri.ts", import.meta.url), "utf8");
const workspaceDebugSource = readContextSource("workspace-debug.ts");
const workspaceRuntimeProbeSource = readContextSource("workspace-runtime-debug-probe.ts");
const remoteStoreSource = readFileSync(new URL("../../stores/remote-store.ts", import.meta.url), "utf8");

test("workspace store maps forget options to detach/delete modes", () => {
  assert.match(
    workspaceSource,
    /const mode = forgetOptions\?\.deleteLocalData \? "delete_local_data" : "detach_only";/,
    "workspace store should default to detach_only and use delete_local_data only when explicitly requested",
  );

  assert.match(
    workspaceSource,
    /const ws = await workspaceForget\(id, mode\);/,
    "workspace store should pass forget mode to the tauri bridge",
  );
});

test("tauri workspaceForget bridge defaults to detach_only mode", () => {
  assert.match(
    tauriSource,
    /export type WorkspaceForgetMode = "detach_only" \| "delete_local_data";/,
    "tauri bridge should expose explicit forget modes",
  );

  assert.match(
    tauriSource,
    /mode: WorkspaceForgetMode = "detach_only"/,
    "tauri bridge should keep detach_only as the safe default",
  );

  assert.match(
    tauriSource,
    /invoke<WorkspaceList>\("workspace_forget", \{ workspaceId, mode \}\);/,
    "tauri invoke should send the selected forget mode",
  );
});

test("workspace debug and busy helpers live outside the workspace facade", () => {
  assert.match(
    workspaceSource,
    /\/\* workspace-debug\.ts \*\/[\s\S]*export function createWorkspaceDebugEvents\(/,
    "workspace debug event buffering should live in workspace-debug.ts",
  );

  assert.match(
    workspaceSource,
    /\/\* workspace-busy-state\.ts \*\/[\s\S]*export function createWorkspaceBusyState\(/,
    "workspace busy state should live in workspace-busy-state.ts",
  );

  assert.match(
    workspaceSource,
    /recordTrace\?\.\("clear-all-except", \{[\s\S]*keepWorkspaceId:[\s\S]*droppedWorkspaceIds:/,
    "workspace busy traces should preserve diagnostic workspace ids for readable runtime error context",
  );
});

test("workspace debug activation log uses a typed window root", () => {
  const unsafeTypeToken = "a" + "ny";

  assert.match(
    workspaceDebugSource,
    /type WorkspaceBusyTraceRoot = typeof window & \{[\s\S]*__wsActivateLog\?: string;/,
    "workspace debug should type the activation log field on its window root",
  );

  assert.match(
    workspaceDebugSource,
    /const root = window as WorkspaceBusyTraceRoot;[\s\S]*root\.__wsActivateLog = `\$\{root\.__wsActivateLog \?\? ""\}\$\{line\}\\n`;/,
    "workspace debug should append activation logs through the typed root",
  );

  assert.doesNotMatch(
    workspaceDebugSource,
    new RegExp(`\\(window as ${unsafeTypeToken}\\)\\.__wsActivateLog`),
    "workspace debug should not cast the activation log window root to any",
  );
});

test("workspace diagnostics stay out of the DevTools console", () => {
  const consoleOutput = /\bconsole\.(?:log|warn|debug|info)\s*\(/;

  assert.doesNotMatch(workspaceSource, consoleOutput);
  assert.doesNotMatch(remoteStoreSource, consoleOutput);
  assert.doesNotMatch(workspaceRuntimeProbeSource, consoleOutput);
});
