import { expect } from '@wdio/globals';

type BrowserLanguageState = {
  language: string | null;
  langAttribute: string | null;
};

type BrowserOperationResult = {
  ok: boolean;
  error?: string;
};

const authState = {
  denApiBase: 'https://den-control-plane-veslo.onrender.com',
  token: 'token_current_browser',
  orgId: 'org_language_persistence',
  user: { id: 'user_language_persistence', email: 'language-persistence@example.com' },
  org: { id: 'org_language_persistence', slug: 'language-persistence-org' },
};

async function writeLanguageState(language: string): Promise<void> {
  const result = await browser.executeAsync((nextLanguage: string, authJson: string, done) => {
    void (async () => {
      try {
        window.localStorage.setItem('veslo.language', nextLanguage);
        window.localStorage.setItem('veslo.onboardingComplete', '1');
        window.localStorage.setItem('veslo.den.keepSignedIn', '1');
        window.localStorage.setItem('veslo.den.auth', authJson);

        const invoke = (
          window as unknown as {
            __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__?.invoke;
        if (!invoke) {
          done({ ok: false, error: 'Tauri invoke bridge is unavailable.' });
          return;
        }

        await invoke('den_auth_snapshot_write', {
          authJson,
          keepSignedIn: true,
          language: nextLanguage,
          onboardingComplete: true,
        });
        done({ ok: true });
      } catch (error) {
        done({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }, language, JSON.stringify(authState)) as BrowserOperationResult;

  if (!result.ok) {
    throw new Error(result.error ?? 'Failed to write browser language state.');
  }
}

async function writeStaleEnglishDesktopSnapshot(): Promise<void> {
  const result = await browser.executeAsync((authJson: string, done) => {
    void (async () => {
      try {
        const invoke = (
          window as unknown as {
            __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__?.invoke;
        if (!invoke) {
          done({ ok: false, error: 'Tauri invoke bridge is unavailable.' });
          return;
        }

        await invoke('den_auth_snapshot_write', {
          authJson,
          keepSignedIn: true,
          language: 'en',
          onboardingComplete: true,
        });
        done({ ok: true });
      } catch (error) {
        done({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }, JSON.stringify(authState)) as BrowserOperationResult;

  if (!result.ok) {
    throw new Error(result.error ?? 'Failed to write stale desktop auth snapshot.');
  }
}

async function readBrowserLanguageState(): Promise<BrowserLanguageState> {
  return browser.execute(() => ({
    language: window.localStorage.getItem('veslo.language'),
    langAttribute: document.documentElement.getAttribute('lang'),
  }));
}

describe('Language persistence', () => {
  afterEach(async () => {
    await writeLanguageState('en');
    await browser.refresh();
  });

  it('keeps the browser language preference when the desktop auth snapshot is stale', async () => {
    const root = await $('#root');
    await root.waitForExist({ timeout: 15000 });

    await writeLanguageState('cs');
    await writeStaleEnglishDesktopSnapshot();

    await browser.refresh();
    const refreshedRoot = await $('#root');
    await refreshedRoot.waitForExist({ timeout: 15000 });
    await browser.waitUntil(
      async () => {
        const state = await readBrowserLanguageState();
        return state.language === 'cs' && state.langAttribute === 'cs';
      },
      {
        timeout: 10000,
        timeoutMsg: 'Czech language preference was not preserved after webview reload.',
      },
    );

    const state = await readBrowserLanguageState();
    expect(state.language).toBe('cs');
    expect(state.langAttribute).toBe('cs');
  });
});
