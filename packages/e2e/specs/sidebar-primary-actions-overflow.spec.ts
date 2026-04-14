import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';

const MORE_ACTIONS_MENU_ID = 'sidebar-more-actions-menu';

type LocaleCopy = {
  newSession: string;
  addDirectoryProject: string;
  moreActions: string;
  archivedItems: string;
  searchSessions: string;
  byProject: string;
  recent: string;
  archivedSection: string;
};

const UI_COPY: Record<'en' | 'cs' | 'zh', LocaleCopy> = {
  en: {
    newSession: 'New session',
    addDirectoryProject: 'Add directory / project',
    moreActions: 'More actions',
    archivedItems: 'Archived items',
    searchSessions: 'Search sessions',
    byProject: 'By project',
    recent: 'Recent',
    archivedSection: 'Archived sessions',
  },
  cs: {
    newSession: 'Nová relace',
    addDirectoryProject: 'Přidat adresář / projekt',
    moreActions: 'Další akce',
    archivedItems: 'Archivované položky',
    searchSessions: 'Hledat relace',
    byProject: 'Podle projektu',
    recent: 'Nedávné',
    archivedSection: 'Archivované relace',
  },
  zh: {
    newSession: 'New session',
    addDirectoryProject: '添加目录 / 项目',
    moreActions: '更多操作',
    archivedItems: '已归档项目',
    searchSessions: 'Search sessions',
    byProject: '按项目',
    recent: '最近',
    archivedSection: '已归档会话',
  },
};

async function getLocale(): Promise<keyof typeof UI_COPY> {
  const locale = await browser.execute(() => document.documentElement.getAttribute('lang')?.trim() ?? 'en');
  return locale === 'cs' || locale === 'zh' ? locale : 'en';
}

async function readTopRailLabels(expected: string[]): Promise<string[]> {
  return browser.execute((labels: string[]) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const expectedLabels = new Set(labels.map(normalize));

    return Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-tooltip]'))
      .map((button) => normalize(button.getAttribute('data-tooltip') ?? ''))
      .filter((label) => expectedLabels.has(label));
  }, expected);
}

async function clickButtonByTooltip(expected: string[]): Promise<void> {
  await browser.execute((labels: string[]) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const expectedLabels = new Set(labels.map(normalize));
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-tooltip]')).find(
      (candidate) => expectedLabels.has(normalize(candidate.getAttribute('data-tooltip') ?? '')),
    );

    if (!button) {
      throw new Error(`Unable to find a button with tooltip ${labels.join(', ')}`);
    }

    button.click();
  }, expected);
}

async function readOverflowMenuLabels(): Promise<string[]> {
  return browser.execute((menuId: string) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const menu = document.getElementById(menuId);

    if (!menu) return [];

    return Array.from(menu.querySelectorAll<HTMLButtonElement>('button'))
      .map((button) => normalize(button.textContent ?? ''))
      .filter(Boolean);
  }, MORE_ACTIONS_MENU_ID);
}

async function clickOverflowMenuItem(label: string): Promise<void> {
  await browser.execute(
    ({ menuId, expectedLabel }: { menuId: string; expectedLabel: string }) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const menu = document.getElementById(menuId);

      if (!menu) {
        throw new Error(`Overflow menu ${menuId} was not found`);
      }

      const button = Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) => normalize(candidate.textContent ?? '') === normalize(expectedLabel),
      );

      if (!button) {
        throw new Error(`Overflow menu item "${expectedLabel}" was not found`);
      }

      button.click();
    },
    {
      menuId: MORE_ACTIONS_MENU_ID,
      expectedLabel: label,
    },
  );
}

async function bodyContainsLabel(label: string): Promise<boolean> {
  return browser.execute((expectedLabel: string) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    return normalize(document.body.innerText).includes(normalize(expectedLabel));
  }, label);
}

describe('Sidebar overflow actions', () => {
  before(async () => {
    await navigateToHash('/session');
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes('#/session'),
      { timeout: 5000, timeoutMsg: 'Session route did not load.' },
    );

    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });
  });

  it('shows the approved top rail and routes archived items to the archived settings tab', async () => {
    const locale = await getLocale();
    const copy = UI_COPY[locale];

    await browser.waitUntil(
      async () => {
        const labels = await readTopRailLabels([copy.newSession, copy.addDirectoryProject, copy.moreActions]);
        return (
          labels.length === 3 &&
          labels[0] === copy.newSession &&
          labels[1] === copy.addDirectoryProject &&
          labels[2] === copy.moreActions
        );
      },
      {
        timeout: 10000,
        interval: 250,
        timeoutMsg: 'Top rail did not expose the approved three-button model.',
      },
    );

    await clickButtonByTooltip([copy.moreActions]);

    await browser.waitUntil(
      async () => (await readOverflowMenuLabels()).length === 4,
      {
        timeout: 5000,
        interval: 250,
        timeoutMsg: 'Overflow menu did not render the approved secondary actions.',
      },
    );

    const overflowMenuLabels = await readOverflowMenuLabels();
    expect(overflowMenuLabels).toEqual([
      copy.archivedItems,
      copy.searchSessions,
      copy.byProject,
      copy.recent,
    ]);

    await clickOverflowMenuItem(copy.archivedItems);

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes('#/dashboard/settings'),
      {
        timeout: 10000,
        interval: 250,
        timeoutMsg: 'Archived items did not navigate to settings.',
      },
    );

    await browser.waitUntil(
      async () => bodyContainsLabel(copy.archivedSection),
      {
        timeout: 10000,
        interval: 250,
        timeoutMsg: 'Archived sessions section was not visible after navigation.',
      },
    );

    expect(await bodyContainsLabel(copy.archivedSection)).toBe(true);
    expect(await bodyContainsLabel('Providers')).toBe(false);
  });
});
