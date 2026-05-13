import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

const VISUAL_DIFF_LIMIT = 1.5;
const UPDATE_BASELINES = process.argv.includes('--update-visual-baseline');

type VisualCompareResult = number | { misMatchPercentage: number } | Record<string, number | { misMatchPercentage: number }>;

function mismatchPercentage(result: VisualCompareResult): number {
  if (typeof result === 'number') return result;
  const direct = (result as { misMatchPercentage?: unknown }).misMatchPercentage;
  if (typeof direct === 'number') return direct;
  return Math.max(...Object.values(result).map(mismatchPercentage));
}

async function waitForRoute(hashFragment: string, timeout = 10000): Promise<void> {
  await waitForHashRoute(hashFragment, timeout);
}

async function waitForText(text: string, timeout = 15000): Promise<void> {
  const body = await $('body');
  await browser.waitUntil(
    async () => (await body.getText()).includes(text),
    { timeout, timeoutMsg: `Text "${text}" did not render within ${timeout}ms` },
  );
}

async function waitForTextGone(text: string, timeout = 15000): Promise<void> {
  const body = await $('body');
  await browser.waitUntil(
    async () => !(await body.getText()).includes(text),
    { timeout, timeoutMsg: `Text "${text}" was still rendered after ${timeout}ms` },
  );
}

async function waitForVisualIdle(): Promise<void> {
  await browser.waitUntil(
    async () => browser.execute(() => !document.fonts || document.fonts.status === 'loaded'),
    { timeout: 5000, interval: 100, timeoutMsg: 'Fonts did not finish loading before visual snapshot' },
  ).catch(() => undefined);
  await browser.pause(250);
}

async function installVisualStabilityCss(): Promise<void> {
  await browser.execute(() => {
    const id = 'e2e-visual-stability-css';
    if (document.getElementById(id)) return;

    const style = document.createElement('style');
    style.id = id;
    style.textContent = `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        animation-iteration-count: 1 !important;
        caret-color: transparent !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }

      [data-session-sidebar-row="true"],
      [data-session-sidebar-row="true"] ~ * {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  });
}

async function positionWindowForVisualSnapshots(): Promise<void> {
  await browser.execute(async () => {
    const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi');
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.show();
    await win.unminimize();
    await win.setSize(new LogicalSize(1180, 820));
    await win.setPosition(new LogicalPosition(80, 80));
    await win.setFocus();
  });
}

async function prepareVisualAppState(): Promise<void> {
  const root = await $('#root');
  await root.waitForExist({ timeout: 10000 });

  await browser.execute(() => {
    window.localStorage.clear();
    window.localStorage.setItem('veslo.language', 'en');
    window.localStorage.setItem('veslo.startupPref', 'local');
    window.localStorage.setItem('veslo.themePref', 'light');
    window.localStorage.setItem('veslo.global.sidebar.docked.v1', JSON.stringify({ left: true, right: true }));
  });

  await navigateToHash('/session');
  await waitForRoute('#/session');
  await browser.refresh();
  await waitForRoute('#/session');
  await installVisualStabilityCss();
  await positionWindowForVisualSnapshots();
  await waitForVisualIdle();
}

async function openVisualRoute(path: string, hashFragment: string, readyText: string): Promise<void> {
  await navigateToHash(path);
  await waitForRoute(hashFragment);
  await waitForText(readyText);
  await waitForTextGone('Loading tasks...');
  await waitForTextGone('Opening worker', 20000);
  await waitForTextGone('Checking your connection', 20000);
  await installVisualStabilityCss();
  await positionWindowForVisualSnapshots();
  await waitForVisualIdle();
}

function expectVisualDiff(result: VisualCompareResult): void {
  if (UPDATE_BASELINES) return;
  expect(mismatchPercentage(result)).toBeLessThanOrEqual(VISUAL_DIFF_LIMIT);
}

describe('Visual regression', () => {
  before(async () => {
    await prepareVisualAppState();
  });

  it('should match the initial app state', async () => {
    await openVisualRoute('/session', '#/session', 'Ask Veslo');

    const result = await browser.checkScreen('initial-state', {});
    expectVisualDiff(result);
  });

  it('should match the settings page', async () => {
    await openVisualRoute('/dashboard/settings', '#/dashboard/settings', 'Settings');

    const result = await browser.checkScreen('settings-page', {});
    expectVisualDiff(result);
  });

  it('should match the skills page', async () => {
    await openVisualRoute('/dashboard/skills', '#/dashboard/skills', 'Skills');

    const result = await browser.checkScreen('skills-page', {});
    expectVisualDiff(result);
  });

  it('should match the session view', async () => {
    await openVisualRoute('/session', '#/session', 'Ask Veslo');

    const result = await browser.checkScreen('session-view', {});
    expectVisualDiff(result);
  });
});
