import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

describe('Markdown drop guard', () => {
  before(async () => {
    await navigateToHash('/session');
    await waitForHashRoute('#/session', 5000);
    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });
  });

  it('prevents default markdown file drag navigation at window scope', async () => {
    const result = await browser.execute(() => {
      const file = new File(
        ['# E2E Markdown Drop Guard\n\nThis file should never replace the Veslo UI.'],
        'markdown-drop-guard.md',
        { type: 'text/markdown' },
      );
      const transfer = new DataTransfer();
      transfer.items.add(file);

      const target = document.body;
      const dragover = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      target.dispatchEvent(dragover);

      const drop = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      target.dispatchEvent(drop);

      return {
        dragoverPrevented: dragover.defaultPrevented,
        dropPrevented: drop.defaultPrevented,
        hash: window.location.hash,
        rootChildren: document.querySelectorAll('#root > *').length,
        buttonCount: document.querySelectorAll('button').length,
      };
    });

    expect(result.dragoverPrevented).toBe(true);
    expect(result.dropPrevented).toBe(true);
    expect(result.hash).toContain('/session');
    expect(result.rootChildren).toBeGreaterThan(0);
    expect(result.buttonCount).toBeGreaterThan(0);
  });
});
