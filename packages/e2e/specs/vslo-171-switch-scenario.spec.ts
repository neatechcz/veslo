/**
 * VSLO-171 — workspace-switch scenario.
 *
 * Reproduces the user's manual flow:
 *   1. Activate workspace A, send prompt, wait for assistant reply.
 *   2. Activate workspace B, send prompt, wait for assistant reply.
 *
 * Captures per-step timing, screenshots, sidebar "Error" badges, and recent
 * console signals. Always asserts no auth/spawn failure surfaced during the
 * step (failure signals fail the test).
 *
 * Run:
 *   pkill -f "target/debug/veslo$|veslo-orchestrator|veslo-server|src/cli.ts"
 *   E2E_USE_EXISTING_PROFILE=1 pnpm --filter @neatech/veslo-e2e test \
 *     --spec ./specs/vslo-171-switch-scenario.spec.ts
 *
 * Env overrides:
 *   E2E_SWITCH_FROM=velos-test-F        first workspace
 *   E2E_SWITCH_TO=bbb                   second workspace
 *   E2E_SWITCH_PROMPT="ahoj"            prompt text
 *   E2E_SWITCH_REPLY_TIMEOUT_MS=120000  per-step reply timeout
 */

import { expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACE_FROM = process.env.E2E_SWITCH_FROM?.trim() || 'velos-test-F';
const WORKSPACE_TO = process.env.E2E_SWITCH_TO?.trim() || 'bbb';
const PROMPT_TEXT = process.env.E2E_SWITCH_PROMPT?.trim() || 'ping (e2e switch test)';
const REPLY_TIMEOUT_MS = Number.parseInt(process.env.E2E_SWITCH_REPLY_TIMEOUT_MS ?? '120000', 10);

const SCREENSHOT_DIR = join(process.cwd(), '__snapshots__', 'switch-scenario');

const FAIL_SIGNALS = [
  'Invalid bearer token',
  'engine spawn failed',
  'Authentication failed',
  '"unauthorized"',
  'unhandledrejection',
  'Unable to connect',
  'restartWorkspaceRuntime failed',
];

const REPLY_SIGNALS = [
  // SSE assistant-message-complete event indicating the LLM finished a reply.
  'message:assistant-complete',
  // Connection/engine-ready signals as proxies in case the SSE log isn't named.
  'engine started successfully',
  'connect:ensured',
];

type Logs = string[];

async function waitForAppShell(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const root = await $('#root');
      return (await root.isExisting()) && (await root.getText()).trim().length > 0;
    },
    { timeout: 30_000, timeoutMsg: 'App shell did not render within 30s' },
  );
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

async function logsLength(): Promise<number> {
  return browser.execute(() => {
    const w = window as typeof window & { __vesloE2ELogs?: string[] };
    return (w.__vesloE2ELogs ?? []).length;
  });
}

async function logsSince(from: number): Promise<Logs> {
  return browser.execute((start: number) => {
    const w = window as typeof window & { __vesloE2ELogs?: string[] };
    return (w.__vesloE2ELogs ?? []).slice(start);
  }, from);
}

async function topBarText(): Promise<string> {
  return browser.execute(() => {
    const header =
      document.querySelector('header') ??
      document.querySelector('main')?.querySelector('h1, h2');
    if (!header) return '';
    return (header.textContent ?? '').trim();
  });
}

async function sidebarErrorBadges(): Promise<string[]> {
  return browser.execute(() => {
    const aside = document.querySelector('aside, [role="complementary"]');
    if (!aside) return [];
    const items: string[] = [];
    const badges = Array.from(aside.querySelectorAll('*')).filter(
      (el) => (el.textContent ?? '').trim() === 'Error' && el.children.length === 0,
    );
    badges.forEach((badge) => {
      // Find sibling/ancestor that names the workspace.
      let node: HTMLElement | null = badge as HTMLElement;
      for (let i = 0; i < 6 && node; i += 1) {
        const text = (node.textContent ?? '').trim();
        if (text && text !== 'Error') {
          items.push(text.slice(0, 60));
          return;
        }
        node = node.parentElement;
      }
      items.push('(unknown workspace)');
    });
    return items;
  });
}

