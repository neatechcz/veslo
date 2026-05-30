import { expect } from "@wdio/globals";

const COPY_MENU_SELECTOR = '[data-testid="app-copy-context-menu"]';
const COPY_BUTTON_SELECTOR = '[data-testid="app-copy-context-menu-copy"]';
const CUSTOM_MENU_SELECTOR = '[data-testid="e2e-custom-context-menu"]';
const FIXTURE_SELECTOR = '[data-testid="e2e-context-menu-fixture"]';

type ContextDispatchResult = {
  canceled: boolean;
  defaultPrevented: boolean;
};

async function cleanupContextMenuFixture() {
  await browser.execute(
    (selectors: string[]) => {
      window.getSelection()?.removeAllRanges();
      for (const selector of selectors) {
        document.querySelector(selector)?.remove();
      }
    },
    [FIXTURE_SELECTOR, COPY_MENU_SELECTOR, CUSTOM_MENU_SELECTOR],
  );
}

async function installContextMenuFixture() {
  await cleanupContextMenuFixture();
  await browser.execute(() => {
    const fixture = document.createElement("section");
    fixture.setAttribute("data-testid", "e2e-context-menu-fixture");
    fixture.style.cssText = [
      "position: fixed",
      "left: 24px",
      "top: 96px",
      "z-index: 2147483000",
      "padding: 12px",
      "background: white",
      "color: black",
      "border: 1px solid black",
    ].join("; ");

    const copyTarget = document.createElement("p");
    copyTarget.setAttribute("data-testid", "e2e-copy-target");
    copyTarget.textContent = "Veslo selected copy text";
    fixture.append(copyTarget);

    const customTarget = document.createElement("button");
    customTarget.type = "button";
    customTarget.setAttribute("data-testid", "e2e-custom-context-target");
    customTarget.textContent = "Custom context target";
    customTarget.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      document.querySelector('[data-testid="e2e-custom-context-menu"]')?.remove();
      const menu = document.createElement("div");
      menu.setAttribute("data-testid", "e2e-custom-context-menu");
      menu.setAttribute("role", "menu");
      menu.textContent = "Custom action";
      document.body.append(menu);
    });
    fixture.append(customTarget);

    document.body.append(fixture);
  });
}

async function selectFixtureText() {
  await browser.execute(() => {
    const target = document.querySelector('[data-testid="e2e-copy-target"]');
    const textNode = target?.firstChild;
    if (!target || !textNode) {
      throw new Error("Copy target text node was not installed");
    }

    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function dispatchContextMenu(testId: string): Promise<ContextDispatchResult> {
  return browser.execute((targetTestId: string) => {
    const target = document.querySelector(`[data-testid="${targetTestId}"]`);
    if (!target) throw new Error(`Missing context menu target: ${targetTestId}`);

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 48,
      clientY: 128,
      button: 2,
      buttons: 2,
    });
    const dispatched = target.dispatchEvent(event);
    return {
      canceled: !dispatched,
      defaultPrevented: event.defaultPrevented,
    };
  }, testId) as Promise<ContextDispatchResult>;
}

describe("Desktop context menu", () => {
  beforeEach(async () => {
    await $("#root").waitForExist({ timeout: 10000 });
    await installContextMenuFixture();
  });

  afterEach(async () => {
    await cleanupContextMenuFixture();
  });

  it("replaces the default webview context menu with a copy-only menu for selected text", async () => {
    await selectFixtureText();

    const result = await dispatchContextMenu("e2e-copy-target");

    expect(result.defaultPrevented).toBe(true);
    expect(result.canceled).toBe(true);

    const menu = await $(COPY_MENU_SELECTOR);
    await menu.waitForDisplayed({ timeout: 5000 });

    const buttons = await menu.$$("button");
    expect(buttons.length).toBe(1);

    const copyButton = await $(COPY_BUTTON_SELECTOR);
    await expect(copyButton).toBeDisplayed();
    await expect(copyButton).toHaveText(expect.stringMatching(/^(Copy|Kopírovat|复制)$/));
  });

  it("prevents the default webview context menu even when there is nothing to copy", async () => {
    await browser.execute(() => window.getSelection()?.removeAllRanges());

    const result = await dispatchContextMenu("e2e-copy-target");

    expect(result.defaultPrevented).toBe(true);
    expect(result.canceled).toBe(true);
    await expect($(COPY_MENU_SELECTOR)).not.toExist();
  });

  it("does not replace context menus that the app already handled", async () => {
    const result = await dispatchContextMenu("e2e-custom-context-target");

    expect(result.defaultPrevented).toBe(true);
    expect(result.canceled).toBe(true);
    await expect($(CUSTOM_MENU_SELECTOR)).toExist();
    await expect($(COPY_MENU_SELECTOR)).not.toExist();
  });
});
