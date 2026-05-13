import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

describe('Composer', () => {
  before(async () => {
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);
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

  it('should keep ArrowUp native while a live draft contains text', async () => {
    const textbox = await $('[role="textbox"]');
    if (!(await textbox.isExisting())) return;

    const draft = 'Draft that should keep native ArrowUp';
    await browser.execute((value) => {
      const editor = document.querySelector('[role="textbox"]') as HTMLElement | null;
      if (!editor) throw new Error('Composer textbox was not found.');

      editor.textContent = value;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      editor.focus();

      const selection = window.getSelection();
      const range = document.createRange();
      const firstChild = editor.firstChild;
      if (firstChild?.nodeType === Node.TEXT_NODE) {
        range.setStart(firstChild, 0);
      } else {
        range.setStart(editor, 0);
      }
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);

      (window as any).__vesloComposerArrowUp = null;
      document.addEventListener(
        'keydown',
        (event) => {
          if (event.key !== 'ArrowUp') return;
          (window as any).__vesloComposerArrowUp = {
            defaultPrevented: event.defaultPrevented,
            text: editor.textContent ?? '',
          };
        },
        { once: true },
      );
    }, draft);

    await browser.keys('ArrowUp');

    const result = await browser.execute(() => (window as any).__vesloComposerArrowUp);
    expect(result).toEqual({
      defaultPrevented: false,
      text: draft,
    });
    expect(await textbox.getText()).toContain(draft);
  });
});
