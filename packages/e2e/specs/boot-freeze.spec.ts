import { expect } from '@wdio/globals';

// VSLO-86 — measure how long Vesla takes to become interactive after boot
// WITHOUT any user click. Reproduces Pavel's "kolečko se točí minutu" report:
// the frontend auto-activates the last-active workspace, ensure-engine fires,
// and the user stares at a spinner until either (a) the orchestrator returns
// the engine snapshot or (b) the 30s+ outer timeout falls through to startHost
// for another cold spawn.

describe('Boot-time time-to-interactive (VSLO-86)', () => {
  it('reaches an interactive composer within 30s of boot — no clicks', async () => {
    const start = Date.now();
    const deadline = start + 30_000;
    let composerReadyAt: number | null = null;
    let spinnerLifetimeMs = 0;
    let firstSpinnerSeenAt: number | null = null;
    let lastSpinnerSeenAt: number | null = null;

    while (Date.now() < deadline) {
      const snapshot = await browser.execute(() => {
        const textbox = document.querySelector('[role="textbox"]') as HTMLElement | null;
        const visible = Boolean(textbox && textbox.offsetParent !== null);
        // Spinner detection: presence of "Otevírám konverzaci" / "Načítám"
        const bodyText = document.body.innerText;
        const spinnerActive =
          bodyText.includes('Otevírám') ||
          bodyText.includes('Načítám dřívější zprávy') ||
          bodyText.includes('Opening conversation');
        return { composerVisible: visible, spinnerActive, bodyExcerpt: bodyText.slice(0, 200) };
      });

      if (snapshot.spinnerActive) {
        if (firstSpinnerSeenAt === null) firstSpinnerSeenAt = Date.now();
        lastSpinnerSeenAt = Date.now();
      }

      if (snapshot.composerVisible && !snapshot.spinnerActive) {
        composerReadyAt = Date.now();
        break;
      }

      await browser.pause(250);
    }

    if (lastSpinnerSeenAt !== null && firstSpinnerSeenAt !== null) {
      spinnerLifetimeMs = lastSpinnerSeenAt - firstSpinnerSeenAt;
    }

    const totalMs = composerReadyAt ? composerReadyAt - start : Date.now() - start;
    console.log(`[boot-freeze] time-to-interactive: ${totalMs}ms, spinner visible for: ${spinnerLifetimeMs}ms`);

    expect(composerReadyAt).not.toBeNull();
    expect(totalMs).toBeLessThan(30_000);
  });

  it('captures console errors and timeouts during the first 25s', async () => {
    // Wait an additional 5s so the activate flow has a chance to either
    // complete or surface its timeout in the runtime log.
    await browser.pause(5_000);

    const logs = await browser.execute(() => {
      // Webview console buffer isn't exposed via WebDriver in WebKit, so we
      // sample the runtime log surface that the app does expose: the sidebar
      // error badges. If any workspace has an Error badge, capture which.
      const badges = Array.from(document.querySelectorAll('span, button, div'))
        .filter((el) => (el.textContent ?? '').trim() === 'Error')
        .map((el) => {
          const parent = el.closest('li, button, [role="button"], [data-workspace-name]');
          return parent?.textContent?.trim().slice(0, 100) ?? '(unknown)';
        });
      return { errorBadgeContexts: badges };
    });

    console.log(`[boot-freeze] sidebar error badges: ${JSON.stringify(logs.errorBadgeContexts)}`);
    // Pavel's regression: any workspace having an Error badge after 30s is the symptom.
    expect(logs.errorBadgeContexts.length).toBe(0);
  });
});
