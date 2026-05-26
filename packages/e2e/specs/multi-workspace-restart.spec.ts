import { expect } from '@wdio/globals';

// VSLO-86 — verify that after a fresh Vesla boot a sidebar click on any of the
// four registered local workspaces actually reaches the composer without the
// "Opening conversation…" 12-30s spinner that used to gate any workspace the
// veslo-server didn't already know about at spawn time.

const WORKSPACE_NAMES = ['veslo-test3-A', 'veslo-test3-B', 'veslo-test3-C', 'veslo-test3-D'];

async function findSidebarWorkspaceButton(name: string) {
  const candidates = await browser.execute((wsName: string) => {
    const matches: { tag: string; text: string; outerHtmlPreview: string }[] = [];
    const all = document.querySelectorAll('button, [role="button"], a, li');
    for (const el of Array.from(all)) {
      const text = (el.textContent ?? '').trim();
      if (text.includes(wsName) && text.length < 200) {
        matches.push({
          tag: el.tagName,
          text: text.slice(0, 80),
          outerHtmlPreview: el.outerHTML.slice(0, 200),
        });
      }
    }
    return matches.slice(0, 5);
  }, name);
  return candidates;
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

describe('Multi-workspace restart stability (VSLO-86)', () => {
  before(async () => {
    // Let workspaceBootstrap + reconcileVesloServerWorkspaces settle.
    await browser.pause(10000);
  });

  it('sidebar renders all four test workspaces after boot', async () => {
    for (const name of WORKSPACE_NAMES) {
      const matches = await findSidebarWorkspaceButton(name);
      console.log(`Sidebar candidates for ${name}: ${matches.length}`, matches);
      expect(matches.length).toBeGreaterThan(0);
    }
  });

  it('clicking workspace D reaches an interactive state within 20s', async () => {
    const clicked = await clickSidebarWorkspace('veslo-test3-D');
    expect(clicked).toBe(true);

    // Wait for either the composer textbox to appear (= active workspace)
    // OR an Error badge to materialise (= still failing).
    const deadline = Date.now() + 20000;
    let composerReady = false;
    while (Date.now() < deadline) {
      const result = await browser.execute(() => {
        const textbox = document.querySelector('[role="textbox"]') as HTMLElement | null;
        const errorBadge = document.body.innerText.includes('Error');
        return {
          composerExists: Boolean(textbox),
          composerVisible: Boolean(textbox && textbox.offsetParent !== null),
          errorBadge,
          bodyText: document.body.innerText.slice(0, 500),
        };
      });
      if (result.composerVisible) {
        composerReady = true;
        break;
      }
      await browser.pause(500);
    }
    expect(composerReady).toBe(true);
  });

  it('clicking workspace A reaches an interactive state within 20s', async () => {
    const clicked = await clickSidebarWorkspace('veslo-test3-A');
    expect(clicked).toBe(true);

    const deadline = Date.now() + 20000;
    let composerReady = false;
    while (Date.now() < deadline) {
      const visible = await browser.execute(() => {
        const textbox = document.querySelector('[role="textbox"]') as HTMLElement | null;
        return Boolean(textbox && textbox.offsetParent !== null);
      });
      if (visible) {
        composerReady = true;
        break;
      }
      await browser.pause(500);
    }
    expect(composerReady).toBe(true);
  });

  it('clicking workspace B reaches an interactive state within 20s', async () => {
    const clicked = await clickSidebarWorkspace('veslo-test3-B');
    expect(clicked).toBe(true);

    const deadline = Date.now() + 20000;
    let composerReady = false;
    while (Date.now() < deadline) {
      const visible = await browser.execute(() => {
        const textbox = document.querySelector('[role="textbox"]') as HTMLElement | null;
        return Boolean(textbox && textbox.offsetParent !== null);
      });
      if (visible) {
        composerReady = true;
        break;
      }
      await browser.pause(500);
    }
    expect(composerReady).toBe(true);
  });

  it('clicking workspace C reaches an interactive state within 20s', async () => {
    const clicked = await clickSidebarWorkspace('veslo-test3-C');
    expect(clicked).toBe(true);

    const deadline = Date.now() + 20000;
    let composerReady = false;
    while (Date.now() < deadline) {
      const visible = await browser.execute(() => {
        const textbox = document.querySelector('[role="textbox"]') as HTMLElement | null;
        return Boolean(textbox && textbox.offsetParent !== null);
      });
      if (visible) {
        composerReady = true;
        break;
      }
      await browser.pause(500);
    }
    expect(composerReady).toBe(true);
  });

  it('typing in workspace C composer + send produces AI response (PONG_UI_C)', async () => {
    // Make sure we're still on C
    await clickSidebarWorkspace('veslo-test3-C');
    await browser.pause(2000);

    // Type into composer
    const typed = await browser.execute(() => {
      const editor = document.querySelector('[role="textbox"]') as HTMLElement | null;
      if (!editor) return false;
      const text = 'Odpověz JEN slovem: PONG_UI_C';
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      editor.focus();
      return true;
    });
    expect(typed).toBe(true);
    await browser.pause(500);

    // Click send button — typically an arrow-up icon button next to the textbox
    const sent = await browser.execute(() => {
      const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
      // Prefer buttons with aria-label "Send" or that contain just an svg/arrow
      const sendBtn = buttons.find((b) => {
        const label = (b.getAttribute('aria-label') ?? '').toLowerCase();
        if (label.includes('send') || label.includes('odeslat')) return true;
        return false;
      });
      if (sendBtn) {
        sendBtn.click();
        return true;
      }
      return false;
    });
    expect(sent).toBe(true);

    // Wait up to 60s for the assistant message to contain PONG_UI_C
    const deadline = Date.now() + 60000;
    let pong: string | null = null;
    while (Date.now() < deadline) {
      const found = await browser.execute(() => {
        const bodyText = document.body.innerText;
        const match = bodyText.match(/PONG_UI_C/);
        if (!match) return null;
        // Make sure it's in an assistant message context (not just the echoed prompt)
        const indices: number[] = [];
        let i = 0;
        while ((i = bodyText.indexOf('PONG_UI_C', i)) !== -1) {
          indices.push(i);
          i++;
        }
        // Need at least 2 occurrences (user echo + assistant) OR 1 if the
        // prompt itself is rendered elsewhere
        return indices.length >= 2 ? 'pong-twice' : indices.length === 1 ? 'pong-once' : null;
      });
      if (found === 'pong-twice') {
        pong = found;
        break;
      }
      await browser.pause(1000);
    }
    expect(pong).toBe('pong-twice');
  });
});
