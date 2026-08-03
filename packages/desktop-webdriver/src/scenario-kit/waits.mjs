import { fail } from "../attach-smoke.mjs";
import { selectors } from "./selectors.mjs";

export async function waitForComposerReady(browser, timeout = 15_000) {
  const composer = await browser.$(selectors.composerInput);
  await composer.waitForDisplayed({ timeout });
  return composer;
}

export async function waitForAppReady(browser, timeout = 15_000) {
  const root = await browser.$(selectors.appRoot);
  await root.waitForDisplayed({ timeout });
  return root;
}

// A fresh desktop runtime exposes WebDriver before the asynchronously hydrated
// workspace list is ready. Keep this wait scoped to the visible sidebar rather
// than treating normal cold-start hydration as a failed workspace scenario.
export async function waitForWorkspaceVisible(browser, workspaceLabel, timeout = 90_000) {
  await browser.waitUntil(
    () => browser.execute((label) => Array.from(document.querySelectorAll("[data-project-key]")).some((project) => {
      const style = window.getComputedStyle(project);
      if (project.getClientRects().length === 0 || style.display === "none" || style.visibility === "hidden") return false;
      const heading = project.querySelector('button[data-project-collapse-toggle] span.truncate, button span.truncate');
      return heading?.textContent?.trim() === label;
    }), workspaceLabel),
    { timeout, timeoutMsg: `Workspace is not visible in the sidebar: ${workspaceLabel}.` },
  );
}

export async function waitForOwnedColdRuntimeAdmission(browser, timeout = 12_000) {
  // The owned dev runtime publishes its WebDriver endpoint before the native
  // workspace admission proxy has finished registering. This is a startup
  // settle only; it deliberately does not start an engine or submit a probe.
  await browser.pause(timeout);
}

// The loopback endpoint is available before the first desktop sidebar render
// on a cold start, so give the real workspace hydration the same budget as
// the workspace-row wait above.
export async function waitForSessionSidebarReady(browser, timeout = 30_000) {
  const sidebar = await browser.$(selectors.leftSidebar);
  await sidebar.waitForDisplayed({ timeout });
  return sidebar;
}

// Retained for early scenario callers. New scenarios should make the route
// assumption explicit by using waitForSessionSidebarReady().
export const waitForSidebarReady = waitForSessionSidebarReady;

export async function waitForRunToStart(browser, timeout = 15_000) {
  await browser.waitUntil(
    () => browser.execute((selector) => Boolean(document.querySelector(selector)), selectors.runIndicator),
    { timeout, timeoutMsg: "The UI did not show an active run after submit." },
  );
}

// Skill creation is intentionally confirm-by-default. The optimistic run
// indicator appears before server admission, so it cannot distinguish a real
// engine run from the blocked confirmation result.
export async function confirmImplicitSkillCommand(browser, timeout = 15_000, { required = true } = {}) {
  const confirmationRequested = await browser.waitUntil(
    async () => {
      const confirmation = await browser.$(selectors.implicitSkillConfirmRun);
      return confirmation.isDisplayed().catch(() => false);
    },
    { timeout, timeoutMsg: "The skill creation submit did not request its required confirmation." },
  ).then(
    () => true,
    (error) => {
      if (required) throw error;
      return false;
    },
  );

  if (!confirmationRequested) return false;

  const confirmation = await browser.$(selectors.implicitSkillConfirmRun);
  await confirmation.waitForEnabled({ timeout });
  await confirmation.click();
  await browser.waitUntil(
    () => browser.execute(
      (selector) => !document.querySelector(selector),
      selectors.implicitSkillConfirmRun,
    ),
    { timeout, timeoutMsg: "The implicit skill confirmation did not close." },
  );
  return true;
}

