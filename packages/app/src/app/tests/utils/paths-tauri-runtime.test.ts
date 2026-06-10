import assert from "node:assert/strict";
import test from "node:test";

import { isTauriRuntime } from "../../utils/paths.js";

function withMockWindow<T>(mockWindow: unknown, run: () => T): T {
  const globalScope = globalThis as typeof globalThis & { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(globalScope, "window");
  const originalWindow = globalScope.window;

  Object.defineProperty(globalScope, "window", {
    configurable: true,
    writable: true,
    value: mockWindow,
  });
  try {
    return run();
  } finally {
    if (hadWindow) {
      Object.defineProperty(globalScope, "window", {
        configurable: true,
        writable: true,
        value: originalWindow,
      });
    } else {
      Reflect.deleteProperty(globalScope, "window");
    }
  }
}

test("isTauriRuntime returns true when Tauri internals are present", () => {
  const result = withMockWindow(
    {
      __TAURI_INTERNALS__: {},
      location: { hostname: "app.example.com", protocol: "https:" },
    },
    () => isTauriRuntime(),
  );

  assert.equal(result, true);
});

test("isTauriRuntime treats tauri.localhost as desktop runtime even when internals are not exposed", () => {
  const result = withMockWindow(
    {
      location: { hostname: "tauri.localhost", protocol: "http:" },
    },
    () => isTauriRuntime(),
  );

  assert.equal(result, true);
});

test("isTauriRuntime stays false for regular browser hosts without Tauri internals", () => {
  const result = withMockWindow(
    {
      location: { hostname: "veslo-ai-gateway-dev.onrender.com", protocol: "https:" },
    },
    () => isTauriRuntime(),
  );

  assert.equal(result, false);
});
