import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

describe('Shared titlebar window controls', () => {
  it('renders Windows window controls in the app-owned titlebar rail', async function () {
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }

    const body = await $('body');
    await body.waitForDisplayed({ timeout: 15000 });
    await browser.execute(() => {
      window.localStorage.setItem('veslo.onboardingComplete', '1');
      window.localStorage.setItem('veslo.language', 'en');
    });
    await browser.refresh();
    const refreshedBody = await $('body');
    await refreshedBody.waitForDisplayed({ timeout: 15000 });
    await navigateToHash('/dashboard/settings');
    await waitForHashRoute('#/dashboard/settings', 10000);
    await browser.waitUntil(
      async () => browser.execute(() => Boolean(document.querySelector('button[aria-label="Minimize window"]'))),
      {
        timeout: 15000,
        timeoutMsg: 'Windows titlebar controls did not render in the shared titlebar rail',
      },
    );

    const metrics = await browser.execute(() => {
      const minimize = document.querySelector('button[aria-label="Minimize window"]');
      const maximize = document.querySelector('button[aria-label="Maximize or restore window"]');
      const close = document.querySelector('button[aria-label="Close window"]');
      const dragRegion = document.querySelector('[data-tauri-drag-region]');
      const closeRect = close?.getBoundingClientRect();

      return {
        hasMinimize: Boolean(minimize),
        hasMaximize: Boolean(maximize),
        hasClose: Boolean(close),
        hasDragRegion: Boolean(dragRegion),
        closeTop: closeRect?.top ?? null,
        closeRightGap: closeRect ? window.innerWidth - closeRect.right : null,
      };
    });

    expect(metrics.hasMinimize).toBe(true);
    expect(metrics.hasMaximize).toBe(true);
    expect(metrics.hasClose).toBe(true);
    expect(metrics.hasDragRegion).toBe(true);
    expect(metrics.closeTop).not.toBeNull();
    expect(metrics.closeTop!).toBeLessThan(1);
    expect(metrics.closeRightGap).not.toBeNull();
    expect(Math.abs(metrics.closeRightGap!)).toBeLessThan(1);
  });
});
