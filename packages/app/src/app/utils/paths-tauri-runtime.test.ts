import assert from "node:assert/strict";
import test from "node:test";

import { isTauriRuntime } from "./paths.js";

function withMockWindow<T>(mockWindow: unknown, run: () => T): T {
  const globalScope = globalThis as typeof globalThis & { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(globalScope, "window");
  const originalWindow = globalScope.window;

  globalScope.window = mockWindow;
  try {
    return run();
  } finally {
    if (hadWindow) {
      globalScope.window = originalWindow;
    } else {
      delete globalScope.window;
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
