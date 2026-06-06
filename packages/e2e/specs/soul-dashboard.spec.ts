import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

describe('Soul dashboard', () => {
  it('renders the source editor shell without legacy setup copy', async () => {
    await navigateToHash('/dashboard/soul');
    await waitForHashRoute('#/dashboard/soul', 10000);

    await expect($('[data-testid="soul-source-detail"]')).toExist();
    await expect($('[data-testid="soul-organization-source"]')).toExist();
    await expect($('[data-testid="soul-user-source"]')).toExist();

    const bodyText = await browser.execute(() => document.body.innerText);
    expect(bodyText).toContain('Soul sources');
    expect(bodyText).toContain('Workspace sources');
    expect(bodyText).not.toContain('Editor controls will arrive');
    expect(bodyText).not.toContain('Runtime status');
    expect(bodyText).not.toContain('manual sync');
  });
});
