import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

type WorkspaceInfo = {
  id: string;
  path: string;
  directory?: string | null;
};

type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

async function tauriInvoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await browser.executeAsync(
    (
      args: { command: string; payload: Record<string, unknown> },
      done: (value: { ok: boolean; value?: unknown; error?: string }) => void,
    ) => {
      const invoke = (
        window as typeof window & {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;

      if (typeof invoke !== 'function') {
        done({ ok: false, error: 'Tauri invoke bridge is unavailable' });
        return;
      }

      invoke(args.command, args.payload).then(
        (value) => done({ ok: true, value }),
        (error) =>
          done({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    },
    { command, payload },
  ) as { ok: boolean; value?: T; error?: string };

  if (!result.ok) {
    throw new Error(`Tauri invoke failed for ${command}: ${result.error ?? 'unknown error'}`);
  }

  return result.value as T;
}

async function clearComposer() {
  await browser.execute(() => {
    const el = document.querySelector('[role="textbox"]');
    if (!el) return;
    (el as HTMLElement).innerText = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteContentBackward' }));
  });
  await browser.pause(150);
}

async function setComposerText(value: string) {
  await browser.execute((text) => {
    const el = document.querySelector('[role="textbox"]') as HTMLElement | null;
    if (!el) throw new Error('Composer textbox was not found.');
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.focus();
  }, value);
  await browser.pause(300);
}

async function readComposerText() {
  return browser.execute(() => (document.querySelector('[role="textbox"]')?.textContent ?? ''));
}

async function activeWorkspaceTarget() {
  const bootstrap = await tauriInvoke<WorkspaceList>('workspace_bootstrap');
  const activeWorkspace = bootstrap.workspaces.find((workspace) => workspace.id === bootstrap.activeId);
  const directory = (activeWorkspace?.directory?.trim() || activeWorkspace?.path?.trim() || '').trim();
  if (!activeWorkspace?.id || !directory) {
    throw new Error('Active workspace is not ready for composer target test.');
  }
  return { workspaceId: activeWorkspace.id, directory };
}

async function seedWorkspacePendingDraft(text: string) {
  const target = await activeWorkspaceTarget();
  const now = Date.now();
  await tauriInvoke('pending_session_drafts_put', {
    draft: {
      id: `pending-directory-e2e-${now}`,
      kind: 'directory',
      workspaceId: target.workspaceId,
      directory: target.directory,
      privateWorkspaceId: null,
      createdAt: now,
      updatedAt: now,
      composer: {
        mode: 'prompt',
        parts: [{ type: 'text', text }],
        attachments: [],
        text,
        resolvedText: text,
        command: null,
      },
    },
  });
  return target;
}

async function seedChatPendingDraft(text: string) {
  const target = await activeWorkspaceTarget();
  const now = Date.now();
  await tauriInvoke('pending_session_drafts_put', {
    draft: {
      id: `pending-chat-e2e-${now}`,
      kind: 'new-private',
      workspaceId: target.workspaceId,
      directory: null,
      privateWorkspaceId: target.workspaceId,
      createdAt: now,
      updatedAt: now,
      composer: {
        mode: 'prompt',
        parts: [{ type: 'text', text }],
        attachments: [],
        text,
        resolvedText: text,
        command: null,
      },
    },
  });
}

async function openTargetPicker() {
  const picker = await $('[data-testid="composer-target-picker"]');
  await picker.waitForDisplayed({ timeout: 20_000 });

  const firstExistingOption = (await $$('[data-testid="composer-target-option"]'))[0];
  if (!(await firstExistingOption?.isDisplayed().catch(() => false))) {
    await picker.click();
  }

  await browser.waitUntil(
    async () => {
      const firstOption = (await $$('[data-testid="composer-target-option"]'))[0];
      return Boolean(await firstOption?.isDisplayed().catch(() => false));
    },
    {
      timeout: 10_000,
      timeoutMsg: 'Composer target picker options did not open.',
    },
  );
}

async function waitForComposerEntry() {
  await $('[data-testid="composer-entry-target-heading"]').waitForDisplayed({ timeout: 30_000 });
  await $('[data-testid="composer-target-picker"]').waitForDisplayed({ timeout: 30_000 });
}

async function clickTargetOptionByDirectory(directory: string) {
  await openTargetPicker();
  const options = await $$('[data-testid="composer-target-option"]');
  for (const option of options) {
    const text = await option.getText();
    if (!text.includes(directory)) continue;
    await expect(await option.$('[data-testid="composer-target-draft-badge"]')).toBeDisplayed();
    await option.click();
    return;
  }
  throw new Error(`Composer target option for ${directory} was not found.`);
}

async function clickChatTargetOption() {
  await openTargetPicker();
  const option = await $('[data-composer-target-kind="chat"]');
  await expect(option).toBeDisplayed();
  await expect(await option.$('[data-testid="composer-target-draft-badge"]')).toBeDisplayed();
  await option.click();
}

async function waitForConflictModalClosed() {
  await browser.waitUntil(
    async () => {
      const modal = await $('[data-testid="composer-target-conflict-modal"]');
      return !(await modal.isDisplayed().catch(() => false));
    },
    {
      timeout: 10_000,
      timeoutMsg: 'Composer target conflict modal did not close.',
    },
  );
}

describe('Composer', () => {
  before(async () => {
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);
  });

  it('shows the centered composer target entry on a new session route', async () => {
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);

    await waitForComposerEntry();
    await expect($('[data-testid="composer-entry-target-heading"]')).toBeDisplayed();
    await expect($('[data-testid="composer-target-picker"]')).toBeDisplayed();
  });

  it('opens the target picker and exposes draft-aware options', async () => {
    await openTargetPicker();
    await expect($$('[data-testid="composer-target-option"]')[0]).toBeDisplayed();
    await browser.keys('Escape');
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

  it('can resolve a target conflict by keeping the current text', async () => {
    const existingDraft = `Existing chat draft ${Date.now()}`;
    const currentDraft = `Current chat override ${Date.now()}`;
    await seedChatPendingDraft(existingDraft);

    await browser.refresh();
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);
    await waitForComposerEntry();
    await clearComposer();
    await setComposerText(currentDraft);

    await clickChatTargetOption();
    await expect($('[data-testid="composer-target-conflict-modal"]')).toBeDisplayed();
    await $('[data-testid="composer-target-use-current"]').click();

    await browser.waitUntil(
      async () => {
        const text = await readComposerText();
        return text.includes(currentDraft) && !text.includes(existingDraft);
      },
      {
        timeout: 10000,
        timeoutMsg: 'Composer did not keep the current draft after resolving the target conflict.',
      },
    );
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
});
