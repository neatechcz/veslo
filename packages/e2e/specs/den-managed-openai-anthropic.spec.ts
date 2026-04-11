import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';

function isUnauthenticatedAuthGate(text: string): boolean {
  return text.includes('Sign in to Veslo') && text.includes('Sign in with Browser');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function waitForAppShellReady(timeout = 15000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const root = await $('#root');
      if (!(await root.isExisting())) return false;
      const text = await root.getText();
      return text.trim().length > 0;
    },
    {
      timeout,
      timeoutMsg: `App shell did not render within ${timeout}ms`,
    },
  );
}

async function readRootText(): Promise<string> {
  const root = await $('#root');
  return root.getText();
}

async function waitForExpectedManagedAiAssignment(timeout = 30000): Promise<void> {
  const expectedProvider = readOptionalEnv('VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER');
  const expectedModel = readOptionalEnv('VESLO_E2E_EXPECTED_MANAGED_AI_MODEL');

  if (!expectedProvider && !expectedModel) {
    return;
  }

  await navigateToHash('/dashboard/settings');
  await browser.waitUntil(
    async () => {
      const text = normalizeSearchText(await readRootText());
      if (!text.includes('ai access') || !text.includes('managed by the platform admin')) {
        return false;
      }
      if (expectedProvider && !text.includes(normalizeSearchText(expectedProvider))) {
        return false;
      }
      if (expectedModel && !text.includes(normalizeSearchText(expectedModel))) {
        return false;
      }
      return true;
    },
    {
      timeout,
      timeoutMsg: `Settings did not show expected managed AI assignment provider=${expectedProvider ?? '(any)'} model=${expectedModel ?? '(any)'} within ${timeout}ms`,
    },
  );
}

async function waitForComposer(timeout = 20000) {
  const textbox = await $('[role="textbox"]');
  await textbox.waitForExist({ timeout });
  await textbox.waitForDisplayed({ timeout });
  return textbox;
}

async function setComposerText(text: string): Promise<void> {
  const textbox = await waitForComposer();
  await browser.execute(
    (element: HTMLElement, value: string) => {
      element.focus();
      element.textContent = value;
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: value,
          inputType: 'insertText',
        }),
      );
    },
    textbox,
    text,
  );
}

async function clickSend(): Promise<void> {
  const sendButton = await $('button[title="Send"], button[title="Odeslat"]');
  await sendButton.waitForDisplayed({ timeout: 10000 });
  await browser.waitUntil(async () => !(await sendButton.getAttribute('disabled')), {
    timeout: 10000,
    timeoutMsg: 'Composer send button never became enabled.',
  });
  await sendButton.click();
}

describe('DEN-managed AI roundtrip', () => {
  it('should send a managed prompt and render the hosted provider response', async function () {
    await waitForAppShellReady();
    const initialText = await readRootText();
    if (isUnauthenticatedAuthGate(initialText)) {
      console.warn('[den-managed-ai-roundtrip] Skipping because the desktop profile is still unauthenticated. Seed or sign in before running this spec.');
      this.skip();
    }

    await waitForExpectedManagedAiAssignment();
    await navigateToHash('/session');
    await waitForComposer();

    const expectedProvider = readOptionalEnv('VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER') ?? 'managed-ai';
    const token = `${expectedProvider.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}-${Date.now()}`;
    const prompt = `Reply with exactly ${token}. No other words.`;

    await setComposerText(prompt);
    await clickSend();

    await browser.waitUntil(
      async () => {
        const text = await readRootText();
        return countOccurrences(text, token) >= 2;
      },
      {
        timeout: 120000,
        interval: 1000,
        timeoutMsg: `Managed AI response did not echo token ${token} within 120000ms`,
      },
    );

    const text = await readRootText();
    expect(countOccurrences(text, token)).toBeGreaterThanOrEqual(2);
    expect(text.toLowerCase()).not.toContain('server unavailable');
  });
});
