import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';

async function waitForRoute(hashFragment: string, timeout = 5000): Promise<void> {
  await browser.waitUntil(
    async () => (await browser.getUrl()).includes(hashFragment),
    { timeout, timeoutMsg: `Route did not change to ${hashFragment} within ${timeout}ms` }
  );
}

async function waitForBodyText(expected: string, timeout = 10000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const text = await browser.execute(() => document.body.innerText);
      return text.includes(expected);
    },
    { timeout, timeoutMsg: `Body did not include ${expected} within ${timeout}ms` }
  );
}

async function setDeveloperMode(enabled: boolean): Promise<void> {
  await navigateToHash('/dashboard/settings');
  await waitForRoute('#/dashboard/settings', 10000);
  await waitForBodyText('Developer mode');

  const result = await browser.execute((nextEnabled: boolean) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const enableButton = buttons.find((button) => button.textContent?.includes('Enable Developer Mode'));
    const disableButton = buttons.find((button) => button.textContent?.includes('Disable Developer Mode'));

    if (nextEnabled && enableButton instanceof HTMLButtonElement) {
      enableButton.click();
      return 'changed';
    }
    if (!nextEnabled && disableButton instanceof HTMLButtonElement) {
      disableButton.click();
      return 'changed';
    }
    if (nextEnabled && disableButton) return 'already-set';
    if (!nextEnabled && enableButton) return 'already-set';
    return 'missing-toggle';
  }, enabled);

  expect(result).not.toBe('missing-toggle');
  await waitForBodyText(enabled ? 'Developer panel enabled.' : 'Enable this to access the Developer panel.');
}

describe('Navigation', () => {
  it('should load the initial route', async () => {
    const url = await browser.getUrl();
    expect(url).toBeTruthy();
  });

  it('should navigate to settings via URL', async () => {
    await navigateToHash('/dashboard/settings');
    await waitForRoute('#/dashboard/settings');
    const url = await browser.getUrl();
    expect(url).toContain('#/dashboard/settings');
  });

  it('should navigate back to session view', async () => {
    await navigateToHash('/session');
    await waitForRoute('#/session');
    const url = await browser.getUrl();
    expect(url).toContain('#/session');
  });

  it('should navigate to skills dashboard', async () => {
    await navigateToHash('/dashboard/skills');
    await waitForRoute('#/dashboard/skills');
    const url = await browser.getUrl();
    expect(url).toContain('#/dashboard/skills');
  });

  it('should navigate to config dashboard', async () => {
    try {
      await setDeveloperMode(true);
      await navigateToHash('/dashboard/config');
      await waitForRoute('#/dashboard/config', 10000);
      const url = await browser.getUrl();
      expect(url).toContain('#/dashboard/config');
    } finally {
      await setDeveloperMode(false);
    }
  });

  it('should handle browser back navigation', async () => {
    await navigateToHash('/session');
    await waitForRoute('#/session');
    await navigateToHash('/dashboard/settings');
    await waitForRoute('#/dashboard/settings');
    await browser.back();
    await waitForRoute('#/session');
    const url = await browser.getUrl();
    expect(url).toContain('#/session');
  });
});
