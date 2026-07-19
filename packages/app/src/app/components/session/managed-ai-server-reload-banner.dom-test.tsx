import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

function installDom(): () => void {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "https://veslo.test/",
  });
  const originalValues = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Text: dom.window.Text,
  };

  for (const [key, value] of Object.entries(globals)) {
    originalValues.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }

  return () => {
    for (const [key, descriptor] of originalValues) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  };
}

void test("managed AI reload banner follows pending, reloading, and idle presentation", async () => {
  const restoreDom = installDom();
  let dispose: () => void = () => undefined;
  try {
    const { createComponent } = await import("solid-js");
    const { render } = await import("solid-js/web");
    const { default: ManagedAiServerReloadBanner } = await import("./managed-ai-server-reload-banner.js");
    const root = document.querySelector<HTMLElement>("#root");
    assert.ok(root);
    const mount = (presentation: { kind: "idle" } | { kind: "pending"; workspaceId: string } | { kind: "reloading"; workspaceId: string }) => {
      dispose();
      dispose = render(() => createComponent(ManagedAiServerReloadBanner, {
        presentation,
        widthClass: "max-w-full",
        pendingLabel: "Applied after the active response finishes.",
        reloadingLabel: "Applying AI settings...",
      }), root);
    };

    const banner = () => root.querySelector<HTMLElement>('[data-testid="session-managed-ai-config-status"]');
    mount({ kind: "pending", workspaceId: "workspace-1" });
    assert.equal(banner()?.dataset.managedAiConfigStatus, "pending");
    assert.match(banner()?.textContent ?? "", /after the active response finishes/);

    mount({ kind: "reloading", workspaceId: "workspace-1" });
    assert.equal(banner()?.dataset.managedAiConfigStatus, "reloading");
    assert.match(banner()?.textContent ?? "", /Applying AI settings/);

    mount({ kind: "idle" });
    assert.equal(banner(), null, "banner must be removed after the server confirms the reload");
  } finally {
    dispose();
    restoreDom();
  }
});
