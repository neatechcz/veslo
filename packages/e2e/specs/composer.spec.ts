import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

type ComposerLayoutState = {
  bodyText: string;
  headingDisplayed: boolean;
  rootClass: string;
  rootTop: number;
  rootBottom: number;
  rootMid: number;
  viewportHeight: number;
};

async function setComposerText(value: string) {
  await browser.execute((text) => {
    const el = document.querySelector('[role="textbox"]') as HTMLElement | null;
    if (!el) throw new Error('Composer textbox was not found.');
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.focus();
  }, value);
  await browser.pause(150);
}

async function getComposerLayoutState(): Promise<ComposerLayoutState> {
  return browser.execute(() => {
    const textbox = document.querySelector('[role="textbox"]') as HTMLElement | null;
    if (!textbox) throw new Error('Composer textbox was not found.');

    let root: HTMLElement | null = textbox;
    while (
      root &&
      !(
        root.className.includes('z-20') &&
        (root.className.includes('sticky') || root.className.includes('relative'))
      )
    ) {
      root = root.parentElement;
    }
    if (!root) throw new Error('Composer root was not found.');

    const rect = root.getBoundingClientRect();
    const heading = document.querySelector('[data-testid="composer-entry-target-heading"]') as HTMLElement | null;
    return {
      bodyText: document.body.innerText,
      headingDisplayed: Boolean(heading && heading.offsetParent !== null),
      rootClass: root.className,
      rootTop: rect.top,
      rootBottom: rect.bottom,
      rootMid: rect.top + rect.height / 2,
      viewportHeight: window.innerHeight,
    };
  });
}

describe('Composer', () => {
  before(async () => {
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);
  });

  it('centers the composer entry on a new session route without quickstart copy', async () => {
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);
    await $('[role="textbox"]').waitForDisplayed({ timeout: 30_000 });

    const state = await getComposerLayoutState();
    expect(state.headingDisplayed).toBe(true);
    expect(state.rootClass).toContain('relative');
    expect(state.rootClass).not.toContain('sticky');
    expect(Math.abs(state.rootMid - state.viewportHeight / 2)).toBeLessThan(state.viewportHeight * 0.25);

    for (const removedText of [
      'Co chcete udělat?',
      'Automatizuj prohlížeč',
      'Dej mi duši',
      'What do you want to do?',
      'Automate your browser',
      'Give me a soul',
    ]) {
      expect(state.bodyText).not.toContain(removedText);
    }
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

  it('asks before replacing current text with an existing workspace draft', async () => {
    const existingDraft = `Existing workspace draft ${Date.now()}`;
    const currentDraft = `Current composer draft ${Date.now()}`;
    const target = await seedWorkspacePendingDraft(existingDraft);

    await browser.refresh();
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);
    await waitForComposerEntry();
    await clearComposer();
    await setComposerText(currentDraft);

    await clickTargetOptionByDirectory(target.directory);
    await expect($('[data-testid="composer-target-conflict-modal"]')).toBeDisplayed();
    await browser.keys('Escape');
    await waitForConflictModalClosed();

    await clickTargetOptionByDirectory(target.directory);
    await expect($('[data-testid="composer-target-conflict-modal"]')).toBeDisplayed();
    await $('[data-testid="composer-target-conflict-close"]').click();
    await waitForConflictModalClosed();

    await clickTargetOptionByDirectory(target.directory);
    await expect($('[data-testid="composer-target-conflict-modal"]')).toBeDisplayed();
    await $('[data-testid="composer-target-load-existing"]').click();

    await browser.waitUntil(
      async () => {
        return (await readComposerText()).includes(existingDraft);
      },
      {
        timeout: 10000,
        timeoutMsg: 'Composer did not load the existing workspace draft.',
      },
    );
  });

  it('offers chat-only private drafts as the first composer target option', async () => {
    const existingDraft = `Existing chat draft ${Date.now()}`;
    await seedChatPendingDraft(existingDraft);

    await browser.refresh();
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);
    await waitForComposerEntry();

    await expectChatTargetOptionFirst();
    await browser.keys('Escape');
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
    expect(await readComposerText()).toContain(draft);
  });

  it('moves the composer to the footer immediately after the first submit', async () => {
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);
    await $('[role="textbox"]').waitForDisplayed({ timeout: 30_000 });

    const before = await getComposerLayoutState();
    expect(before.rootClass).toContain('relative');
    expect(before.headingDisplayed).toBe(true);

    await setComposerText(`Composer layout submit ${Date.now()}`);
    await browser.keys('Enter');

    await browser.waitUntil(
      async () => {
        const after = await getComposerLayoutState();
        return (
          after.rootClass.includes('sticky') &&
          after.rootClass.includes('bottom-0')
        );
      },
      {
        timeout: 5_000,
        timeoutMsg: 'Composer did not move to the footer immediately after submit.',
      },
    );

    const after = await getComposerLayoutState();
    expect(after.rootClass).toContain('sticky');
    expect(after.rootClass).toContain('bottom-0');
  });
});
