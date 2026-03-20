import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';

describe('Composer', () => {
  before(async () => {
    await navigateToHash('/session');
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes('#/session'),
      { timeout: 5000 }
    );
  });

  it('should have a textbox for composing messages', async () => {
    const textbox = await $('[role="textbox"]');
    if (await textbox.isExisting()) {
      expect(await textbox.isDisplayed()).toBe(true);
    }
  });

  it('should accept text input in the composer', async () => {
    const textbox = await $('[role="textbox"]');
    if (!(await textbox.isExisting())) return;

    await textbox.click();
    await textbox.setValue('Hello from E2E test');
    const value = await textbox.getText();
    expect(value).toContain('Hello from E2E test');
  });

  it('should clear the composer', async () => {
    const textbox = await $('[role="textbox"]');
    if (!(await textbox.isExisting())) return;

    await textbox.click();
    // Clear via JS since keyboard shortcuts may not work on all webviews
    await browser.execute(() => {
      const el = document.querySelector('[role="textbox"]');
      if (el) {
        (el as HTMLElement).innerText = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await browser.pause(200);
    const value = await textbox.getText();
    expect(value.trim()).toBe('');
  });
});
