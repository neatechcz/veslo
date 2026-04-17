import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';
import {
  exchangeAdminBrowserSession,
  findAdminUserByEmail,
  listAdminCredentials,
  listAdminUsers,
  startAdminBrowserSession,
  upsertAdminUserAiAccess,
  type AdminCredentialRecord,
} from '../helpers/live-admin-client.js';
import { waitForAdminBrowserCallback } from '../helpers/live-admin-check.js';
import { openUrlInSystemBrowser } from '../helpers/live-desktop-auth.js';

type DesktopAuthSnapshotFile = {
  authJson?: string | null;
  source?: string | null;
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
const DEFAULT_MODEL = 'gpt-5.4';

function readLiveAdminAuth(): { authJson: string; auth: DenAuthState; source: string | null } {
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

  return {
    authJson,
    auth,
    source: typeof snapshot.source === 'string' && snapshot.source.trim() ? snapshot.source.trim() : null,
  };
}

function readGatewayBase(): string {
  return (process.env.VESLO_E2E_GATEWAY_BASE?.trim() || DEFAULT_GATEWAY_BASE).replace(/\/+$/, '');
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function randomBase64Url(size: number): string {
  return randomBytes(size).toString('base64url');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
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

function isUnauthenticatedAuthGate(text: string): boolean {
  return text.includes('Sign in to Veslo') && text.includes('Sign in with Browser');
}

async function authenticateLiveAdmin(gatewayBase: string): Promise<string> {
  const providedToken = readOptionalEnv('VESLO_E2E_ADMIN_TOKEN');
  if (providedToken) {
    return providedToken;
  }

  const authState = randomBase64Url(32);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = sha256Base64Url(codeVerifier);

  const callback = await waitForAdminBrowserCallback({
    timeoutMs: 300000,
    onReady: async ({ redirectUri }) => {
      const start = await startAdminBrowserSession(fetch, gatewayBase, {
        intent: 'signin',
        redirectUri,
        state: authState,
        codeChallenge,
      });

      console.log('[live-admin-codex] opening admin browser sign-in');
      await openUrlInSystemBrowser(start.authorizeUrl);
    },
  });

  return exchangeAdminBrowserSession(fetch, gatewayBase, {
    code: callback.code,
    sessionId: callback.sessionId,
    state: authState,
    codeVerifier,
  });
}

function selectCodexCredential(credentials: AdminCredentialRecord[]): AdminCredentialRecord {
  const desiredId = readOptionalEnv('VESLO_E2E_CODEX_CREDENTIAL_ID');
  const desiredName = readOptionalEnv('VESLO_E2E_CODEX_CREDENTIAL_NAME')?.toLowerCase();
  const codexCredentials = credentials.filter((entry) => entry.provider === 'codex_oauth');

  if (desiredId) {
    const exact = codexCredentials.find((entry) => entry.id === desiredId);
    if (!exact) {
      throw new Error(`Codex credential ${desiredId} was not found in admin credentials.`);
    }
    return exact;
  }

  if (desiredName) {
    const match = codexCredentials.find((entry) => entry.name?.trim().toLowerCase() === desiredName);
    if (!match) {
      throw new Error(`Codex credential named ${desiredName} was not found in admin credentials.`);
    }
    return match;
  }

  const healthy = codexCredentials.find((entry) => (entry.state ?? '').trim().toLowerCase() === 'healthy');
  if (healthy) {
    return healthy;
  }

  const firstAvailable = codexCredentials.find((entry) => entry.id?.trim());
  if (firstAvailable) {
    return firstAvailable;
  }

  throw new Error('No shared codex_oauth credential is available in admin credentials.');
}

async function assignSharedCodexCredential(gatewayBase: string, adminToken: string, userEmail: string) {
  const [users, credentials] = await Promise.all([
    listAdminUsers(fetch, gatewayBase, adminToken),
    listAdminCredentials(fetch, gatewayBase, adminToken),
  ]);
  const user = findAdminUserByEmail(users, userEmail);
  if (!user?.id) {
    throw new Error(`Admin users did not include desktop user ${userEmail}.`);
  }

  const credential = selectCodexCredential(credentials);
  if (!credential.id) {
    throw new Error('Selected Codex credential is missing an id.');
  }

  const aiAccess = await upsertAdminUserAiAccess(fetch, gatewayBase, adminToken, user.id, {
    enabled: true,
    provider: 'codex_oauth',
    defaultModel: DEFAULT_MODEL,
    allowedModels: [DEFAULT_MODEL],
    credentialId: credential.id,
  });

  console.log(`[live-admin-codex] assigned credential ${credential.name ?? credential.id} to ${userEmail}`);
  return { user, credential, aiAccess };
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
    this.timeout(300000);

    const { auth, source } = readLiveAdminAuth();
    const gatewayBase = readGatewayBase();
    if (source !== 'e2e-live-browser') {
      throw new Error(
        `Desktop auth snapshot must come from the live browser seed flow. Received source=${source ?? '(missing)'}.`,
      );
    }

    console.log('[live-admin-codex] waiting for desktop app shell');
    await waitForAppShellReady(30000);
    const initialText = await readRootText();
    if (isUnauthenticatedAuthGate(initialText)) {
      throw new Error(
        'Desktop app is still unauthenticated. Seed live browser auth first and relaunch the E2E run.',
      );
    }

    console.log('[live-admin-codex] authenticating admin');
    const adminToken = await authenticateLiveAdmin(gatewayBase);
    const userEmail = auth.user?.email?.trim();
    if (!userEmail) {
      throw new Error('Desktop auth snapshot did not include the signed-in user email.');
    }

    await assignSharedCodexCredential(gatewayBase, adminToken, userEmail);

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
  });
});
