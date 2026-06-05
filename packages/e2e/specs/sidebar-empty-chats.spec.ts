import { expect } from "@wdio/globals";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
const SIDEBAR_CHAT_COLLAPSED_KEY = "veslo.sidebar-chat-collapsed.v1";

type ChatSectionState = {
  expandedExists: boolean;
  collapsedExists: boolean;
  rowCount: number;
  newChatButtonExists: boolean;
};

async function readChatSectionState(): Promise<ChatSectionState> {
  return browser.execute(() => {
    const section = document.querySelector<HTMLElement>('[data-sidebar-chat-section="true"]');
    return {
      expandedExists: Boolean(section),
      collapsedExists: Boolean(document.querySelector('[data-sidebar-chat-collapsed="true"]')),
      rowCount: section?.querySelectorAll('[data-session-sidebar-row="true"]').length ?? 0,
      newChatButtonExists: Boolean(section?.querySelector('[data-sidebar-chat-new-button="true"]')),
    };
  });
}

describe("Sidebar empty Chaty section", () => {
  before(async () => {
    await navigateToHash("/session");
    await waitForHashRoute("#/session", 5000);

    await browser.execute(
      (viewModeKey: string, chatCollapsedKey: string) => {
        localStorage.setItem(viewModeKey, "by-project");
        localStorage.removeItem(chatCollapsedKey);
      },
      SIDEBAR_VIEW_MODE_KEY,
      SIDEBAR_CHAT_COLLAPSED_KEY,
    );

    await browser.refresh();
    await waitForHashRoute("#/session", 5000);

    const root = await $("#root");
    await root.waitForExist({ timeout: 10000 });
  });

  it("renders the expanded Chaty shell before the first private chat exists", async () => {
    await browser.waitUntil(
      async () => {
        const state = await readChatSectionState();
        return state.expandedExists;
      },
      {
        timeout: 10000,
        interval: 250,
        timeoutMsg: "Expanded Chaty section did not render on a fresh sidebar.",
      },
    );

    const state = await readChatSectionState();
    expect(state.expandedExists).toBe(true);
    expect(state.collapsedExists).toBe(false);
    expect(state.rowCount).toBe(0);
    expect(state.newChatButtonExists).toBe(true);
  });
});
