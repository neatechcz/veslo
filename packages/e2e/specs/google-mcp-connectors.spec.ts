import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

type GoogleCard = {
  name: string;
  text: string;
  disabled: boolean;
};

type McpPageSnapshot = {
  availableGoogleCards: GoogleCard[];
  installedRows: GoogleCard[];
  modalText: string | null;
  bodyText: string;
};

const GOOGLE_CARD_NAMES = ['Google Gmail', 'Google Calendar', 'Google Drive'] as const;
const INSTALLED_GMAIL_KEY = 'google-gmail';
const FIXTURE_ENABLED = process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE?.trim() === '1';

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function waitForBodyText(expected: string, timeout = 15_000): Promise<string> {
  let latest = '';
  await browser.waitUntil(
    async () => {
      latest = await browser.execute(() => document.body.textContent ?? '');
      return latest.includes(expected);
    },
    {
      timeout,
      timeoutMsg: `Body did not include ${expected} within ${timeout}ms. Latest body: ${normalizeText(latest).slice(0, 1000)}`,
    },
  );

  return browser.execute(() => document.body.textContent ?? '');
}

async function readMcpPageSnapshot(): Promise<McpPageSnapshot> {
  return browser.execute(() => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const headingSection = (label: string) => {
      const normalizedLabel = normalize(label).toLowerCase();
      const heading = Array.from(document.querySelectorAll<HTMLElement>('h3'))
        .find((candidate) => normalize(candidate.textContent ?? candidate.innerText).toLowerCase() === normalizedLabel);
      return heading?.parentElement?.parentElement ?? null;
    };
    const availableSection = headingSection('Available apps');
    const installedSection = headingSection('Your apps');
    const readButtonCards = (root: Element | null, names: readonly string[], fromHeading = false): GoogleCard[] => {
      return Array.from(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .map((button) => {
          const label = fromHeading
            ? button.querySelector<HTMLElement>('h4')?.textContent ?? ''
            : button.querySelector<HTMLElement>('.text-sm.font-medium')?.textContent ??
              button.querySelector<HTMLElement>('h4')?.textContent ??
              '';
          return {
            name: normalize(label),
            text: normalize(button.textContent ?? button.innerText),
            disabled: button.disabled,
          };
        })
        .filter((card) => names.includes(card.name));
    };
    const modal = document.querySelector<HTMLElement>('[data-modal-shell-root], [role="dialog"]');

    return {
      availableGoogleCards: readButtonCards(availableSection, [
        'Google Gmail',
        'Google Calendar',
        'Google Drive',
        'Google Workspace',
      ], true),
      installedRows: readButtonCards(installedSection, [
        'google-gmail',
        'google-calendar',
        'google-drive',
        'Google Gmail',
        'Google Calendar',
        'Google Drive',
      ]),
      modalText: modal ? normalize(modal.textContent ?? modal.innerText) : null,
      bodyText: normalize(document.body.textContent ?? document.body.innerText),
    };
  });
}

async function waitForGoogleCatalogCards(): Promise<McpPageSnapshot> {
  let latest: McpPageSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readMcpPageSnapshot();
      const names = new Set(latest.availableGoogleCards.map((card) => card.name));
      return GOOGLE_CARD_NAMES.every((name) => names.has(name));
    },
    {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: 'Google Workspace MCP catalog cards did not appear.',
    },
  );

  return latest ?? await readMcpPageSnapshot();
}

async function clickAvailableGoogleCard(name: string): Promise<void> {
  const result = await browser.execute((cardName) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const normalizeHeading = (value: string) => normalize(value).toLowerCase();
    const heading = Array.from(document.querySelectorAll<HTMLElement>('h3'))
      .find((candidate) => normalizeHeading(candidate.textContent ?? candidate.innerText) === 'available apps');
    const section = heading?.parentElement?.parentElement ?? null;
    const button = Array.from(section?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find((candidate) => normalize(candidate.querySelector<HTMLElement>('h4')?.textContent ?? '') === cardName);
    if (!button) {
      return { clicked: false, reason: 'missing' };
    }
    if (button.disabled) {
      return { clicked: false, reason: 'disabled' };
    }
    button.click();
    return { clicked: true, reason: null };
  }, name);

  expect(result).toEqual({ clicked: true, reason: null });
}

async function waitForInstalledGmail(): Promise<McpPageSnapshot> {
  let latest: McpPageSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readMcpPageSnapshot();
      return latest.installedRows.some((row) => row.name === INSTALLED_GMAIL_KEY);
    },
    {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: `Configured MCP list did not include ${INSTALLED_GMAIL_KEY}.`,
    },
  );

  return latest ?? await readMcpPageSnapshot();
}

(FIXTURE_ENABLED ? describe : describe.skip)('Google Workspace MCP connectors', () => {
  it('shows separate Google catalog cards and configures only Gmail without completing OAuth', async () => {
    await navigateToHash('/dashboard/mcp');
    await waitForHashRoute('#/dashboard/mcp');

    await waitForBodyText('Control Chrome', 30_000);
    const initial = await waitForGoogleCatalogCards();
    const initialNames = initial.availableGoogleCards.map((card) => card.name).sort();

    expect(initialNames).toEqual([...GOOGLE_CARD_NAMES].sort());
    expect(initial.availableGoogleCards).toHaveLength(3);
    expect(initial.availableGoogleCards.some((card) => card.name === 'Google Workspace')).toBe(false);
    expect(initial.availableGoogleCards.every((card) => card.text.includes('Shared provider: Google'))).toBe(true);
    expect(initial.installedRows.some((row) => row.name === INSTALLED_GMAIL_KEY)).toBe(false);

    await clickAvailableGoogleCard('Google Gmail');
    const installed = await waitForInstalledGmail();
    const installedNames = installed.installedRows.map((row) => row.name);
    const availableNames = installed.availableGoogleCards.map((card) => card.name);

    expect(installedNames).toContain(INSTALLED_GMAIL_KEY);
    expect(installedNames).not.toContain('google-calendar');
    expect(installedNames).not.toContain('google-drive');
    expect(installedNames).not.toContain('Google Calendar');
    expect(installedNames).not.toContain('Google Drive');
    expect(availableNames).toContain('Google Calendar');
    expect(availableNames).toContain('Google Drive');

    if (installed.modalText) {
      const modalText = normalizeText(installed.modalText);
      expect(modalText).toContain('Authorize the account in your browser');
      expect(modalText).toContain('user OAuth tokens stay in the local MCP/OpenCode runtime');
      expect(modalText).toContain('not stored in Veslo cloud');
    }
  });
});