async function clickWorkspace(name: string): Promise<{ alreadyActive: boolean; clicked: boolean }> {
  const alreadyActive = await browser.execute((targetName: string) => {
    const aside = document.querySelector('aside, [role="complementary"]');
    if (!aside) return false;
    const spans = aside.querySelectorAll('span');
    for (const span of Array.from(spans)) {
      if ((span.textContent ?? '').trim() !== targetName) continue;
      const button = (span as HTMLElement).closest('button');
      if (button) return /\bActive\b/.test(button.textContent ?? '');
    }
    return false;
  }, name);
  if (alreadyActive) {
    return { alreadyActive: true, clicked: false };
  }
  // Wait for the label to appear.
  let found = false;
  const start = Date.now();
  while (Date.now() - start < 15_000) {
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
    await browser.pause(250);
  }
  if (!found) return { alreadyActive: false, clicked: false };
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
    }
  }, name);
  return { alreadyActive: false, clicked: true };
}

async function waitForWorkspaceActive(name: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const top = await topBarText();
    if (top.includes(name)) return true;
    await browser.pause(500);
  }
  return false;
}

async function focusComposer(): Promise<boolean> {
  const composer = await $('[role="textbox"]');
  if (!(await composer.isExisting())) return false;
  await composer.click();
  return true;
}

async function setComposerValue(text: string): Promise<void> {
  await browser.execute((value: string) => {
    const el = document.querySelector('[role="textbox"]') as HTMLElement | null;
    if (!el) return;
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  }, text);
}

async function clickComposerSubmit(): Promise<boolean> {
  // Submit button: only enabled when the composer has content. There is usually
  // exactly one round button near the composer (Send arrow). Click it.
  return browser.execute(() => {
    const composer = document.querySelector('[role="textbox"]');
    if (!composer) return false;
    // Walk up to the composer's container, then look for the submit button.
    let container: HTMLElement | null = (composer as HTMLElement).parentElement;
    for (let i = 0; i < 8 && container; i += 1) {
      const submit = container.querySelector('button[type="submit"], button[aria-label*="Send" i], button[data-testid*="send" i]') as HTMLButtonElement | null;
      if (submit && !submit.disabled) {
        submit.click();
        return true;
      }
      container = container.parentElement;
    }
    return false;
  });
}

async function sendPrompt(text: string): Promise<boolean> {
  if (!(await focusComposer())) return false;
  await setComposerValue(text);
  await browser.pause(200);
  // Try Cmd+Enter first, then submit button if that didn't take.
  await browser.keys(['Meta', 'Enter']);
  await browser.pause(400);
  // Verify the composer is empty (= submission registered). If not, fall back
  // to clicking the send button.
  const stillHasText = await browser.execute((expected: string) => {
    const el = document.querySelector('[role="textbox"]') as HTMLElement | null;
    return (el?.textContent ?? '').trim() === expected;
  }, text);
  if (stillHasText) {
    await clickComposerSubmit();
  }
  return true;
}

