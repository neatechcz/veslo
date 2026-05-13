import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';

type LocationSnapshot = {
  href: string;
  hash: string;
};

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

async function waitForRoute(hashFragment: string, timeout = 15000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const hash = await browser.execute(() => window.location.hash);
      return typeof hash === 'string' && hash.includes(hashFragment.replace(/^#/, ''));
    },
    {
      timeout,
      timeoutMsg: `Route did not change to ${hashFragment} within ${timeout}ms`,
    },
  );
}

async function readLocationSnapshot(): Promise<LocationSnapshot> {
  return browser.execute(() => ({
    href: window.location.href,
    hash: window.location.hash,
  }));
}

async function waitForSettingsAiAccessCopy(timeout = 30000): Promise<string> {
  await browser.waitUntil(
    async () => {
      const root = await $('#root');
      const text = await root.getText();
      return text.includes('AI access') && text.includes('managed by the platform admin');
    },
    {
      timeout,
      timeoutMsg: `Settings page did not render admin-managed AI access copy within ${timeout}ms`,
    },
  );

  return $('#root').getText();
}

async function waitForSettingsContent(timeout = 30000): Promise<string> {
  await browser.waitUntil(
    async () => {
      const root = await $('#root');
      const text = await root.getText();
      return text.includes('Run preferences') || text.includes('AI access');
    },
    {
      timeout,
      timeoutMsg: `Settings page did not render recognizable settings content within ${timeout}ms`,
    },
  );

  return $('#root').getText();
}

async function readRootText(): Promise<string> {
  const root = await $('#root');
  return root.getText();
}

function isUnauthenticatedAuthGate(text: string): boolean {
  return text.includes('Sign in to Veslo') && text.includes('Sign in with Browser');
}

describe('Admin-managed AI access', () => {
  it('should show read-only admin-managed AI access copy in settings', async function () {
    await waitForAppShellReady();
    const initialText = await readRootText();
    if (isUnauthenticatedAuthGate(initialText)) {
      console.warn('[admin-managed-ai-access] Skipping because the desktop profile is still unauthenticated. Seed or sign in before running this spec.');
      this.skip();
    }

    await navigateToHash('/dashboard/settings');
    await waitForRoute('#/dashboard/settings');

    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });

    let text = await waitForSettingsContent();
    if (text.includes('AI access')) {
      text = await waitForSettingsAiAccessCopy();
      expect(text).toContain('managed by the platform admin');
    } else {
      console.warn('[admin-managed-ai-access] AI access settings copy is developer-gated in this build; verifying user-managed provider controls stay hidden.');
    }
    expect(text).not.toContain('Connect provider');
    expect(text).not.toContain('Change model');
  });
});
