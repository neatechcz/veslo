import assert from "node:assert/strict";
import test from "node:test";

import { resolveEffectiveRuntimeSandboxState } from "../../lib/runtime-sandbox-state.js";

test("configured WSL with direct child kind resolves to non-sandbox fallback", () => {
  const state = resolveEffectiveRuntimeSandboxState({
    configuredSandbox: { enabled: true, backend: "windows-wsl2" },
    targetWorkspaceId: "ws-a",
    orchestratorEngines: [
      {
        workspaceId: "ws-a",
        workdir: "C:/repo/a",
        childKind: "direct",
        state: "ready",
      },
    ],
  });

  assert.equal(state.configuredBackend, "windows-wsl2");
  assert.equal(state.configuredEnabled, true);
  assert.equal(state.effectiveBackend, "none");
  assert.equal(state.isSandboxed, false);
  assert.equal(state.childKind, "direct");
  assert.equal(state.childKindSource, "orchestrator-engine");
  assert.equal(state.directoryQueryMode, "non-sandbox");
  assert.equal(state.requiresEngineBridgeUrl, false);
  assert.equal(state.sandboxFallback, true);
});

test("configured WSL with WSL child kind keeps sandbox routing", () => {
  const state = resolveEffectiveRuntimeSandboxState({
    configuredSandbox: { enabled: true, backend: "windows-wsl2" },
    engineInfo: {
      running: true,
      runtime: "veslo-orchestrator",
      childKind: "wsl",
      projectDir: "C:/repo/a",
    },
  });

  assert.equal(state.effectiveBackend, "windows-wsl2");
  assert.equal(state.isSandboxed, true);
  assert.equal(state.childKind, "wsl");
  assert.equal(state.childKindSource, "engine-info");
  assert.equal(state.directoryQueryMode, "sandbox");
  assert.equal(state.requiresEngineBridgeUrl, true);
  assert.equal(state.sandboxFallback, false);
});

test("configured none remains non-sandbox", () => {
  const state = resolveEffectiveRuntimeSandboxState({
    configuredSandbox: { enabled: false, backend: "none" },
    engineInfo: {
      running: true,
      runtime: "direct",
      projectDir: "C:/repo/a",
    },
  });

  assert.equal(state.configuredBackend, "none");
  assert.equal(state.effectiveBackend, "none");
  assert.equal(state.childKind, "direct");
  assert.equal(state.childKindSource, "inferred-direct-runtime");
  assert.equal(state.directoryQueryMode, "non-sandbox");
  assert.equal(state.requiresEngineBridgeUrl, false);
});

test("unknown child kind does not prove direct fallback", () => {
  const state = resolveEffectiveRuntimeSandboxState({
    configuredSandbox: { enabled: true, backend: "windows-wsl2" },
    targetWorkspaceId: "ws-a",
    orchestratorEngines: [
      {
        workspaceId: "ws-a",
        workdir: "C:/repo/a",
        state: "spawning",
      },
    ],
  });

  assert.equal(state.effectiveBackend, "windows-wsl2");
  assert.equal(state.isSandboxed, true);
  assert.equal(state.childKind, null);
  assert.equal(state.childKindSource, "none");
  assert.equal(state.directoryQueryMode, "auto");
  assert.equal(state.requiresEngineBridgeUrl, false);
  assert.equal(state.sandboxFallback, false);
});

test("matching engine snapshot can be resolved by normalized workspace root", () => {
  const state = resolveEffectiveRuntimeSandboxState({
    configuredSandbox: { enabled: true, backend: "windows-wsl2" },
    targetWorkspaceRoot: "C:\\repo\\A\\",
    orchestratorEngines: [
      {
        workspaceId: "ws-b",
        workdir: "C:/repo/b",
        childKind: "wsl",
        state: "ready",
      },
      {
        workspaceId: "ws-a",
        workdir: "C:/repo/a/",
        childKind: "direct",
        state: "ready",
      },
    ],
  });

  assert.equal(state.effectiveBackend, "none");
  assert.equal(state.childKind, "direct");
  assert.equal(state.sandboxFallback, true);
});
