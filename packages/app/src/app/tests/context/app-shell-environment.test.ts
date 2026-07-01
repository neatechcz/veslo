import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import { createAppShellEnvironment } from "../../context/app-shell-environment.js";
import type { FontZoomTarget } from "../../lib/font-zoom.js";

type Listener = (event: any) => void;

class FakeEventTarget {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }

  dispatch(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createFakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];

  return {
    writes,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push([key, value]);
        values.set(key, value);
      },
    },
  };
}

function createFakeWindow(storage = createFakeStorage().storage) {
  return Object.assign(new FakeEventTarget(), { localStorage: storage });
}

function createFakeDocument() {
  const styleWrites: string[] = [];
  const styleRemovals: string[] = [];
  const target = new FakeEventTarget();

  return Object.assign(target, {
    visibilityState: "visible",
    focused: true,
    hasFocus() {
      return this.focused;
    },
    documentElement: {
      style: {
        setProperty: (key: string, value: string) => {
          styleWrites.push(`${key}:${value}`);
        },
        removeProperty: (key: string) => {
          styleRemovals.push(key);
          return "";
        },
      },
    },
    styleWrites,
    styleRemovals,
  });
}

async function settleEffects() {
  await Promise.resolve();
  await Promise.resolve();
}

test("tracks document visibility and app focus with cleanup", async () => {
  const fakeWindow = createFakeWindow();
  const fakeDocument = createFakeDocument();
  fakeDocument.visibilityState = "hidden";
  fakeDocument.focused = false;

  await createRoot(async (dispose) => {
    const shell = createAppShellEnvironment({
      window: () => fakeWindow,
      document: () => fakeDocument,
      isTauriRuntime: () => false,
      isFileDragTransfer: () => false,
      effect: (fn) => fn(),
    });

    await settleEffects();

    assert.equal(shell.documentVisible(), false);
    assert.equal(shell.appFocused(), false);
    assert.equal(fakeDocument.listenerCount("visibilitychange"), 2);
    assert.equal(fakeWindow.listenerCount("focus"), 1);
    assert.equal(fakeWindow.listenerCount("blur"), 1);

    fakeDocument.visibilityState = "visible";
    fakeDocument.focused = true;
    fakeDocument.dispatch("visibilitychange");
    assert.equal(shell.documentVisible(), true);
    assert.equal(shell.appFocused(), true);

    fakeDocument.focused = false;
    fakeWindow.dispatch("blur");
    assert.equal(shell.appFocused(), false);

    dispose();

    assert.equal(fakeDocument.listenerCount("visibilitychange"), 0);
    assert.equal(fakeWindow.listenerCount("focus"), 0);
    assert.equal(fakeWindow.listenerCount("blur"), 0);
  });
});

test("global file-drop guard prevents default only for file transfers", async () => {
  const fakeWindow = createFakeWindow();
  const fakeDocument = createFakeDocument();

  await createRoot(async (dispose) => {
    createAppShellEnvironment({
      window: () => fakeWindow,
      document: () => fakeDocument,
      isTauriRuntime: () => false,
      isFileDragTransfer: (transfer) => (transfer as { kind?: string } | null | undefined)?.kind === "file",
      effect: (fn) => fn(),
    });

    await settleEffects();

    let textPrevented = false;
    fakeWindow.dispatch("dragover", {
      dataTransfer: { kind: "text" },
      preventDefault: () => {
        textPrevented = true;
      },
    });
    assert.equal(textPrevented, false);

    let filePrevented = false;
    fakeWindow.dispatch("drop", {
      dataTransfer: { kind: "file" },
      preventDefault: () => {
        filePrevented = true;
      },
    });
    assert.equal(filePrevented, true);

    dispose();

    assert.equal(fakeWindow.listenerCount("dragover"), 0);
    assert.equal(fakeWindow.listenerCount("drop"), 0);
  });
});

test("font zoom shortcut applies, persists, and removes the key listener", async () => {
  const storage = createFakeStorage();
  const fakeWindow = createFakeWindow(storage.storage);
  const fakeDocument = createFakeDocument();
  const webview: FontZoomTarget = { setZoom: async () => {} };
  const appliedZooms: number[] = [];
  const persistedZooms: number[] = [];

  await createRoot(async (dispose) => {
    createAppShellEnvironment({
      window: () => fakeWindow,
      document: () => fakeDocument,
      isTauriRuntime: () => true,
      isFileDragTransfer: () => false,
      getCurrentWebview: () => webview,
      readStoredFontZoom: () => 1.2,
      persistFontZoom: (_storage, value) => {
        persistedZooms.push(value);
      },
      applyWebviewZoom: async (_target, value) => {
        appliedZooms.push(value);
        return value;
      },
      normalizeFontZoom: (value) => Math.round(value * 10) / 10,
      parseFontZoomShortcut: (event) => (event as { action?: "in" | "out" | "reset" }).action ?? null,
      fontZoomStep: 0.1,
      effect: (fn) => fn(),
    });

    await settleEffects();

    assert.deepEqual(persistedZooms, [1.2]);
    assert.deepEqual(appliedZooms, [1.2]);
    assert.equal(fakeWindow.listenerCount("keydown"), 1);

    let prevented = false;
    let stopped = false;
    fakeWindow.dispatch("keydown", {
      action: "in",
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {
        stopped = true;
      },
    });

    await settleEffects();

    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.deepEqual(persistedZooms, [1.2, 1.3]);
    assert.deepEqual(appliedZooms, [1.2, 1.3]);
    assert.deepEqual(fakeDocument.styleRemovals, ["--veslo-font-size", "--veslo-font-size"]);

    dispose();

    assert.equal(fakeWindow.listenerCount("keydown"), 0);
  });
});
