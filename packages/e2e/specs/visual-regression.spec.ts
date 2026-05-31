import { expect } from '@wdio/globals';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

const VISUAL_DIFF_LIMIT = 1.5;
const UPDATE_BASELINES = process.argv.includes('--update-visual-baseline');
const isolatedProfileRoot = () => join(process.cwd(), '.tmp-veslo-home');
const globalSkillsRoot = () => join(isolatedProfileRoot(), '.config', 'opencode', 'skills');
const workspaceRoot = () => join(isolatedProfileRoot(), 'workspaces', 'visual-workspace');
const workspaceSkillsRoot = () => join(workspaceRoot(), '.opencode', 'skills');

type VisualCompareResult = number | { misMatchPercentage: number } | Record<string, number | { misMatchPercentage: number }>;
type TauriInvokeResult<T> = {
  ok: boolean;
  value?: T;
  error?: string;
};

function mismatchPercentage(result: VisualCompareResult): number {
  if (typeof result === 'number') return result;
  const direct = (result as { misMatchPercentage?: unknown }).misMatchPercentage;
  if (typeof direct === 'number') return direct;
  return Math.max(...Object.values(result).map(mismatchPercentage));
}

function removeSkillChildren(root: string, shouldRemove: (name: string) => boolean): void {
  if (!existsSync(root)) return;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (shouldRemove(entry.name)) {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

function cleanupVisualSkillFixtures(): void {
  if (process.env.E2E_USE_EXISTING_PROFILE?.trim() === '1') return;

  removeSkillChildren(globalSkillsRoot(), (name) => name.startsWith('e2e-') || name === 'veslo-managed');
  removeSkillChildren(
    workspaceSkillsRoot(),
    (name) => name.startsWith('e2e-') || name === 'veslo-managed' || name === 'brainstorming',
  );
  rmSync(join(workspaceRoot(), '.opencode', 'veslo.skills.lock.json'), { force: true });
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
        (error) => done({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    },
    { command, payload },
  ) as TauriInvokeResult<T>;

  if (!result.ok) {
    throw new Error(`Tauri invoke failed for ${command}: ${result.error ?? 'unknown error'}`);
  }

  return result.value as T;
}

async function setActiveVisualWorkspace(): Promise<void> {
  await tauriInvoke('workspace_set_active', {
    workspaceId: 'e2e-visual-workspace',
    promoteToFront: false,
  });
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

async function refreshSkillsInventoryFromUi(): Promise<void> {
  const clicked = await browser.execute(() => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const refreshButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="skills-page"] button'),
    ).find((button) => normalize(button.textContent ?? '') === 'Refresh');

    refreshButton?.click();
    return Boolean(refreshButton);
  });

  expect(clicked).toBe(true);
}

async function setVisualSkillsInventoryFilters(): Promise<void> {
  const changed = await browser.execute(() => {
    const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('[data-testid="skills-page"] select'));
    const scopeSelect = selects.find((select) =>
      Array.from(select.options).some((option) => option.value === 'user-global') &&
      Array.from(select.options).some((option) => option.value === 'workspace')
    );
    const workspaceSelect = selects.find((select) =>
      Array.from(select.options).some((option) => option.value === 'e2e-visual-workspace')
    );

    if (!scopeSelect || !workspaceSelect) return false;

    scopeSelect.value = 'workspace';
    scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    workspaceSelect.value = 'e2e-visual-workspace';
    workspaceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });

  expect(changed).toBe(true);
}

async function waitForVisualSkillsInventoryStable(): Promise<void> {
  let latestNames: string[] = [];

  try {
    await browser.waitUntil(
      async () => browser.execute(() => {
        const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="skill-inventory-card"]'));
        const names = cards.map((card) => card.dataset.skillInventoryName ?? '');
        const workspaceIds = cards.map((card) => card.dataset.skillInventoryWorkspaceId ?? '');
        return {
          names,
          stable:
            names.length > 0 &&
            names.every((name) => !name.startsWith('e2e-') && name !== 'brainstorming') &&
            workspaceIds.every((workspaceId) => !workspaceId || workspaceId === 'e2e-visual-workspace'),
        };
      }).then((snapshot) => {
        latestNames = snapshot.names;
        return snapshot.stable;
      }),
      {
        timeout: 10000,
        interval: 250,
        timeoutMsg: 'Visual skills page still contained cross-spec skill fixtures.',
      },
    );
  } catch (error) {
    const bodyText = await browser.execute(() => document.body.innerText).catch(() => '');
    throw new Error(
      `Visual skills page did not settle to the clean fixture inventory. ` +
      `Latest names: ${JSON.stringify(latestNames)}. Body: ${bodyText.slice(0, 1000)}`,
      { cause: error },
    );
  }
}

async function positionWindowForVisualSnapshots(): Promise<void> {
  const result = await browser.executeAsync((done: (value: { ok: boolean; error?: string }) => void) => {
    void (async () => {
      const internals = (window as typeof window & {
        __TAURI_INTERNALS__?: {
          invoke?: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
          metadata?: { currentWindow?: { label?: string } };
        };
      }).__TAURI_INTERNALS__;
      const invoke = internals?.invoke;
      if (typeof invoke !== 'function') {
        throw new Error('Tauri invoke bridge is unavailable.');
      }

      await invoke('e2e_position_main_window', { width: 1180, height: 820, x: 80, y: 80 });
      done({ ok: true });
    })().catch((error) => {
      done({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  }) as { ok: boolean; error?: string };

  if (!result.ok) {
    throw new Error(`Failed to position desktop window for visual snapshots: ${result.error ?? "unknown error"}`);
  }
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

  await setActiveVisualWorkspace();
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
    cleanupVisualSkillFixtures();
    await setActiveVisualWorkspace();
    await openVisualRoute('/dashboard/skills', '#/dashboard/skills', 'Skills');
    await browser.refresh();
    await openVisualRoute('/dashboard/skills', '#/dashboard/skills', 'Skills');
    await refreshSkillsInventoryFromUi();
    await setVisualSkillsInventoryFilters();
    await waitForVisualSkillsInventoryStable();
    await waitForVisualIdle();

    const result = await browser.checkScreen('skills-page', {});
    expectVisualDiff(result);
  });

  it('should match the session view', async () => {
    await openVisualRoute('/session', '#/session', 'Ask Veslo');

    const result = await browser.checkScreen('session-view', {});
    expectVisualDiff(result);
  });
});
