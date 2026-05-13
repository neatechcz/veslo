import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

describe('Typography system', () => {
  it('exposes the expected font families via CSS variables', async () => {
    await navigateToHash('/dashboard/settings');
    await browser.pause(1000);

    const families = await browser.execute(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        reading: style.getPropertyValue('--veslo-font-reading').trim(),
        product: style.getPropertyValue('--veslo-font-product').trim(),
        mono: style.getPropertyValue('--veslo-font-mono').trim(),
      };
    });

    expect(families.reading).toContain('Source Sans 3');
    expect(families.product).toContain('IBM Plex Sans');
    expect(families.mono).toContain('IBM Plex Mono');
  });

  it('uses the reading typography on the session composer', async () => {
    await navigateToHash('/session');
    const composer = await $('[role="textbox"][contenteditable="true"]');
    await composer.waitForExist({ timeout: 10000 });

    const typography = await browser.execute((element) => {
      const style = getComputedStyle(element as HTMLElement);
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
      };
    }, composer);

    expect(typography.fontFamily).toContain('Source Sans 3');
    expect(typography.fontSize).toBe('13px');
  });

  it('uses the product typography on shell page titles', async () => {
    await navigateToHash('/dashboard/skills');
    await waitForHashRoute('#/dashboard/skills');
    const title = await $('h2*=Skills');
    await title.waitForExist({ timeout: 10000 });

    const fontFamily = await browser.execute((element) => {
      return getComputedStyle(element as HTMLElement).fontFamily;
    }, title);

    expect(fontFamily).toContain('IBM Plex Sans');
  });
});
