import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

async function bootstrapEnglishApp(): Promise<void> {
  const body = await $('body');
  await body.waitForDisplayed({ timeout: 15000 });
  await browser.execute(() => {
    window.localStorage.setItem('veslo.onboardingComplete', '1');
    window.localStorage.setItem('veslo.language', 'en');
  });
  await browser.refresh();
  const refreshedBody = await $('body');
  await refreshedBody.waitForDisplayed({ timeout: 15000 });
}

async function resetWindowForTitlebarDoubleClick(): Promise<void> {
  const result = await browser.executeAsync((done: (value: { ok: boolean; error?: string }) => void) => {
    void (async () => {
      try {
        const invoke = (
          window as typeof window & {
            __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') {
          throw new Error('Tauri invoke bridge is unavailable');
        }

        const maximized = await invoke('plugin:window|is_maximized', { label: 'main' });
        if (maximized === true) {
          await invoke('plugin:window|toggle_maximize', { label: 'main' });
        }
        done({ ok: true });
      } catch (error) {
        done({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }) as { ok: boolean; error?: string };

  if (!result.ok) {
    throw new Error(`Failed to reset titlebar test window: ${result.error ?? 'unknown error'}`);
  }
}

async function currentWindowIsMaximized(): Promise<boolean> {
  const result = await browser.executeAsync(
    (done: (value: { ok: boolean; maximized?: boolean; error?: string }) => void) => {
      void (async () => {
        try {
          const invoke = (
            window as typeof window & {
              __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
            }
          ).__TAURI_INTERNALS__?.invoke;
          if (typeof invoke !== 'function') {
            throw new Error('Tauri invoke bridge is unavailable');
          }

          done({
            ok: true,
            maximized: (await invoke('plugin:window|is_maximized', { label: 'main' })) === true,
          });
        } catch (error) {
          done({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    },
  ) as { ok: boolean; maximized?: boolean; error?: string };

  if (!result.ok) {
    throw new Error(`Failed to read titlebar test window state: ${result.error ?? 'unknown error'}`);
  }

  return result.maximized === true;
}

describe('Shared titlebar window controls', () => {
  it('renders Windows window controls in the app-owned titlebar rail', async function () {
    if (process.platform !== 'win32') {
      this.skip();
      return;
    }

    await bootstrapEnglishApp();
    await navigateToHash('/dashboard/settings');
    await waitForHashRoute('#/dashboard/settings', 10000);
    await browser.waitUntil(
      async () => browser.execute(() => Boolean(document.querySelector('button[aria-label="Minimize window"]'))),
      {
        timeout: 15000,
        timeoutMsg: 'Windows titlebar controls did not render in the shared titlebar rail',
      },
    );

    const metrics = await browser.execute(() => {
      const minimize = document.querySelector('button[aria-label="Minimize window"]');
      const maximize = document.querySelector('button[aria-label="Maximize or restore window"]');
      const close = document.querySelector('button[aria-label="Close window"]');
      const dragRegion = document.querySelector('[data-tauri-drag-region]');
      const closeRect = close?.getBoundingClientRect();

      return {
        hasMinimize: Boolean(minimize),
        hasMaximize: Boolean(maximize),
        hasClose: Boolean(close),
        hasDragRegion: Boolean(dragRegion),
        closeTop: closeRect?.top ?? null,
        closeRightGap: closeRect ? window.innerWidth - closeRect.right : null,
      };
    });

    expect(metrics.hasMinimize).toBe(true);
    expect(metrics.hasMaximize).toBe(true);
    expect(metrics.hasClose).toBe(true);
    expect(metrics.hasDragRegion).toBe(true);
    expect(metrics.closeTop).not.toBeNull();
    expect(metrics.closeTop!).toBeLessThan(1);
    expect(metrics.closeRightGap).not.toBeNull();
    expect(Math.abs(metrics.closeRightGap!)).toBeLessThan(1);
  });

  it('maximizes the desktop window when nested session titlebar text is double-clicked', async function () {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      this.skip();
      return;
    }

    await bootstrapEnglishApp();
    await resetWindowForTitlebarDoubleClick();
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 10000);

    await browser.waitUntil(
      async () => browser.execute(() => Boolean(document.querySelector('[data-tauri-drag-region] span[title]'))),
      {
        timeout: 15000,
        timeoutMsg: 'Session titlebar nested text did not render',
      },
    );

    await browser.execute(() => {
      const target = document.querySelector('[data-tauri-drag-region] span[title]');
      if (!(target instanceof HTMLElement)) {
        throw new Error('Session titlebar nested text target is unavailable');
      }
      const rect = target.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      const dispatch = (type: string, detail: number, buttons = 0) => {
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons,
            clientX,
            clientY,
            detail,
          }),
        );
      };

      dispatch('mousedown', 1, 1);
      dispatch('mouseup', 1);
      dispatch('click', 1);
      dispatch('mousedown', 2, 1);
      dispatch('mouseup', 2);
      dispatch('click', 2);
      dispatch('dblclick', 2);
    });

    await browser.waitUntil(currentWindowIsMaximized, {
      timeout: 5000,
      timeoutMsg: 'Desktop window did not maximize after double-clicking nested titlebar text',
    });

    expect(await currentWindowIsMaximized()).toBe(true);
  });
});
