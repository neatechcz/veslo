/**
 * VSLO-171 multi-mode flow repro/regression spec.
 *
 * Runs against the user's real profile (E2E_USE_EXISTING_PROFILE=1) by default
 * so it can reproduce token/workspace-switch issues that depend on existing
 * workspaces. To run:
 *
 *   E2E_USE_EXISTING_PROFILE=1 pnpm --filter @neatech/veslo-e2e test \
 *     --spec ./specs/vslo-171-multi-mode.spec.ts
 *
 * Goal of the spec: click through a couple of local workspaces in the sidebar,
 * send a short prompt in each, watch for "Invalid bearer token" /
 * "engine spawn failed" / Promise rejections in the console.
 */

import { expect } from '@wdio/globals';

const WORKSPACES_TO_TRY = (process.env.E2E_WORKSPACES?.split(',').map((s) => s.trim()).filter(Boolean)) ?? [
  'velos-test-F',
  'veslo-test-H',
  'bbb',
  'aaa',
];
const PROMPT_TEXT = 'ping';
const RESPONSE_TIMEOUT_MS = 60_000;

async function waitForAppShell(timeout = 20_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const root = await $('#root');
      if (!(await root.isExisting())) return false;
      const text = await root.getText();
      return text.trim().length > 0;
    },
    { timeout, timeoutMsg: `App shell did not render within ${timeout}ms` },
  );
}

async function readBrowserLogs(): Promise<string[]> {
  return browser.execute(() => {
    const w = window as typeof window & { __vesloE2ELogs?: string[] };
    return w.__vesloE2ELogs ?? [];
  });
}

async function logsLength(): Promise<number> {
  return browser.execute(() => {
    const w = window as typeof window & { __vesloE2ELogs?: string[] };
    return (w.__vesloE2ELogs ?? []).length;
  });
}

async function readLogsSince(start: number): Promise<string[]> {
  return browser.execute((from: number) => {
    const w = window as typeof window & { __vesloE2ELogs?: string[] };
    return (w.__vesloE2ELogs ?? []).slice(from);
  }, start);
}

async function instrumentConsole(): Promise<void> {
  await browser.execute(() => {
    const w = window as typeof window & {
      __vesloE2ELogs?: string[];
      __vesloE2EOriginal?: { log: typeof console.log; error: typeof console.error; warn: typeof console.warn };
    };
    if (w.__vesloE2ELogs) return;
    w.__vesloE2ELogs = [];
    const sink = w.__vesloE2ELogs;
    const stringify = (args: unknown[]) =>
      args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');
    w.__vesloE2EOriginal = {
      log: console.log.bind(console),
      error: console.error.bind(console),
      warn: console.warn.bind(console),
    };
    console.log = (...args: unknown[]) => {
      sink.push(`[log] ${stringify(args)}`);
      w.__vesloE2EOriginal!.log(...args);
    };
    console.error = (...args: unknown[]) => {
      sink.push(`[error] ${stringify(args)}`);
      w.__vesloE2EOriginal!.error(...args);
    };
    console.warn = (...args: unknown[]) => {
      sink.push(`[warn] ${stringify(args)}`);
      w.__vesloE2EOriginal!.warn(...args);
    };
    window.addEventListener('unhandledrejection', (event) => {
      sink.push(`[unhandledrejection] ${stringify([event.reason])}`);
    });
  });
}

async function isWorkspaceAlreadyActive(name: string): Promise<boolean> {
  return browser.execute((targetName: string) => {
    // The sidebar's active workspace button shows "Active" instead of "Switch".
    // It's still a <button> with the workspace label inside; we detect by
    // finding the label span and checking sibling text.
    const aside = document.querySelector('aside, [role="complementary"]');
    if (!aside) return false;
    const spans = aside.querySelectorAll('span');
    for (const span of Array.from(spans)) {
      if ((span.textContent ?? '').trim() !== targetName) continue;
      const button = (span as HTMLElement).closest('button');
      if (!button) continue;
      return /\bActive\b/.test(button.textContent ?? '');
    }
    return false;
  }, name);
}

