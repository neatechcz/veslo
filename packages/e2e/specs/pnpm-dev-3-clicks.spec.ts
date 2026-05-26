import { expect } from '@wdio/globals';

// VSLO-86 — reproduce Pavel's "klikám v rozhraní a při třetím kliku to freezlo"
// scenario against the actually-running pnpm dev session (= reuse the existing
// WebDriver server on :4445 instead of spawning a fresh binary).

const WORKSPACES = ['veslo-test3-D', 'veslo-test3-A', 'veslo-test3-B', 'veslo-test3-C'];

async function snapshotUiState() {
  return browser.execute(() => {
    const textbox = document.querySelector('[role="textbox"]') as HTMLElement | null;
    const composerVisible = Boolean(textbox && textbox.offsetParent !== null);
    const bodyText = document.body.innerText;
    const spinnerActive =
      bodyText.includes('Otevírám') ||
      bodyText.includes('Načítám dřívější zprávy') ||
      bodyText.includes('Opening conversation');
    const errorBadges = Array.from(document.querySelectorAll('span, button, div'))
      .filter((el) => (el.textContent ?? '').trim() === 'Error').length;
    const activeWorkspaceName = (() => {
      const title = document.querySelector('header [class*="text"], h1, [data-active-workspace]');
      return title?.textContent?.trim() ?? null;
    })();
    return { composerVisible, spinnerActive, errorBadges, activeWorkspaceName };
  });
}

async function clickSidebarWorkspace(name: string): Promise<boolean> {
  return browser.execute((wsName: string) => {
    const all = document.querySelectorAll('button, [role="button"], a');
    for (const el of Array.from(all)) {
      const text = (el.textContent ?? '').trim();
      if (text.includes(wsName) && text.length < 200) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, name);
}

describe('pnpm dev — 3 sidebar clicks (VSLO-86)', () => {
  before(async () => {
    // Wait for the sidebar to actually render the workspace buttons. Whether
    // we're attached to an already-running pnpm dev session or to a freshly
    // spawned binary, the first paint can take a couple seconds, and freshly
    // spawned Vesla also needs to mount the SolidJS shell + hydrate the
    // workspace store.
    await browser.waitUntil(
      async () => browser.execute(() => {
        return Array.from(document.querySelectorAll('button')).some((b) =>
          (b.textContent ?? '').includes('veslo-test3'),
        );
      }),
      { timeout: 30_000, timeoutMsg: 'Sidebar workspace buttons did not render within 30s' },
    );
    // Small additional settle to let the activate effect of the last-active
    // workspace finish before we start clicking other ones.
    await browser.pause(2000);
  });

  for (let i = 0; i < 3; i += 1) {
    const target = WORKSPACES[i]!;
    it(`click ${i + 1}/3: ${target} — composer/spinner state after 5s`, async () => {
      const before = await snapshotUiState();
      console.log(`[click ${i + 1}] BEFORE:`, JSON.stringify(before));

      const start = Date.now();
      const clicked = await clickSidebarWorkspace(target);
      expect(clicked).toBe(true);

      // Wait up to 30s for either composer to be ready (no spinner) or stuck spinner.
      const deadline = Date.now() + 30_000;
      let lastSnapshot = before;
      let stableAt: number | null = null;
      while (Date.now() < deadline) {
        await browser.pause(500);
        const snap = await snapshotUiState();
        lastSnapshot = snap;
        if (snap.composerVisible && !snap.spinnerActive) {
          stableAt = Date.now();
          break;
        }
      }
      const totalMs = (stableAt ?? Date.now()) - start;
      console.log(`[click ${i + 1}] AFTER ${totalMs}ms:`, JSON.stringify(lastSnapshot));

      // Don't hard-fail on spinner — we want to see HOW LONG, not just pass/fail.
      // But hard-fail if we never reach a stable state within 30s.
      expect(stableAt).not.toBeNull();
      expect(totalMs).toBeLessThan(30_000);
    });
  }
});