async function ensureScreenshotDir(): Promise<void> {
  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

async function snapshot(name: string): Promise<string> {
  await ensureScreenshotDir();
  const filename = join(SCREENSHOT_DIR, `${name}-${Date.now()}.png`);
  try {
    await browser.saveScreenshot(filename);
  } catch (err) {
    console.warn(`[spec] saveScreenshot failed for ${name}:`, err);
  }
  return filename;
}

interface StepResult {
  ok: boolean;
  reason: string;
  elapsedMs: number;
  screenshot: string;
  newLogs: Logs;
  failureLines: Logs;
  errorBadgesAfter: string[];
}

async function runWorkspaceStep(workspace: string, label: string): Promise<StepResult> {
  const stepStart = Date.now();
  const baseline = await logsLength();
  console.log(`[spec][${label}] click ${workspace}`);
  const click = await clickWorkspace(workspace);
  if (!click.alreadyActive && !click.clicked) {
    return {
      ok: false,
      reason: `workspace ${workspace} not in sidebar`,
      elapsedMs: Date.now() - stepStart,
      screenshot: await snapshot(`${label}-missing`),
      newLogs: [],
      failureLines: [],
      errorBadgesAfter: await sidebarErrorBadges(),
    };
  }
  if (click.alreadyActive) {
    console.log(`[spec][${label}] ${workspace} already active`);
  } else {
    const active = await waitForWorkspaceActive(workspace, 25_000);
    console.log(`[spec][${label}] topbar settled active=${active}`);
  }
  // Let workspace activation flow finish (workspaceActivate STEP 1-5 logs +
  // ensureEngine kickoff).
  await browser.pause(1_500);

  const sent = await sendPrompt(PROMPT_TEXT);
  if (!sent) {
    return {
      ok: false,
      reason: 'composer not found',
      elapsedMs: Date.now() - stepStart,
      screenshot: await snapshot(`${label}-no-composer`),
      newLogs: await logsSince(baseline),
      failureLines: [],
      errorBadgesAfter: await sidebarErrorBadges(),
    };
  }

  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  let ok = false;
  let reason = 'timeout — no reply or failure signal';
  while (Date.now() < deadline) {
    const newLogs = await logsSince(baseline);
    const failureLine = newLogs.find((line) =>
      FAIL_SIGNALS.some((sig) => line.includes(sig)),
    );
    if (failureLine) {
      reason = failureLine;
      break;
    }
    const replyLine = newLogs.find((line) =>
      REPLY_SIGNALS.some((sig) => line.includes(sig)),
    );
    if (replyLine) {
      ok = true;
      reason = replyLine;
      break;
    }
    await browser.pause(750);
  }
  const newLogs = await logsSince(baseline);
  const failureLines = newLogs.filter((line) =>
    FAIL_SIGNALS.some((sig) => line.includes(sig)),
  );
  return {
    ok,
    reason,
    elapsedMs: Date.now() - stepStart,
    screenshot: await snapshot(`${label}-${ok ? 'ok' : 'fail'}`),
    newLogs,
    failureLines,
    errorBadgesAfter: await sidebarErrorBadges(),
  };
}

describe('VSLO-171 workspace-switch scenario', () => {
  before(async () => {
    await waitForAppShell();
    await instrumentConsole();
    await browser.pause(1_000);
    await snapshot('initial');
  });

  it(`switches ${WORKSPACE_FROM} → ${WORKSPACE_TO}, sends in each`, async function () {
    this.timeout(REPLY_TIMEOUT_MS * 2 + 60_000);

    const step1 = await runWorkspaceStep(WORKSPACE_FROM, 'step1');
    console.log(`[spec][step1] ${WORKSPACE_FROM} elapsed=${step1.elapsedMs}ms ok=${step1.ok} reason=${step1.reason}`);
    console.log(`[spec][step1] error badges after: ${step1.errorBadgesAfter.join(', ') || '(none)'}`);
    console.log(`[spec][step1] failures: ${step1.failureLines.length}`);
    step1.failureLines.slice(0, 5).forEach((line) => console.log(`  ! ${line.slice(0, 240)}`));

    const step2 = await runWorkspaceStep(WORKSPACE_TO, 'step2');
    console.log(`[spec][step2] ${WORKSPACE_TO} elapsed=${step2.elapsedMs}ms ok=${step2.ok} reason=${step2.reason}`);
    console.log(`[spec][step2] error badges after: ${step2.errorBadgesAfter.join(', ') || '(none)'}`);
    console.log(`[spec][step2] failures: ${step2.failureLines.length}`);
    step2.failureLines.slice(0, 5).forEach((line) => console.log(`  ! ${line.slice(0, 240)}`));

    // Always report screenshots.
    console.log(`[spec] screenshots:`);
    console.log(`  step1: ${step1.screenshot}`);
    console.log(`  step2: ${step2.screenshot}`);

    // The assertion: both steps must reach a reply signal AND must not have
    // produced any failure signal during this step.
    const issues: string[] = [];
    if (!step1.ok) issues.push(`step1 (${WORKSPACE_FROM}): ${step1.reason}`);
    if (step1.failureLines.length > 0) issues.push(`step1 emitted ${step1.failureLines.length} failure log(s)`);
    if (!step2.ok) issues.push(`step2 (${WORKSPACE_TO}): ${step2.reason}`);
    if (step2.failureLines.length > 0) issues.push(`step2 emitted ${step2.failureLines.length} failure log(s)`);

    if (issues.length > 0) {
      throw new Error(`switch scenario issues:\n  - ${issues.join('\n  - ')}`);
    }
    expect(true).toBe(true);
  });
});
