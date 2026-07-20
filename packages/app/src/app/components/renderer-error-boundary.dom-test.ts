import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

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
    MouseEvent: dom.window.MouseEvent,
  };

  for (const [key, value] of Object.entries(globals)) {
    originalValues.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }

  return () => {
    for (const [key, descriptor] of originalValues) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
    dom.window.close();
  };
}

void test("renderer recovery boundary renders UI, captures once, and relaunches", async () => {
  const restoreDom = installDom();
  const captured: unknown[] = [];
  let restartCount = 0;
  let reloadCount = 0;
  let dispose: (() => void) | null = null;
  let resetMonitoring: (() => void) | null = null;

  try {
    const { ErrorBoundary, createComponent } = await import("solid-js");
    const { render } = await import("solid-js/web");
    const { RendererErrorFallback } = await import("./renderer-error-boundary.js");
    const monitoring = await import("../lib/error-monitoring.js");
    resetMonitoring = monitoring.resetErrorMonitoringForTests;

    monitoring.setErrorMonitoringClientForTests({
      withScope(callback) {
        callback({
          setTag() {},
          setContext() {},
          setLevel() {},
        });
      },
      captureException(error) {
        captured.push(error);
        return "renderer-dom-event-123";
      },
      captureMessage(message) {
        captured.push(message);
        return "renderer-dom-message";
      },
    });

    const root = document.querySelector<HTMLElement>("#root");
    assert.ok(root);

    const ThrowingRenderer = () => {
      throw new Error("controlled renderer failure");
    };

    dispose = render(
      () =>
        createComponent(ErrorBoundary, {
          fallback: error =>
            createComponent(RendererErrorFallback, {
              error,
              restart: () => {
                restartCount += 1;
              },
              reload: () => {
                reloadCount += 1;
              },
            }),
          get children() {
            return createComponent(ThrowingRenderer, {});
          },
        }),
      root,
    );

    await flushMicrotasks();
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    const recovery = root.querySelector<HTMLElement>("[data-testid=\"renderer-error-recovery\"]");
    const incident = root.querySelector<HTMLElement>("[data-testid=\"renderer-error-incident-id\"]");
    const restart = root.querySelector<HTMLButtonElement>("[data-testid=\"renderer-error-restart\"]");
    assert.equal(recovery?.getAttribute("role"), "alert");
    assert.match(recovery?.textContent ?? "", /Veslo needs to restart/);
    assert.equal(captured.length, 1, root.innerHTML);
    assert.equal(incident?.textContent?.trim(), "Incident ID: renderer-dom-event-123", root.innerHTML);
    assert.ok(restart);

    restart.click();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(restartCount, 1);
    assert.equal(reloadCount, 0);
  } finally {
    dispose?.();
    resetMonitoring?.();
    restoreDom();
  }
});