async function clickWorkspaceInSidebar(name: string): Promise<boolean> {
  // Wait for the sidebar to render the workspace label (Solid hydration can be
  // delayed after onMount / workspaceBootstrap).
  let found = false;
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    found = await browser.execute((targetName: string) => {
      const aside = document.querySelector('aside, [role="complementary"]');
      if (!aside) return false;
      const spans = aside.querySelectorAll('span');
      for (const span of Array.from(spans)) {
        if ((span.textContent ?? '').trim() === targetName) return true;
      }
      return false;
    }, name);
    if (found) break;
    await browser.pause(200);
  }
  if (!found) return false;

  // Workspace name is a <span> inside a <button> (sidebar.tsx onSelectWorkspace).
  // Click the closest enclosing <button> so the activation handler fires.
  await browser.execute((targetName: string) => {
    const aside = document.querySelector('aside, [role="complementary"]');
    if (!aside) return;
    const spans = aside.querySelectorAll('span');
    for (const span of Array.from(spans)) {
      if ((span.textContent ?? '').trim() !== targetName) continue;
      const button = (span as HTMLElement).closest('button');
      if (button) {
        button.click();
        return;
      }
      // Fallback: click immediate parent (collapsed/private workspace cases).
      const parent = (span.parentElement ?? span) as HTMLElement;
      parent.click();
      return;
    }
  }, name);
  return true;
}

async function sendPrompt(text: string): Promise<boolean> {
  const composer = await $('[role="textbox"]');
  if (!(await composer.isExisting())) return false;
  await composer.click();
  await browser.execute((value: string) => {
    const el = document.querySelector('[role="textbox"]') as HTMLElement | null;
    if (!el) return;
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  }, text);
  await browser.pause(150);
  // Send: try Cmd+Enter (mac) and Enter as fallback.
  await browser.keys(['Meta', 'Enter']);
  await browser.pause(150);
  return true;
}

async function waitForResponseOrFailure(
  baseline: number,
  timeoutMs: number,
): Promise<{ ok: boolean; logs: string[]; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  const failureSignals = [
    'Invalid bearer token',
    'engine spawn failed',
    'unauthorized',
    'Authentication failed',
    'restartWorkspaceRuntime failed',
    'unhandledrejection',
    'Unable to connect',
  ];
  while (Date.now() < deadline) {
    const logs = await readLogsSince(baseline);
    const failure = logs.find((line) => failureSignals.some((s) => line.includes(s)));
    if (failure) return { ok: false, logs, reason: failure };

    const success = logs.find((line) =>
      line.includes('engine started successfully') ||
      line.includes('[workspace] connect SKIP') ||
      line.includes('connect:idempotent-skip') ||
      line.includes('connect:ensured'),
    );
    if (success) return { ok: true, logs, reason: success };

    await browser.pause(500);
  }
  const logs = await readLogsSince(baseline);
  return { ok: false, logs, reason: 'timeout — no success or failure signal' };
}

describe('VSLO-171 multi-mode flow', () => {
  before(async () => {
    await waitForAppShell();
    await instrumentConsole();
  });

  for (const workspace of WORKSPACES_TO_TRY) {
    it(`sends a prompt in ${workspace} without auth/engine errors`, async function () {
      const baseline = await logsLength();
      const alreadyActive = await isWorkspaceAlreadyActive(workspace);
      if (!alreadyActive) {
        const clicked = await clickWorkspaceInSidebar(workspace);
        if (!clicked) {
          console.log(`[spec] workspace ${workspace} not in sidebar — skipping`);
          this.skip();
          return;
        }
        // Let workspace activation kick off (workspaceActivate STEP 1-5 logs).
        await browser.pause(2_000);
      } else {
        console.log(`[spec] ${workspace} already active — sending prompt directly`);
      }
      const sent = await sendPrompt(PROMPT_TEXT);
      if (!sent) {
        throw new Error(`composer not found for ${workspace}`);
      }

      const result = await waitForResponseOrFailure(baseline, RESPONSE_TIMEOUT_MS);
      console.log(`[spec] ${workspace} result: ok=${result.ok} reason=${result.reason}`);
      if (!result.ok) {
        console.log(`[spec] FAIL logs for ${workspace} (last 30):`);
        result.logs.slice(-30).forEach((line) => console.log(line));
        throw new Error(`prompt failed in ${workspace}: ${result.reason}`);
      }
    });
  }
});
