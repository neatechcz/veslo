import { expect } from "@wdio/globals";

import { navigateToHash } from "../helpers/app-launcher.js";

async function waitForRoute(hashFragment: string, timeout = 10000): Promise<void> {
  await browser.waitUntil(
    async () => (await browser.getUrl()).includes(hashFragment),
    { timeout, timeoutMsg: `Route did not change to ${hashFragment} within ${timeout}ms` },
  );
}

describe("Settings gear navigation", () => {
  it("opens settings after returning from skills", async () => {
    await navigateToHash("/session");
    await waitForRoute("#/session");

    await navigateToHash("/dashboard/skills");
    await waitForRoute("#/dashboard/skills");

    await browser.back();
    await waitForRoute("#/session");

    const settingsButton = await $('button[aria-label="Settings"]');
    await settingsButton.waitForExist({ timeout: 10000 });
    await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');
      if (!button) throw new Error("Settings button not found");
      button.click();
    });

    await waitForRoute("#/dashboard/settings");
    await expect(await browser.getUrl()).toContain("#/dashboard/settings");
  });
});
