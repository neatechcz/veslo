import { readFileSync } from 'node:fs';
import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';

type StorageSnapshot = {
  local: Record<string, string | null>;
  session: Record<string, string | null>;
};

type DesktopAuthSnapshotFile = {
  authJson?: string | null;
};

type DenAuthState = {
  denApiBase: string;
  token: string;
  user?: {
    id?: string;
    email?: string;
  };
};

const DEFAULT_GATEWAY_BASE = 'https://veslo-ai-gateway-dev.onrender.com';

const STORAGE_KEYS = [
  'veslo.den.keepSignedIn',
  'veslo.server.urlOverride',
  'veslo.server.token',
  'veslo.language',
  'veslo.onboardingComplete',
] as const;

const SESSION_KEYS = ['veslo.den.auth'] as const;

function readLiveAdminAuth(): { authJson: string; auth: DenAuthState } {
  const snapshotPath = process.env.VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE?.trim();
  if (!snapshotPath) {
    throw new Error('VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE is required.');
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as DesktopAuthSnapshotFile;
  const authJson = snapshot.authJson?.trim();
  if (!authJson) {
    throw new Error(`Desktop auth snapshot at ${snapshotPath} does not include authJson.`);
  }

  const auth = JSON.parse(authJson) as DenAuthState;
  if (!auth.denApiBase?.trim() || !auth.token?.trim()) {
    throw new Error('Desktop auth snapshot must include denApiBase and token.');
  }

  return { authJson, auth };
}

function readGatewayBase(): string {
  return (process.env.VESLO_E2E_GATEWAY_BASE?.trim() || DEFAULT_GATEWAY_BASE).replace(/\/+$/, '');
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

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

function compactLogText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1200);
}

async function snapshotStorage(): Promise<StorageSnapshot> {
  return browser.execute(
    (localKeys: readonly string[], sessionKeys: readonly string[]) => {
      const local: Record<string, string | null> = {};
      const session: Record<string, string | null> = {};
      for (const key of localKeys) {
        local[key] = window.localStorage.getItem(key);
      }
      for (const key of sessionKeys) {
        session[key] = window.sessionStorage.getItem(key);
      }
      return { local, session };
    },
    STORAGE_KEYS,
    SESSION_KEYS,
  );
}

async function restoreStorage(snapshot: StorageSnapshot): Promise<void> {
  await browser.execute(
    (state: StorageSnapshot) => {
      for (const [key, value] of Object.entries(state.local)) {
        if (value === null) {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, value);
        }
      }
      for (const [key, value] of Object.entries(state.session)) {
        if (value === null) {
          window.sessionStorage.removeItem(key);
        } else {
          window.sessionStorage.setItem(key, value);
        }
      }
    },
    snapshot,
  );
}

async function injectLiveAdminAuth(authJson: string, gatewayBase: string): Promise<void> {
  await browser.execute((json: string, serverBase: string) => {
    const auth = JSON.parse(json) as DenAuthState;
    window.sessionStorage.setItem('veslo.den.auth', json);
    window.localStorage.setItem('veslo.den.keepSignedIn', '0');
    window.localStorage.setItem('veslo.server.urlOverride', serverBase);
    window.localStorage.setItem('veslo.server.token', auth.token);
    window.localStorage.setItem('veslo.language', 'en');
    window.localStorage.setItem('veslo.onboardingComplete', '1');
    window.location.reload();
  }, authJson, gatewayBase);

  await waitForAppShellReady(30000);
}

async function waitForExpectedManagedAiAssignment(timeout = 45000): Promise<void> {
  await navigateToHash('/dashboard/settings');
  await browser.waitUntil(
    async () => {
      const text = normalizeSearchText(await readRootText());
      return (
        text.includes('ai access') &&
        text.includes('managed by the platform admin') &&
        text.includes('codex oauth') &&
        text.includes('gpt 5.4')
      );
    },
    {
      timeout,
      timeoutMsg: `Settings did not show expected codex_oauth/gpt-5.4 assignment within ${timeout}ms`,
    },
  );
}

