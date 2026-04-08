import { expect } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { navigateToHash } from '../helpers/app-launcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ATTACHMENT_FIXTURE = resolve(__dirname, '..', 'fixtures', 'attachment-staging-test.png');
const ATTACHMENT_FIXTURE_B64 = readFileSync(ATTACHMENT_FIXTURE).toString('base64');

describe('Attachment staging', () => {
  before(async () => {
    await navigateToHash('/session');
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes('#/session'),
      { timeout: 5000 }
    );
  });

  it('shows the session composer', async () => {
    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });
    expect(await root.isDisplayed()).toBe(true);

    const textbox = await $('[role="textbox"]');
    expect(await textbox.isExisting()).toBe(true);
  });

  it('attaches a screenshot fixture and attempts send without inbox path fallback', async () => {
    const textbox = await $('[role="textbox"]');
    expect(await textbox.isExisting()).toBe(true);

    const fileInput = await $('(//div[.//*[@role="textbox"]]//input[@type="file" and @multiple])[1]');
    expect(await fileInput.isExisting()).toBe(true);
    if (!(await fileInput.isEnabled())) {
      expect(await fileInput.getAttribute('disabled')).not.toBe(null);
      return;
    }

    await browser.execute(
      (input, base64Payload, filename) => {
        const binary = atob(base64Payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }

        const file = new File([bytes], filename, { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        Object.defineProperty(input, 'files', {
          value: transfer.files,
          configurable: true,
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      fileInput,
      ATTACHMENT_FIXTURE_B64,
      'attachment-staging-test.png',
    );

    const attachmentChip = await browser.$('//*[contains(text(),"attachment-staging-test.png")]');
    await attachmentChip.waitForExist({ timeout: 10000 });
    expect(await attachmentChip.isExisting()).toBe(true);

    const marker = `attachment-staging-e2e-${Date.now()}`;
    await textbox.click();
    await textbox.setValue(marker);
    await browser.keys('Enter');
    await browser.pause(1200);

    const textboxAfterSend = await $('[role="textbox"]');
    expect(await textboxAfterSend.isExisting()).toBe(true);

    const source = await browser.getPageSource();
    expect(source.includes('.opencode/veslo/inbox/')).toBe(false);
  });
});
