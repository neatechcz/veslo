import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

const MORE_ACTIONS_MENU_ID = 'sidebar-more-actions-menu';
const SIDEBAR_VIEW_MODE_KEY = 'veslo.sidebar-session-view.v1';

type LocaleCopy = {
  addDirectoryProject: string;
  moreActions: string;
  archivedItems: string;
  archivedTab: string;
  searchSessions: string;
  byProject: string;
  recent: string;
  createSessionInProject: string;
  archivedSection: string;
};

const UI_COPY: Record<'en' | 'cs' | 'zh', LocaleCopy> = {
  en: {
    addDirectoryProject: 'Add directory / project',
    moreActions: 'More actions',
    archivedItems: 'Archived items',
    archivedTab: 'Archived',
    searchSessions: 'Search sessions',
    byProject: 'By project',
    recent: 'Recent',
    createSessionInProject: 'Create session in this project',
    archivedSection: 'Archived sessions',
  },
  cs: {
    addDirectoryProject: 'Přidat adresář / projekt',
    moreActions: 'Další akce',
    archivedItems: 'Archivované položky',
    archivedTab: 'Archivované',
    searchSessions: 'Hledat relace',
    byProject: 'Podle projektu',
    recent: 'Nedávné',
    createSessionInProject: 'Vytvořit relaci v tomto projektu',
    archivedSection: 'Archivované relace',
  },
  zh: {
    addDirectoryProject: '添加目录 / 项目',
    moreActions: '更多操作',
    archivedItems: '已归档项目',
    archivedTab: '已归档',
    searchSessions: 'Search sessions',
    byProject: '按项目',
    recent: '最近',
    createSessionInProject: '在此项目中创建会话',
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

async function getSettingsTabButtonClass(label: string): Promise<string | null> {
  return browser.execute((expectedLabel: string) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => normalize(candidate.textContent ?? '') === normalize(expectedLabel),
    );

    return button?.className ?? null;
  }, label);
}

async function readProjectPlusDisabled(label: string): Promise<boolean | null> {
  return browser.execute((expectedLabel: string) => {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${expectedLabel}"]`);
    return button ? button.disabled : null;
  }, label);
}

describe('Sidebar overflow actions', () => {
  before(async () => {
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);

    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });
  });

  it('shows the approved top rail and routes archived items to the archived settings tab', async () => {
    const locale = await getLocale();
    const copy = UI_COPY[locale];

    await browser.waitUntil(
      async () => {
        const labels = await readTopRailLabels([copy.addDirectoryProject, copy.moreActions]);
        return (
          labels.length === 2 &&
          labels[0] === copy.addDirectoryProject &&
          labels[1] === copy.moreActions
        );
      },
      {
        timeout: 10000,
        interval: 250,
        timeoutMsg: 'Top rail did not expose the approved primary action model.',
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

    await waitForHashRoute('#/dashboard/settings', 10000);

    await browser.waitUntil(
      async () => bodyContainsLabel(copy.archivedSection),
      {
        timeout: 10000,
        interval: 250,
        timeoutMsg: 'Archived sessions section was not visible after navigation.',
      },
    );

    expect(await bodyContainsLabel(copy.archivedSection)).toBe(true);

    const archivedTabClass = await getSettingsTabButtonClass(copy.archivedTab);
    expect(archivedTabClass).not.toBeNull();
    expect(archivedTabClass).toContain('bg-gray-12/10');
    expect(archivedTabClass).toContain('text-white');
  });

  it('keeps the per-project plus enabled in by-project browsing mode', async () => {
    await browser.execute((key: string) => {
      window.localStorage.setItem(key, 'by-project');
    }, SIDEBAR_VIEW_MODE_KEY);
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);
    await browser.refresh();
    await waitForHashRoute('#/session', 5000);

    const locale = await getLocale();
    const copy = UI_COPY[locale];

    await browser.waitUntil(
      async () => (await readProjectPlusDisabled(copy.createSessionInProject)) !== null,
      {
        timeout: 10000,
        interval: 250,
        timeoutMsg: 'Project plus button was not rendered in by-project mode.',
      },
    );

    expect(await readProjectPlusDisabled(copy.createSessionInProject)).toBe(false);
  });
});
