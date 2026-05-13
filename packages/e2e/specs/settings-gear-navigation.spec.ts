import { expect } from "@wdio/globals";

import { currentHashRoute, navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

describe("Settings gear navigation", () => {
  it("opens settings after returning from skills", async () => {
    await navigateToHash("/session");
    await waitForHashRoute("#/session");

    await navigateToHash("/dashboard/skills");
    await waitForHashRoute("#/dashboard/skills");

    await browser.back();
    await waitForHashRoute("#/session");

    const settingsButton = await $('button[aria-label="Settings"]');
    await settingsButton.waitForExist({ timeout: 10000 });
    await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]');
      if (!button) throw new Error("Settings button not found");
      button.click();
    });

    await waitForHashRoute("#/dashboard/settings");
    await expect(await currentHashRoute()).toContain("/dashboard/settings");
  });
});
