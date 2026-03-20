import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';

describe('Visual regression', () => {
  it('should match the initial app state', async () => {
    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });
    await browser.pause(2000);

    const result = await browser.checkScreen('initial-state', {});
    expect(result).toBeLessThanOrEqual(1.5);
  });

  it('should match the settings page', async () => {
    await navigateToHash('/dashboard/settings');
    await browser.pause(2000);
    const result = await browser.checkScreen('settings-page', {});
    expect(result).toBeLessThanOrEqual(1.5);
  });

  it('should match the skills page', async () => {
    await navigateToHash('/dashboard/skills');
    await browser.pause(2000);
    const result = await browser.checkScreen('skills-page', {});
    expect(result).toBeLessThanOrEqual(1.5);
  });

  it('should match the session view', async () => {
    await navigateToHash('/session');
    await browser.pause(2000);
    const result = await browser.checkScreen('session-view', {});
    expect(result).toBeLessThanOrEqual(1.5);
  });
});
