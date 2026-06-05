import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

type TauriInvokeResult<T> = {
  ok: boolean;
  value?: T;
  error?: string;
};

type VesloServerInfo = {
  running?: boolean;
  baseUrl?: string | null;
  clientToken?: string | null;
};

async function tauriInvoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await browser.executeAsync(
    (
      args: { command: string; payload: Record<string, unknown> },
      done: (value: TauriInvokeResult<unknown>) => void,
    ) => {
      const invoke = (
        window as typeof window & {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;

      if (typeof invoke !== 'function') {
        done({ ok: false, error: 'Tauri invoke bridge is unavailable.' });
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
  ) as TauriInvokeResult<T>;

  if (!result.ok) {
    throw new Error(`Tauri invoke failed for ${command}: ${result.error ?? 'unknown error'}`);
  }

  return result.value as T;
}

async function readRootText(): Promise<string> {
  const root = await $('#root');
  return root.getText();
}

async function clickButtonWithText(labels: string[], timeout = 10000): Promise<boolean> {
  const predicates = labels.map((label) => `normalize-space()="${label}"`).join(' or ');
  const buttons = await $$(`//button[${predicates}]`);
  let button: WebdriverIO.Element | null = null;
  for (const candidate of buttons) {
    if (await candidate.isDisplayed().catch(() => false)) {
      button = candidate;
      break;
    }
  }
  if (!button) return false;
  await button.waitForDisplayed({ timeout });
  await browser.waitUntil(async () => button!.isEnabled(), {
    timeout,
    interval: 250,
    timeoutMsg: `Button ${labels.join('/')} did not become enabled.`,
  });
  await button.click();
  return true;
}

async function completeFirstRunOnboardingIfVisible(timeout = 120000): Promise<void> {
  const text = await readRootText();
  if (!text.includes('Choose your language') && !text.includes('Vyberte jazyk aplikace')) {
    return;
  }

  await clickButtonWithText(['English']);
  const continued = await clickButtonWithText(['Continue', 'Pokračovat']);
  if (!continued) {
    throw new Error('Language onboarding was visible, but the continue button was not found.');
  }

  await browser.waitUntil(
    async () => {
      const nextText = await readRootText();
      return !nextText.includes('Choose your language') && !nextText.includes('Vyberte jazyk aplikace');
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: 'Language onboarding did not complete.',
    },
  );
}

async function waitForComposer(timeout = 30000) {
  const textbox = await $('[role="textbox"]');
  try {
    await textbox.waitForExist({ timeout });
    await textbox.waitForDisplayed({ timeout });
  } catch (error) {
    const text = await readRootText().catch(() => '');
    throw new Error(`Composer did not appear. Visible text: ${compactText(text).slice(0, 1200)}`, { cause: error });
  }
  return textbox;
}

async function openPrivateWorkspaceComposerIfVisible(timeout = 30000): Promise<void> {
  const text = await readRootText();
  if (!text.includes('Start a chat') && !text.includes('Začít chat')) {
    return;
  }

  const chatButton = await $(
    '//h3[normalize-space()="Start a chat" or normalize-space()="Začít chat"]/following::button[normalize-space()="Chat" or normalize-space()="聊天"][1]',
  );
  await chatButton.waitForDisplayed({ timeout });
  await browser.waitUntil(async () => chatButton.isEnabled(), {
    timeout,
    interval: 250,
    timeoutMsg: 'Private workspace Chat button did not become enabled.',
  });
  await chatButton.click();
  await waitForComposer(timeout);
}

async function ensureLocalVesloServerReady(timeout = 60000): Promise<void> {
  await browser.setTimeout({ script: timeout });
  await tauriInvoke('veslo_server_restart');

  await browser.waitUntil(
    async () => {
      const info = await tauriInvoke<VesloServerInfo>('veslo_server_info').catch(() => null);
      return Boolean(info?.running && info?.baseUrl && info?.clientToken);
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `Local Veslo server did not become ready within ${timeout}ms`,
    },
  );

  await browser.execute(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

async function waitForManagedRuntimeReady(timeout = 60000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(() => ({
        baseUrl: window.localStorage.getItem('veslo.baseUrl') ?? '',
        defaultModel: window.localStorage.getItem('veslo.defaultModel') ?? '',
        rootText: document.querySelector('#root')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 800) ?? '',
      }));
      return state.baseUrl.startsWith('http://127.0.0.1:') && state.defaultModel.includes('gpt-5.4');
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `Managed runtime did not become ready within ${timeout}ms`,
    },
  );
}

async function setComposerText(text: string): Promise<void> {
  const textbox = await waitForComposer();
  await textbox.click();
  await textbox.setValue(text);
  await browser.waitUntil(
    async () => browser.execute((element: HTMLElement, value: string) => element.textContent === value, textbox, text),
    {
      timeout: 10000,
      timeoutMsg: 'Composer text was not reflected in the editable node after input.',
    },
  );
}

async function findVisibleButton(selectors: string[], timeout = 10000): Promise<WebdriverIO.Element> {
  let button: WebdriverIO.Element | null = null;
  await browser.waitUntil(
    async () => {
      for (const candidate of await $$(selectors.join(', '))) {
        if (await candidate.isDisplayed().catch(() => false)) {
          button = candidate;
          return true;
        }
      }
      return false;
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `Visible button not found for selectors: ${selectors.join(', ')}`,
    },
  );
  return button!;
}

async function clickSendButton(): Promise<void> {
  const sendButton = await findVisibleButton([
    'button[title="Send"]',
    'button[aria-label="Send"]',
    'button[title="Odeslat"]',
    'button[aria-label="Odeslat"]',
    'button[title="Queue message"]',
    'button[aria-label="Queue message"]',
    'button[title="Zařadit zprávu"]',
    'button[aria-label="Zařadit zprávu"]',
  ]);
  await browser.waitUntil(async () => sendButton.isEnabled(), {
    timeout: 10000,
    interval: 250,
    timeoutMsg: 'Send button did not become enabled.',
  });
  await sendButton.click();
}

async function waitForRunIndicator(timeout = 20000): Promise<void> {
  let diagnostics: unknown = null;
  await browser.waitUntil(
    async () => {
      diagnostics = await browser.execute(() => ({
        rootText: document.querySelector('#root')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 1600) ?? '',
        hash: window.location.hash,
        baseUrl: window.localStorage.getItem('veslo.baseUrl'),
        defaultModel: window.localStorage.getItem('veslo.defaultModel'),
        runVisible: Boolean((document.querySelector('[data-testid="session-run-indicator"]') as HTMLElement | null)?.offsetParent),
        buttons: Array.from(document.querySelectorAll('button')).map((button) => ({
          text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          title: button.getAttribute('title'),
          label: button.getAttribute('aria-label'),
          disabled: button.disabled,
        })).slice(-20),
      }));
      return Boolean((diagnostics as { runVisible?: boolean }).runVisible);
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `Run indicator did not appear after send. Diagnostics=${JSON.stringify(diagnostics)}`,
    },
  );
}

async function readVisibleStopButtons(): Promise<Array<{ text: string; title: string | null; label: string | null }>> {
  return browser.execute(() => {
    return Array.from(document.querySelectorAll('button'))
      .map((button) => ({
        text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        title: button.getAttribute('title'),
        label: button.getAttribute('aria-label'),
      }))
      .filter((entry) =>
        entry.title === 'Stop' ||
        entry.label === 'Stop' ||
        entry.title === 'Press Esc again to stop' ||
        entry.label === 'Press Esc again to stop' ||
        entry.text === 'Esc',
      );
  }) as Promise<Array<{ text: string; title: string | null; label: string | null }>>;
}

describe('Escape stop confirmation', () => {
  it('requires a second Escape before stopping an active run', async function () {
    this.timeout(240000);

    if (process.env.E2E_MANAGED_AI_GATEWAY_FIXTURE?.trim() !== '1') {
      this.skip();
    }
    const delayMs = Number(process.env.E2E_MANAGED_AI_RESPONSE_DELAY_MS ?? '0');
    if (!Number.isFinite(delayMs) || delayMs < 5000) {
      throw new Error('Set E2E_MANAGED_AI_RESPONSE_DELAY_MS=5000 or higher for this spec.');
    }

    await completeFirstRunOnboardingIfVisible();
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 30000);
    await openPrivateWorkspaceComposerIfVisible();
    await ensureLocalVesloServerReady();
    await waitForManagedRuntimeReady();
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 30000);
    await waitForComposer();

    const token = `escape-stop-${Date.now()}`;
    await setComposerText(`Desktop E2E Escape stop confirmation ${token}. Delay response long enough to test stop.`);
    await clickSendButton();
    await waitForRunIndicator();

    await browser.keys('Escape');
    await browser.waitUntil(
      async () => {
        const buttons = await readVisibleStopButtons();
        return buttons.some((button) => button.text === 'Esc' && button.title === 'Press Esc again to stop');
      },
      {
        timeout: 10000,
        interval: 200,
        timeoutMsg: `Stop button did not switch to Esc confirmation. Buttons=${JSON.stringify(await readVisibleStopButtons().catch(() => []))}`,
      },
    );

    expect(await $('[data-testid="session-run-indicator"]').isDisplayed()).toBe(true);

    await browser.keys('Escape');
    await browser.waitUntil(
      async () => {
        const buttons = await readVisibleStopButtons();
        const stillConfirming = buttons.some((button) => button.text === 'Esc' || button.title === 'Press Esc again to stop');
        const runVisible = await $('[data-testid="session-run-indicator"]').isDisplayed().catch(() => false);
        return !stillConfirming && !runVisible;
      },
      {
        timeout: 30000,
        interval: 250,
        timeoutMsg: `Second Escape did not clear the active run. Buttons=${JSON.stringify(await readVisibleStopButtons().catch(() => []))}`,
      },
    );
  });
});
