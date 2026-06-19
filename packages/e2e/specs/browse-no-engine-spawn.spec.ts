import { expect } from '@wdio/globals';
import { execSync } from 'node:child_process';

// VSLO-86 — verify Pavel's expectation: passively browsing sessions across
// multiple workspaces should NOT spawn any sandbox-exec engines. The engine
// pool should stay empty until the user explicitly sends a message.

function countEngines(): number {
  try {
    const out = execSync('ps axo command= | grep "veslo-code serve" | grep -v grep | wc -l', { encoding: 'utf8' });
    return Number(out.trim()) || 0;
  } catch {
    return -1;
  }
}

async function clickSidebarText(text: string): Promise<boolean> {
  return browser.execute((needle: string) => {
    const all = document.querySelectorAll('button, [role="button"], a');
    for (const el of Array.from(all)) {
      const t = (el.textContent ?? '').trim();
      if (t.includes(needle) && t.length < 200) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, text);
}

async function snapshotBrowseShellState() {
  return browser.execute(() => {
    const bodyText = document.body.innerText;
    const textbox = document.querySelector('[role="textbox"]') as HTMLElement | null;
    const composerVisible = Boolean(textbox && textbox.offsetParent !== null);
    const blockingOverlayActive =
      bodyText.includes('Opening conversation') ||
      bodyText.includes('Switching workspace') ||
      bodyText.includes('OtevĂ­rĂˇm') ||
      bodyText.includes('NaÄŤĂ­tĂˇm dĹ™Ă­vÄ›jĹˇĂ­ zprĂˇvy');
    const clickableWorkspaceCount = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .filter((el) => {
        const text = (el.textContent ?? '').trim();
        return text.includes('veslo-test3') && text.length < 200;
      })
      .length;
    return { composerVisible, blockingOverlayActive, clickableWorkspaceCount };
  });
}

async function clickFirstSessionInActiveWorkspace(): Promise<string | null> {
  return browser.execute(() => {
    // Sessions appear as buttons inside the sidebar with short titles like
    // "Požadavek na odpověď ..." / "New session ..." / "AHOJ_PONG ...". We
    // pick the first one that isn't a workspace folder header.
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const el of buttons) {
      const t = (el.textContent ?? '').trim();
      if (!t) continue;
      if (t.includes('veslo-test3')) continue;
      if (t.length > 5 && t.length < 80 && !t.includes('Add directory') && !t.includes('Nová')) {
        (el as HTMLElement).click();
        return t.slice(0, 60);
      }
    }
    return null;
  });
}

describe('Browse mode never spawns an engine (VSLO-86)', () => {
  before(async () => {
    await browser.waitUntil(
      async () => browser.execute(() => {
        return Array.from(document.querySelectorAll('button')).some((b) =>
          (b.textContent ?? '').includes('veslo-test3'),
        );
      }),
      { timeout: 30_000, timeoutMsg: 'Sidebar workspaces did not render within 30s' },
    );
    await browser.pause(2000);
  });

  it('starts with zero engine processes (boot is idle)', async () => {
    const count = countEngines();
    console.log(`[browse] engines at start: ${count}`);
    expect(count).toBe(0);
  });

  it('clicking workspaces D, A, B in sequence spawns no engines', async () => {
    for (const ws of ['veslo-test3-D', 'veslo-test3-A', 'veslo-test3-B']) {
      const clicked = await clickSidebarText(ws);
      expect(clicked).toBe(true);
      await browser.pause(2000);
      const count = countEngines();
      const shell = await snapshotBrowseShellState();
      console.log(`[browse] after click ${ws}: engines=${count}`);
      console.log(`[browse] after click ${ws}: shell=${JSON.stringify(shell)}`);
      expect(count).toBe(0);
      expect(shell.blockingOverlayActive).toBe(false);
      expect(shell.clickableWorkspaceCount).toBeGreaterThan(0);
    }
  });

  it('clicking a session inside the active workspace spawns no engine', async () => {
    const title = await clickFirstSessionInActiveWorkspace();
    console.log(`[browse] clicked session: ${title}`);
    expect(title).not.toBeNull();
    await browser.pause(4000);
    const count = countEngines();
    console.log(`[browse] after session click: engines=${count}`);
    expect(count).toBe(0);
  });
});
