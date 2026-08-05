import assert from "node:assert/strict";
import test from "node:test";

import { parseManagedAiWorkerReplacementArguments } from "./managed-ai-worker-replacement.mjs";
import { invokeTauriCommand, restartVesloServerWorker } from "./scenario-kit/tauri-command.mjs";
import { runtimeAuthorizationPrimeCount } from "./scenarios/managed-ai-worker-replacement.mjs";

test("managed AI worker replacement requires one explicit direct-run prompt", () => {
  const input = parseManagedAiWorkerReplacementArguments([
    "C:/tmp/runtime-info.json",
    "--workspace",
    "Workspace A",
    "--message",
    "Explain this change",
  ]);
  assert.equal(input.workspace, "Workspace A");
  assert.equal(input.message, "Explain this change");
});

test("worker replacement uses the gated server-child control before normal restart", async () => {
  const originalWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command) => {
        calls.push(command);
        if (command === "veslo_server_info") return { instanceId: "worker-old", running: true };
        if (command === "veslo_server_e2e_kill_child") return { running: false, lifecycleStatus: "exited" };
        return { instanceId: "worker-new", running: true };
      },
    },
  };
  try {
    const browser = {
      executeAsync: async (callback, ...args) => await new Promise((resolve) => callback(...args, resolve)),
    };
    const result = await restartVesloServerWorker(browser);
    assert.deepEqual(calls, ["veslo_server_info", "veslo_server_e2e_kill_child", "veslo_server_restart"]);
    assert.equal(result.nextGeneration, "worker-new");
  } finally {
    globalThis.window = originalWindow;
  }
});

test("worker replacement uses the native Tauri internals bridge exposed by the desktop runtime", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command) => ({ command, instanceId: "worker-next" }),
    },
  };
  try {
    const browser = {
      executeAsync: async (callback, ...args) => await new Promise((resolve) => callback(...args, resolve)),
    };
    const value = await invokeTauriCommand(browser, "veslo_server_info");
    assert.deepEqual(value, { command: "veslo_server_info", instanceId: "worker-next" });
  } finally {
    globalThis.window = originalWindow;
  }
});

test("worker replacement requires a fresh managed AI authorization prime", () => {
  assert.equal(runtimeAuthorizationPrimeCount([
    { event: "managed-ai-runtime-auth-prime:start" },
    { event: "submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime:start" },
    { event: "managed-ai-runtime-auth-prime:result" },
    { event: "unrelated" },
  ]), 2);
  assert.equal(runtimeAuthorizationPrimeCount(null), 0);
});
