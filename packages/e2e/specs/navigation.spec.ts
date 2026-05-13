import { expect } from '@wdio/globals';
import { currentHashRoute, navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

async function waitForBodyText(expected: string, timeout = 10000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const text = await browser.execute(() => document.body.innerText);
      return text.includes(expected);
    },
    { timeout, timeoutMsg: `Body did not include ${expected} within ${timeout}ms` }
  );
}

async function expectNoDeveloperModeEntry(): Promise<void> {
  await navigateToHash('/dashboard/settings');
  await waitForHashRoute('#/dashboard/settings', 10000);
  await waitForBodyText('Settings');

  const result = await browser.execute(() => {
    const text = document.body.innerText;
    const buttons = Array.from(document.querySelectorAll('button'));
    return {
      hasCard: text.includes('Developer mode'),
      hasEnableButton: buttons.some((button) => button.textContent?.includes('Enable Developer Mode')),
      hasDisableButton: buttons.some((button) => button.textContent?.includes('Disable Developer Mode')),
    };
  });

  expect(result.hasCard).toBe(false);
  expect(result.hasEnableButton).toBe(false);
  expect(result.hasDisableButton).toBe(false);
}

describe('Navigation', () => {
  it('should load the initial route', async () => {
    const url = await browser.getUrl();
    expect(url).toBeTruthy();
  });

  it('should navigate to settings via URL', async () => {
    await navigateToHash('/dashboard/settings');
    await waitForHashRoute('#/dashboard/settings');
    const hash = await currentHashRoute();
    expect(hash).toContain('/dashboard/settings');
  });

  it('should navigate back to session view', async () => {
    await navigateToHash('/session');
    await waitForHashRoute('#/session');
    const hash = await currentHashRoute();
    expect(hash).toContain('/session');
  });

  it('should navigate to skills dashboard', async () => {
    await navigateToHash('/dashboard/skills');
    await waitForHashRoute('#/dashboard/skills');
    const hash = await currentHashRoute();
    expect(hash).toContain('/dashboard/skills');
  });

  it('should not expose developer mode or stay on the developer config dashboard', async () => {
    await expectNoDeveloperModeEntry();
    await navigateToHash('/dashboard/config');
    await waitForHashRoute('#/dashboard/scheduled', 10000);
    const hash = await currentHashRoute();
    expect(hash).not.toContain('/dashboard/config');
  });

  it('should handle browser back navigation', async () => {
    await navigateToHash('/session');
    await waitForHashRoute('#/session');
    await navigateToHash('/dashboard/settings');
    await waitForHashRoute('#/dashboard/settings');
    await browser.back();
    await waitForHashRoute('#/session');
    const hash = await currentHashRoute();
    expect(hash).toContain('/session');
  });
});
