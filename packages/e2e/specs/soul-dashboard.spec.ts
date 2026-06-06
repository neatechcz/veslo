import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

describe('Soul dashboard', () => {
  it('opens source editing in a modal and keeps legacy setup copy hidden', async () => {
    await navigateToHash('/dashboard/soul');
    await waitForHashRoute('#/dashboard/soul', 10000);

    await expect($('[data-testid="soul-organization-source"]')).toExist();
    await expect($('[data-testid="soul-user-source"]')).toExist();
    await expect($('[data-testid="soul-source-detail"]')).not.toExist();

    const bodyText = await browser.execute(() => document.body.innerText);
    expect(bodyText).toContain('Soul sources');
    expect(bodyText).toContain('Workspace sources');
    expect(bodyText).not.toContain('Editor controls will arrive');
    expect(bodyText).not.toContain('Runtime status');
    expect(bodyText).not.toContain('manual sync');

    await $('[data-testid="soul-organization-source-open"]').click();
    await expect($('[data-testid="soul-source-modal"]')).toExist();
    await expect($('[data-testid="soul-source-detail"]')).toExist();
    await expect($('[data-testid="soul-version-history"]')).toExist();

    await $('[data-testid="soul-source-modal-close"]').click();
    await expect($('[data-testid="soul-source-modal"]')).not.toExist();

    await $('[data-testid="soul-user-source-open"]').click();
    await expect($('[data-testid="soul-source-modal"]')).toExist();
    await browser.keys('Escape');
    await expect($('[data-testid="soul-source-modal"]')).not.toExist();
  });
});
