import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createRoot, createSignal } from "solid-js";

import {
  createVesloServerConnection,
  type VesloServerConnectionClientFactory,
} from "../../context/veslo-server-connection.js";
import type { VesloServerCapabilities } from "../../lib/veslo-server.js";
import type { VesloServerInfo } from "../../lib/tauri.js";

const capabilities = (): VesloServerCapabilities => ({
  skills: { read: true, write: true, source: "veslo" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
});

function installBrowserWindow(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>([
    ["veslo.server.urlOverride", "http://veslo.test"],
    ["veslo.server.token", "test-token"],
  ]);
  const windowStub = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    setTimeout: (callback: TimerHandler, timeout?: number) => setTimeout(callback, timeout) as unknown as number,
    clearTimeout: (timer: number) => clearTimeout(timer),
    setInterval: (callback: TimerHandler, timeout?: number) => setInterval(callback, timeout) as unknown as number,
    clearInterval: (timer: number) => clearInterval(timer),
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowStub,
    writable: true,
  });

  return () => {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function solidRuntimeSupportsEffects(): boolean {
  let observed = 0;
  createRoot((dispose) => {
    const [value, setValue] = createSignal(0);
    createComputed(() => { observed = value(); });
    setValue(1);
    dispose();
  });
  return observed === 1;
}

const behaviorTestOptions = solidRuntimeSupportsEffects()
  ? {}
  : { skip: "Solid's Node server condition does not run effects; use the test:reactivity script." };

test("server status polling runs once per visible connection lifecycle and stops after disposal", behaviorTestOptions, async () => {
  const restoreWindow = installBrowserWindow();
  assert.equal(typeof window, "object");
  const [documentVisible, setDocumentVisible] = createSignal(true);
  let healthCalls = 0;
  let capabilityCalls = 0;
  const factory: VesloServerConnectionClientFactory = () => ({
    baseUrl: "http://veslo.test",
    health: async () => {
      healthCalls += 1;
      return {
        ok: true,
        version: "test",
        uptimeMs: 1,
        workerGeneration: healthCalls === 1 ? "worker-before-replacement" : "worker-after-replacement",
      };
    },
    capabilities: async () => {
      capabilityCalls += 1;
      return capabilities();
    },
  });

  try {
    await createRoot(async (dispose) => {
      const connection = createVesloServerConnection({
        startupPreference: () => "server",
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible,
        developerMode: () => false,
        isTauriRuntime: () => false,
        createClient: factory,
      });

      try {
        await flushEffects();
        assert.equal(connection.vesloServerBaseUrl(), "http://veslo.test");
        assert.equal(healthCalls, 1);
        assert.equal(capabilityCalls, 1);
        assert.equal(connection.vesloServerInstanceId(), "worker-before-replacement");

        setDocumentVisible(false);
        await flushEffects();
        setDocumentVisible(true);
        await flushEffects();
        assert.equal(healthCalls, 2, "visibility restoration starts one new poller");
        assert.equal(capabilityCalls, 2);
        assert.equal(
          connection.vesloServerInstanceId(),
          "worker-after-replacement",
          "a healthy status poll must still publish a replaced worker generation",
        );
      } finally {
        dispose();
      }

      setDocumentVisible(false);
      setDocumentVisible(true);
      await flushEffects();
      assert.equal(healthCalls, 2, "disposed polling effect must not send another request");
    });
  } finally {
    restoreWindow();
  }
});

test("native worker replacement events publish the new generation without waiting for a poll", behaviorTestOptions, async () => {
  const restoreWindow = installBrowserWindow();
  let stateHandler: ((info: VesloServerInfo) => void) | null = null;
  const worker = (instanceId: string): VesloServerInfo => ({
    running: true,
    host: "127.0.0.1",
    port: 8787,
    instanceId,
    baseUrl: "http://127.0.0.1:8787",
    connectUrl: null,
    mdnsUrl: null,
    lanUrl: null,
    engineUrl: null,
    clientToken: "test-token",
    hostToken: "host-token",
    pid: null,
    lastStdout: null,
    lastStderr: null,
  });
  const factory: VesloServerConnectionClientFactory = () => ({
    baseUrl: "http://127.0.0.1:8787",
    health: async () => ({ ok: true, version: "test", uptimeMs: 1, workerGeneration: "poll-worker" }),
    capabilities: async () => capabilities(),
  });

  try {
    await createRoot(async (dispose) => {
      const connection = createVesloServerConnection({
        startupPreference: () => "local",
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => true,
        developerMode: () => false,
        isTauriRuntime: () => true,
        vesloServerInfo: async () => null,
        vesloServerStateListen: async (handler) => {
          stateHandler = handler;
          return () => { stateHandler = null; };
        },
        createClient: factory,
      });
      try {
        await flushEffects();
        assert.ok(stateHandler, "the desktop connection should subscribe to native server state");
        stateHandler!(worker("worker-before-replacement"));
        assert.equal(connection.vesloServerInstanceId(), "worker-before-replacement");
        stateHandler!(worker("worker-after-replacement"));
        assert.equal(
          connection.vesloServerInstanceId(),
          "worker-after-replacement",
          "a native replacement event must invalidate authorization before the next status poll",
        );
      } finally {
        dispose();
      }
    });
  } finally {
    restoreWindow();
  }
});
