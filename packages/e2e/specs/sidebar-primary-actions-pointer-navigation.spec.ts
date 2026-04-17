import { expect } from "@wdio/globals";

import { navigateToHash } from "../helpers/app-launcher.js";

type LocaleCopy = {
  moreActions: string;
  archivedItems: string;
  archivedSection: string;
};

const UI_COPY: Record<"en" | "cs" | "zh", LocaleCopy> = {
  en: {
    moreActions: "More actions",
    archivedItems: "Archived items",
    archivedSection: "Archived sessions",
  },
  cs: {
    moreActions: "Další akce",
    archivedItems: "Archivované položky",
    archivedSection: "Archivované relace",
  },
  zh: {
    moreActions: "更多操作",
    archivedItems: "已归档项目",
    archivedSection: "已归档会话",
  },
};

async function getLocale(): Promise<keyof typeof UI_COPY> {
  const locale = await browser.execute(() => document.documentElement.getAttribute("lang")?.trim() ?? "en");
  return locale === "cs" || locale === "zh" ? locale : "en";
}

async function waitForTopRailButton(label: string) {
  const button = await $(`button[data-tooltip="${label}"]`);
  await button.waitForDisplayed({ timeout: 10000 });
  return button;
}

async function waitForMenuItem(label: string) {
  await browser.waitUntil(
    async () => {
      const buttons = await $$("#sidebar-more-actions-menu button");
      for (const button of buttons) {
        const text = (await button.getText()).replace(/\s+/g, " ").trim();
        if (text === label) return true;
      }
      return false;
    },
    {
      timeout: 5000,
      interval: 100,
      timeoutMsg: `Overflow menu item "${label}" was not rendered.`,
    },
  );

  const buttons = await $$("#sidebar-more-actions-menu button");
  for (const button of buttons) {
    const text = (await button.getText()).replace(/\s+/g, " ").trim();
    if (text === label) return button;
  }

  throw new Error(`Overflow menu item "${label}" was not found.`);
}

describe("Sidebar overflow actions via pointer clicks", () => {
  async function expectArchivedNavigationFrom(route: string) {
    await navigateToHash(route);
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes(`#${route}`),
      { timeout: 5000, timeoutMsg: `Route ${route} did not load.` },
    );

    const locale = await getLocale();
    const copy = UI_COPY[locale];

    const moreActionsButton = await waitForTopRailButton(copy.moreActions);
    await moreActionsButton.click();

    const archivedItemButton = await waitForMenuItem(copy.archivedItems);
    await archivedItemButton.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("#/dashboard/settings"),
      {
        timeout: 10000,
        interval: 100,
        timeoutMsg: "Archived items did not navigate to settings after a real click.",
      },
    );

    await browser.waitUntil(
      async () => (await $("body")).getText().then((text) => text.includes(copy.archivedSection)),
      {
        timeout: 10000,
        interval: 100,
        timeoutMsg: "Archived settings section did not become visible after a real click.",
      },
    );

    await expect(await $("body")).toHaveText(expect.stringContaining(copy.archivedSection));
  }

  it("opens archived settings from the session sidebar", async () => {
    await expectArchivedNavigationFrom("/session");
  });

  it("opens archived settings from the dashboard sidebar", async () => {
    await expectArchivedNavigationFrom("/dashboard/scheduled");
  });

  it("switches to archived settings when settings are already open", async () => {
    await expectArchivedNavigationFrom("/dashboard/settings");
  });
});
