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

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

type TauriWindow = Window & {
  __TAURI__?: {
    core?: { invoke?: TauriInvoke };
    invoke?: TauriInvoke;
  };
};

type TauriBridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

type PendingDraftKind = 'directory' | 'new-private';

type PendingDraftPutInput = {
  id: string;
  kind: PendingDraftKind;
  workspaceId: string;
  directory: string | null;
  privateWorkspaceId: string | null;
  createdAt: number;
  updatedAt: number;
  composer: {
    mode: 'prompt';
    parts: Array<{ type: 'text'; text: string }>;
    attachments: [];
    text: string;
  };
};

type ComposerTargetSnapshot = {
  id: string;
  workspaceId: string;
  directory: string;
};

const PENDING_DRAFT_DIRECTORY_PREFIX = '__pending-draft__:directory:';
const GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID = 'pending-global-unpublished';

async function invokeTauri<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const result = await browser.execute(
    async (commandName: string, commandArgs: Record<string, unknown>) => {
      const tauri = (window as TauriWindow).__TAURI__;
      const invoke = tauri?.core?.invoke ?? tauri?.invoke;
      if (!invoke) {
        return { ok: false, error: 'Tauri invoke bridge was not found.' } satisfies TauriBridgeResult<unknown>;
      }

      try {
        const value = await invoke(commandName, commandArgs);
        return { ok: true, value } satisfies TauriBridgeResult<unknown>;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies TauriBridgeResult<unknown>;
      }
    },
    command,
    args,
  ) as TauriBridgeResult<T>;

  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function hasDisplayedTargetOptions(): Promise<boolean> {
  const options = await $$('[data-testid="composer-target-option"]');
  for (const option of options) {
    if (await option.isDisplayed()) return true;
  }
  return false;
}

async function openComposerTargetPicker(): Promise<void> {
  if (await hasDisplayedTargetOptions()) return;

  const picker = await $('[data-testid="composer-target-picker"]');
  await picker.waitForDisplayed({ timeout: 10_000 });
  await picker.click();
  await browser.waitUntil(hasDisplayedTargetOptions, {
    timeout: 10_000,
    timeoutMsg: 'Composer target picker did not open.',
  });
}

async function readComposerText(): Promise<string> {
  return browser.execute(() => {
    const el = document.querySelector('[role="textbox"]') as HTMLElement | null;
    return el?.textContent ?? '';
  });
}

async function waitForComposerEntry(): Promise<void> {
  await $('[role="textbox"]').waitForDisplayed({ timeout: 30_000 });
  await $('[data-testid="composer-target-picker"]').waitForDisplayed({ timeout: 10_000 });
}

async function clearComposer(): Promise<void> {
  await browser.execute(() => {
    const el = document.querySelector('[role="textbox"]') as HTMLElement | null;
    if (!el) throw new Error('Composer textbox was not found.');
    el.textContent = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  });
  await browser.pause(150);
}

async function waitForConflictModalClosed(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const modal = await $('[data-testid="composer-target-conflict-modal"]');
      return !(await modal.isExisting()) || !(await modal.isDisplayed());
    },
    {
      timeout: 10_000,
      timeoutMsg: 'Composer target conflict modal did not close.',
    },
  );
}

async function firstWorkspaceTarget(): Promise<ComposerTargetSnapshot> {
  await openComposerTargetPicker();
  const target = await browser.execute((prefix) => {
    const options = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="composer-target-option"][data-composer-target-kind="workspace"]',
      ),
    );

    for (const option of options) {
      const id = option.dataset.composerTargetId ?? '';
      const directory = option.dataset.composerTargetDirectory ?? '';
      if (!id || !directory) continue;
      const suffix = `:${directory}`;
      if (!id.startsWith(prefix) || !id.endsWith(suffix)) continue;
      return {
        id,
        workspaceId: id.slice(prefix.length, id.length - suffix.length),
        directory,
      };
    }
    return null;
  }, PENDING_DRAFT_DIRECTORY_PREFIX);

  if (!target) throw new Error('No workspace composer target was found.');
  return target;
}

function draftInput(text: string): PendingDraftPutInput['composer'] {
  return {
    mode: 'prompt',
    parts: [{ type: 'text', text }],
    attachments: [],
    text,
  };
}

async function putPendingDraft(draft: PendingDraftPutInput): Promise<void> {
  await invokeTauri('pending_session_drafts_put', { draft });
}

async function seedWorkspacePendingDraft(text: string): Promise<ComposerTargetSnapshot> {
  const target = await firstWorkspaceTarget();
  await browser.keys('Escape');

  const now = Date.now();
  await putPendingDraft({
    id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
    kind: 'directory',
    workspaceId: target.workspaceId,
    directory: target.directory,
    privateWorkspaceId: null,
    createdAt: now,
    updatedAt: now,
    composer: draftInput(text),
  });
  return target;
}

async function seedChatPendingDraft(text: string): Promise<void> {
  const now = Date.now();
  await putPendingDraft({
    id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
    kind: 'new-private',
    workspaceId: 'e2e-private-workspace',
    directory: null,
    privateWorkspaceId: 'e2e-private-workspace',
    createdAt: now,
    updatedAt: now,
    composer: draftInput(text),
  });
}

async function clickTargetOptionByDirectory(directory: string): Promise<void> {
  await openComposerTargetPicker();
  const clicked = await browser.execute((targetDirectory) => {
    const options = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="composer-target-option"][data-composer-target-kind="workspace"]',
      ),
    );
    const option = options.find((item) => item.dataset.composerTargetDirectory === targetDirectory);
    option?.click();
    return Boolean(option);
  }, directory);

  if (!clicked) throw new Error(`Composer target for directory ${directory} was not found.`);
}

async function expectChatTargetOptionFirst(): Promise<void> {
  await openComposerTargetPicker();
  const options = await $$('[data-testid="composer-target-option"]');
  const first = options[0];
  if (!first) throw new Error('Composer target picker did not render any options.');

  expect(await first.getAttribute('data-composer-target-kind')).toBe('chat');
  const badge = await first.$('[data-testid="composer-target-draft-badge"]');
  expect(await badge.isDisplayed()).toBe(true);
}

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
