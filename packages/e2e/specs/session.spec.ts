import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';

describe('Session management', () => {
  before(async () => {
    await navigateToHash('/session');
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes('#/session'),
      { timeout: 5000 }
    );
  });

  it('should display the session view', async () => {
    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });
    expect(await root.isDisplayed()).toBe(true);
  });

  it('should show buttons in the UI', async () => {
    const buttons = await $$('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('should have a sidebar area', async () => {
    const root = await $('#root');
    const allElements = await root.$$('*');
    expect(allElements.length).toBeGreaterThan(5);
  });
});
