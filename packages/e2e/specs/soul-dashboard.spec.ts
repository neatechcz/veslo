import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';
import {
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  E2E_SKILL_REGISTRY_USER_ID,
  readSkillRegistryFixtureBaseUrl,
} from '../helpers/skill-registry-fixture.js';

type BrowserOperationResult = {
  ok: boolean;
  error?: string;
};

async function seedSoulDenAuth() {
  const authJson = JSON.stringify({
    denApiBase: readSkillRegistryFixtureBaseUrl(),
    token: E2E_SKILL_REGISTRY_TOKEN,
    orgId: E2E_SKILL_REGISTRY_ORG_ID,
    user: {
      id: E2E_SKILL_REGISTRY_USER_ID,
      email: 'veslo-soul-e2e@example.test',
      name: 'Soul E2E',
    },
    org: {
      id: E2E_SKILL_REGISTRY_ORG_ID,
      name: 'Veslo E2E',
      slug: 'veslo-e2e',
      role: 'organization_admin',
    },
  });

  const result = await browser.executeAsync((nextAuthJson: string, done) => {
    void (async () => {
      try {
        window.localStorage.setItem('veslo.den.auth', nextAuthJson);
        window.localStorage.setItem('veslo.den.keepSignedIn', '1');
        window.sessionStorage.removeItem('veslo.den.auth');
        window.sessionStorage.removeItem('veslo.den.keepSignedIn');

        const invoke = (
          window as unknown as {
            __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__?.invoke;
        if (invoke) {
          await invoke('den_auth_snapshot_write', {
            authJson: nextAuthJson,
            keepSignedIn: true,
            language: 'en',
            onboardingComplete: true,
          });
        }
        done({ ok: true });
      } catch (error) {
        done({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  }, authJson) as BrowserOperationResult;

  if (!result.ok) {
    throw new Error(result.error ?? 'Failed to seed Soul Den auth.');
  }

  await browser.refresh();
  await $('#root').waitForExist({ timeout: 15000 });
}

async function clickTestId(testId: string) {
  await browser.execute((id: string) => {
    const element = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    element?.click();
  }, testId);
}

async function closeSoulModalIfOpen() {
  await browser.execute(() => {
    const close = document.querySelector('[data-testid="soul-source-modal-close"]') as HTMLElement | null;
    close?.click();
  });
}

async function waitForSoulPageIdle() {
  await browser.waitUntil(async () => {
    const text = await browser.execute(() => document.body.textContent ?? '');
    return ![
      'Refreshing Soul sources',
      'Obnovuji Soul zdroje',
      'Loading Soul details',
      'Načítám detaily Soul',
      'Loading version history',
      'Načítám historii verzí',
    ].some((message) => text.includes(message));
  }, {
    timeout: 15000,
    timeoutMsg: 'Soul page did not finish loading.',
  });
}

async function readSoulEditState() {
  return browser.execute(() => {
    const content = document.querySelector('[data-testid="soul-editor-content"]') as HTMLTextAreaElement | null;
    const summary = document.querySelector('[data-testid="soul-change-summary"]') as HTMLInputElement | null;
    const save = document.querySelector('[data-testid="soul-save-button"]') as HTMLButtonElement | null;
    return {
      content: content?.value ?? '',
      readOnly: content?.readOnly ?? true,
      summary: summary?.value ?? '',
      summaryDisabled: summary?.disabled ?? true,
      saveDisabled: save?.disabled ?? true,
      saveText: save?.textContent ?? '',
    };
  });
}

async function waitForStableSoulEditor() {
  let stableReads = 0;
  let lastSignature = '';
  await browser.waitUntil(async () => {
    const state = await readSoulEditState();
    const ready = !state.readOnly && !state.summaryDisabled && state.content.trim().length > 0;
    const signature = JSON.stringify(state);
    if (ready && signature === lastSignature) {
      stableReads += 1;
    } else {
      stableReads = ready ? 1 : 0;
      lastSignature = signature;
    }
    return stableReads >= 3;
  }, {
    timeout: 15000,
    interval: 250,
    timeoutMsg: 'Soul editor did not become stable for editing.',
  });
}

async function setFormValueByTestId(testId: string, value: string) {
  const element = await $(`[data-testid="${testId}"]`);
  await element.waitForDisplayed({ timeout: 10000 });
  await element.click();
  await element.setValue(value);
}

describe('Soul dashboard', () => {
  it('opens source editing in a modal and keeps legacy setup copy hidden', async () => {
    await navigateToHash('/dashboard/soul');
    await waitForHashRoute('#/dashboard/soul', 10000);
    await closeSoulModalIfOpen();

    await expect($('[data-testid="soul-organization-source"]')).toExist();
    await expect($('[data-testid="soul-user-source"]')).toExist();
    await expect($('[data-testid="soul-source-detail"]')).not.toExist();

    const bodyText = await browser.execute(() => document.body.innerText);
    expect(bodyText).toContain('Soul sources');
    expect(bodyText).toContain('Workspace sources');
    expect(bodyText).not.toContain('Editor controls will arrive');
    expect(bodyText).not.toContain('Runtime status');
    expect(bodyText).not.toContain('manual sync');

    await clickTestId('soul-organization-source-open');
    await expect($('[data-testid="soul-source-modal"]')).toExist();
    await expect($('[data-testid="soul-source-detail"]')).toExist();
    await expect($('[data-testid="soul-version-history"]')).toExist();
    const modalMetrics = await browser.execute(() => {
      const modal = document.querySelector('[data-testid="soul-source-modal"]') as HTMLElement | null;
      const overlay = modal?.parentElement as HTMLElement | null;
      const modalRect = modal?.getBoundingClientRect();
      const modalStyle = modal ? getComputedStyle(modal) : null;
      const overlayStyle = overlay ? getComputedStyle(overlay) : null;
      const modalCenterX = modalRect ? modalRect.left + modalRect.width / 2 : 0;
      const modalCenterY = modalRect ? modalRect.top + modalRect.height / 2 : 0;

      return {
        centeredX: Math.abs(modalCenterX - window.innerWidth / 2) <= 2,
        centeredY: Math.abs(modalCenterY - window.innerHeight / 2) <= 2,
        modalBackground: modalStyle?.backgroundColor ?? '',
        overlayAlignItems: overlayStyle?.alignItems ?? '',
        overlayJustifyContent: overlayStyle?.justifyContent ?? '',
        overlayPosition: overlayStyle?.position ?? '',
      };
    });

    expect(modalMetrics.modalBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(modalMetrics.overlayPosition).toBe('fixed');
    expect(modalMetrics.overlayAlignItems).toBe('center');
    expect(modalMetrics.overlayJustifyContent).toBe('center');
    expect(modalMetrics.centeredX).toBe(true);
    expect(modalMetrics.centeredY).toBe(true);

    await clickTestId('soul-source-modal-close');
    await expect($('[data-testid="soul-source-modal"]')).not.toExist();

    await clickTestId('soul-user-source-open');
    await expect($('[data-testid="soul-source-modal"]')).toExist();
    await browser.keys('Escape');
    await expect($('[data-testid="soul-source-modal"]')).not.toExist();
  });

  it('edits organization Soul through the modal without surfacing a Den server error', async () => {
    await seedSoulDenAuth();
    await navigateToHash('/dashboard/soul');
    await waitForHashRoute('#/dashboard/soul', 10000);
    await waitForSoulPageIdle();
    await closeSoulModalIfOpen();

    await clickTestId('soul-organization-source-open');
    await expect($('[data-testid="soul-source-modal"]')).toExist();
    await waitForSoulPageIdle();

    const editor = await $('[data-testid="soul-editor-content"]');
    await editor.waitForDisplayed({ timeout: 10000 });
    await waitForStableSoulEditor();

    const nextContent = '# Organization Soul\n\n- E2E organization memory update';
    await setFormValueByTestId('soul-editor-content', nextContent);
    await setFormValueByTestId('soul-change-summary', 'E2E organization Soul update');
    let lastEditState = await readSoulEditState();
    await browser.waitUntil(async () => {
      const state = await readSoulEditState();
      lastEditState = state;
      return state.content === nextContent && state.summary === 'E2E organization Soul update';
    }, {
      timeout: 5000,
      timeoutMsg: 'Organization Soul editor did not reflect the edited values.',
    }).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Last state: ${JSON.stringify(lastEditState)}`);
    });
    await browser.waitUntil(async () => !(await readSoulEditState()).saveDisabled, {
      timeout: 10000,
      timeoutMsg: 'Organization Soul save button did not become enabled.',
    });
    await clickTestId('soul-save-button');

    await browser.waitUntil(async () => !(await readSoulEditState()).saveText.includes('Saving'), {
      timeout: 10000,
      timeoutMsg: 'Organization Soul save did not settle.',
    });

    await browser.waitUntil(async () => (await $('[data-testid="soul-source-modal"]').getText()).includes('E2E organization Soul update'), {
      timeout: 10000,
      timeoutMsg: 'Saved Organization Soul version did not appear in history.',
    });

    const modalText = await $('[data-testid="soul-source-modal"]').getText();
    expect(modalText).not.toContain('Soul Den');
    expect(modalText).not.toContain('Failed to fetch');
    expect(modalText).toContain('E2E organization Soul update');
    expect((await readSoulEditState()).content).toBe(nextContent);
  });
});
