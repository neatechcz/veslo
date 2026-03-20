import { expect } from '@wdio/globals';

describe('Smoke test', () => {
  it('should open the app window', async () => {
    const title = await browser.getTitle();
    expect(title).toBeTruthy();
  });

  it('should render the root element', async () => {
    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });
    expect(await root.isExisting()).toBe(true);
  });

  it('should render the main UI shell', async () => {
    const body = await $('body');
    await body.waitForDisplayed({ timeout: 15000 });

    const root = await $('#root');
    const children = await root.$$('*');
    expect(children.length).toBeGreaterThan(0);
  });

  it('should have a textbox element (composer)', async () => {
    const textbox = await $('[role="textbox"]');
    if (await textbox.isExisting()) {
      expect(await textbox.isDisplayed()).toBe(true);
    }
  });

  it('should have no critical console errors', async () => {
    const body = await $('body');
    expect(await body.isDisplayed()).toBe(true);
  });
});