export async function waitForSubmittedRunToSettle(browser, workspaceLabel, timeout = 120_000) {
  // Composer clearing proves only local admission. A cold server-owned submit
  // can take seconds before the UI publishes its run indicator; treating that
  // gap as an already-settled run hides both missing responses and steps.
  await waitForRunToStart(browser, Math.min(timeout, 15_000));
  await browser.waitUntil(
    () => browser.execute((selector) => !document.querySelector(selector), selectors.runIndicator),
    {
      timeout,
      timeoutMsg: `The submitted run in ${workspaceLabel} did not settle before switching workspaces.`,
    },
  );
}

export async function visibleAssistantMessages(browser) {
  return browser.execute((centerSelector, assistantSelector) => {
    const center = document.querySelector(centerSelector);
    if (!center) return [];
    return Array.from(center.querySelectorAll(assistantSelector)).flatMap((element) => {
      const style = window.getComputedStyle(element);
      const visible = element.getClientRects().length > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
      const messageId = element.getAttribute("data-message-id")?.trim() ?? "";
      const textLength = element.textContent?.trim().length ?? 0;
      return visible && messageId ? [{ messageId, textLength }] : [];
    });
  }, selectors.sessionCenterPane, selectors.assistantMessage);
}

export async function visibleAssistantErrors(browser) {
  return browser.execute((centerSelector, errorSelector) => {
    const center = document.querySelector(centerSelector);
    if (!center) return [];
    return Array.from(center.querySelectorAll(errorSelector)).flatMap((element) => {
      const message = element.closest("[data-message-role=\"assistant\"]");
      const style = window.getComputedStyle(element);
      const visible = element.getClientRects().length > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
      const messageId = message?.getAttribute("data-message-id")?.trim() ?? "";
      const text = element.textContent?.trim() ?? "";
      return visible && messageId ? [{ messageId, text }] : [];
    });
  }, selectors.sessionCenterPane, selectors.assistantMessageError);
}

export async function waitForVisibleAssistantOutput(browser, baselineMessages, timeout = 120_000) {
  const baselineIds = new Set((baselineMessages ?? []).map((message) => message.messageId));
  let delivered = null;
  await browser.waitUntil(async () => {
    const messages = await visibleAssistantMessages(browser);
    delivered = messages.find((message) => !baselineIds.has(message.messageId) && message.textLength > 0) ?? null;
    return delivered !== null;
  }, {
    timeout,
    interval: 150,
    timeoutMsg: "The submitted run completed without a new visible assistant output.",
  });
  return delivered;
}

export async function waitForVisibleAssistantOutputCount(
  browser,
  baselineMessages,
  expectedAdditionalCount,
  timeout = 120_000,
) {
  const baselineIds = new Set((baselineMessages ?? []).map((message) => message.messageId));
  let delivered = [];
  await browser.waitUntil(async () => {
    const messages = await visibleAssistantMessages(browser);
    delivered = messages.filter((message) => !baselineIds.has(message.messageId) && message.textLength > 0);
    return delivered.length >= expectedAdditionalCount;
  }, {
    timeout,
    interval: 150,
    timeoutMsg: `Expected ${expectedAdditionalCount} new visible assistant outputs, received ${delivered.length}.`,
  });
  return delivered;
}

export async function waitForNoVisibleOperationalError(browser, timeout = 2_000) {
  try {
    await browser.waitUntil(
      () => browser.execute((selector) => !document.querySelector(selector), selectors.operationalError),
      { timeout },
    );
  } catch {
    const message = await browser.execute((selector) => document.querySelector(selector)?.textContent?.trim() ?? "unknown error", selectors.operationalError);
    fail(`Visible operational error: ${message}`);
  }
}

export async function waitForNoVisibleAssistantError(browser, baselineErrors = [], timeout = 2_000) {
  const baselineIds = new Set(baselineErrors.map((error) => error.messageId));
  let errorMessage = "unknown assistant error";
  try {
    await browser.waitUntil(
      async () => {
        const currentErrors = await visibleAssistantErrors(browser);
        const newError = currentErrors.find((error) => !baselineIds.has(error.messageId));
        errorMessage = newError?.text || "unknown assistant error";
        return !newError;
      },
      { timeout },
    );
  } catch {
    fail(`Visible assistant error: ${errorMessage}`);
  }
}
