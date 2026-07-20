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
    Event: dom.window.Event,
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

void test("session model selector renders every model in a live roster and returns explicit or default selection", async () => {
  const restoreDom = installDom();
  let dispose: (() => void) | null = null;
  try {
    const { createComponent } = await import("solid-js");
    const { render } = await import("solid-js/web");
    const { default: SessionModelSelector } = await import("./session-model-selector.js");
    const root = document.querySelector<HTMLElement>("#root");
    assert.ok(root);

    const selected: Array<{ providerID: string; modelID: string } | null> = [];
    const models = [
      {
        model: { providerID: "codex_oauth", modelID: "gpt-5.6-sol" },
        capabilityStatus: "known" as const,
        attachment: true,
      },
      { model: { providerID: "codex_oauth", modelID: "gpt-5.5" }, capabilityStatus: "unknown" as const },
      {
        model: { providerID: "codex_oauth", modelID: "gpt-5.4" },
        capabilityStatus: "known" as const,
        attachment: false,
      },
    ];

    dispose = render(
      () => createComponent(SessionModelSelector, {
        enabled: true,
        models,
        selectedModel: null,
        selectionUnavailable: false,
        label: "Model for this send",
        defaultLabel: "Managed default",
        imageCapableLabel: "Images supported",
        imageUnsupportedLabel: "Images unavailable",
        imageUnknownLabel: "Image support unknown",
        selectionUnavailableMessage: "The selected model is no longer available.",
        onSelect: (model) => selected.push(model),
      }),
      root,
    );

    const selector = root.querySelector<HTMLSelectElement>('[data-testid="session-model-selector"]');
    assert.ok(selector);
    assert.equal(selector.value, "");
    assert.equal(selector.options.length, 4);
    assert.deepEqual(
      Array.from(selector.options, (option) => option.value),
      ["", "codex_oauth:gpt-5.6-sol", "codex_oauth:gpt-5.5", "codex_oauth:gpt-5.4"],
    );
    assert.match(selector.options[1]!.textContent ?? "", /Images supported/);
    assert.match(selector.options[2]!.textContent ?? "", /Image support unknown/);
    assert.match(selector.options[3]!.textContent ?? "", /Images unavailable/);

    selector.value = "codex_oauth:gpt-5.4";
    selector.dispatchEvent(new Event("input", { bubbles: true }));
    assert.deepEqual(selected.pop(), { providerID: "codex_oauth", modelID: "gpt-5.4" });

    selector.value = "";
    selector.dispatchEvent(new Event("input", { bubbles: true }));
    assert.equal(selected.pop(), null);

    dispose();
    dispose = render(
      () => createComponent(SessionModelSelector, {
        enabled: true,
        models: [models[0]!],
        selectedModel: null,
        selectionUnavailable: true,
        label: "Model for this send",
        defaultLabel: "Managed default",
        imageCapableLabel: "Images supported",
        imageUnsupportedLabel: "Images unavailable",
        imageUnknownLabel: "Image support unknown",
        selectionUnavailableMessage: "The selected model is no longer available.",
        onSelect: () => undefined,
      }),
      root,
    );
    assert.equal(root.querySelector('[data-testid="session-model-selector"]'), null);
    assert.equal(
      root.querySelector('[data-testid="session-model-selector-unavailable"]')?.textContent,
      "The selected model is no longer available.",
    );
  } finally {
    dispose?.();
    restoreDom();
  }
});