async function waitForComposer(timeout = 20000) {
  const textbox = await $('div[contenteditable="true"][role="textbox"][aria-multiline="true"]');
  await textbox.waitForExist({ timeout });
  await textbox.waitForDisplayed({ timeout });
  return textbox;
}

async function setComposerText(text: string): Promise<void> {
  const textbox = await waitForComposer();
  await browser.execute(
    (element: HTMLElement, value: string) => {
      element.focus();
      element.replaceChildren(document.createTextNode(value));
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
  await browser.waitUntil(
    async () => browser.execute((element: HTMLElement, value: string) => element.textContent === value, textbox, text),
    {
      timeout: 10000,
      timeoutMsg: 'Composer text was not reflected in the editable node after input.',
    },
  );
}

async function clickSend(): Promise<void> {
  const textbox = await waitForComposer();
  await textbox.click();

  const sendButton = await $('button[title="Send"], button[title="Odeslat"]');
  await sendButton.waitForDisplayed({ timeout: 10000 });
  await browser.waitUntil(async () => !(await sendButton.getAttribute('disabled')), {
    timeout: 10000,
    timeoutMsg: 'Composer send button never became enabled.',
  });

  const before = await browser.execute((editor: HTMLElement, button: HTMLElement) => ({
    activeElementIsEditor: document.activeElement === editor,
    buttonDisabled: (button as HTMLButtonElement).disabled,
    editorText: editor.textContent ?? '',
  }), textbox, sendButton);
  console.log(`[live-admin-codex] before send=${JSON.stringify(before)}`);

  await sendButton.click();

  await browser.pause(1000);
  const after = await browser.execute((editor: HTMLElement) => ({
    activeElementIsEditor: document.activeElement === editor,
    editorText: editor.textContent ?? '',
  }), textbox);
  console.log(`[live-admin-codex] after send=${JSON.stringify(after)}`);
}

describe('Live admin Codex roundtrip', () => {
  it('should send a real Codex prompt from the Windows desktop app through DEN', async function () {
    this.timeout(180000);

    const { authJson, auth } = readLiveAdminAuth();
    const gatewayBase = readGatewayBase();
    const previousStorage = await snapshotStorage();

    try {
      console.log('[live-admin-codex] injecting admin session storage');
      await injectLiveAdminAuth(authJson, gatewayBase);
      console.log('[live-admin-codex] waiting for managed AI assignment');
      await waitForExpectedManagedAiAssignment();
      console.log('[live-admin-codex] managed AI assignment is visible');

      const rootText = await readRootText();
      const expectedUserMarker = auth.user?.email ?? auth.user?.id;
      if (expectedUserMarker) {
        expect(rootText).toContain(expectedUserMarker);
      }

      console.log('[live-admin-codex] opening session composer');
      await navigateToHash('/session');
      await waitForComposer();

      const token = `codex-live-admin-${Date.now()}`;
      const prompt = `Reply with exactly ${token}. No other words.`;

      console.log('[live-admin-codex] sending prompt');
      await setComposerText(prompt);
      await clickSend();

      console.log('[live-admin-codex] waiting for prompt response');
      try {
        await browser.waitUntil(
          async () => {
            const text = await readRootText();
            return countOccurrences(text, token) >= 2;
          },
          {
            timeout: 120000,
            interval: 1000,
            timeoutMsg: `Managed Codex response did not echo token ${token} within 120000ms`,
          },
        );
      } catch (error) {
        const text = await readRootText().catch(() => '');
        console.log(`[live-admin-codex] final token occurrences=${countOccurrences(text, token)}`);
        console.log(`[live-admin-codex] final visible text=${compactLogText(text)}`);
        throw error;
      }

      const finalText = await readRootText();
      expect(countOccurrences(finalText, token)).toBeGreaterThanOrEqual(2);
      expect(finalText.toLowerCase()).not.toContain('server unavailable');
      console.log('[live-admin-codex] prompt response rendered');
    } finally {
      await restoreStorage(previousStorage);
    }
  });
});
