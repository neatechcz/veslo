import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';

async function waitForRoute(hashFragment: string, timeout = 5000): Promise<void> {
  await browser.waitUntil(
    async () => (await browser.getUrl()).includes(hashFragment),
    { timeout, timeoutMsg: `Route did not change to ${hashFragment} within ${timeout}ms` }
  );
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
    await navigateToHash('/dashboard/config');
    await waitForRoute('#/dashboard/config');
    const url = await browser.getUrl();
    expect(url).toContain('#/dashboard/config');
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
