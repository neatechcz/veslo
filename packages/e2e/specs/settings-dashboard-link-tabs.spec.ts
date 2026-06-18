import { expect } from '@wdio/globals';

import { currentHashRoute, navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

type SettingsTabSnapshot = {
  kind: string | null;
  tab: string | null;
  label: string;
  current: string | null;
};

async function openSettings(): Promise<void> {
  await navigateToHash('/dashboard/settings');
  await waitForHashRoute('#/dashboard/settings');
  await $('button[data-settings-nav-tab="general"]').waitForExist({ timeout: 10000 });
}

async function settingsTabs(): Promise<SettingsTabSnapshot[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-settings-nav-tab]')).map((button) => ({
      kind: button.dataset.settingsNavKind ?? null,
      tab: button.dataset.settingsNavTab ?? null,
      label: button.textContent?.trim() ?? '',
      current: button.getAttribute('aria-current'),
    })),
  );
}

describe('Settings dashboard link tabs', () => {
  it('shows Settings-owned tabs followed by dashboard link tabs', async () => {
    await openSettings();

    expect(await settingsTabs()).toEqual([
      { kind: 'settings', tab: 'general', label: 'General', current: 'page' },
      { kind: 'settings', tab: 'archived', label: 'Archived', current: null },
      { kind: 'dashboard', tab: 'soul', label: 'Soul', current: null },
      { kind: 'dashboard', tab: 'skills', label: 'Skills', current: null },
      { kind: 'dashboard', tab: 'mcp', label: 'Extensions', current: null },
    ]);
  });

  it('routes dashboard link tabs to the existing dashboard pages', async () => {
    const destinations = [
      ['soul', '#/dashboard/soul'],
      ['skills', '#/dashboard/skills'],
      ['mcp', '#/dashboard/mcp'],
    ] as const;

    for (const [tab, route] of destinations) {
      await openSettings();
      await $(`button[data-settings-nav-tab="${tab}"]`).click();
      await waitForHashRoute(route);
      expect(await currentHashRoute()).toContain(route);
    }
  });
});
