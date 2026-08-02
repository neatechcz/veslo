import { fail } from "../attach-smoke.mjs";
import { selectors } from "./selectors.mjs";
import { waitForComposerReady, waitForWorkspaceVisible } from "./waits.mjs";

function normalize(value) {
  return String(value ?? "").trim();
}

async function clickVisibleProjectNewSession(browser, projectSelector, projectKey) {
  return browser.execute((selector, expectedProjectKey, buttonSelector) => {
    const project = document.querySelector(selector);
    const button = project?.querySelector(buttonSelector);
    const style = button ? window.getComputedStyle(button) : null;
    if (
      !button ||
      project?.getAttribute("data-project-key") !== expectedProjectKey ||
      button.getClientRects().length === 0 ||
      style?.display === "none" ||
      style?.visibility === "hidden"
    ) return false;
    // The desktop native WebDriver implementation can report a successful
    // click on an opacity-transitioning control without delivering the
    // control's click handler. Keep this test scoped to the visible UI
    // control, then invoke its normal DOM click once and prove the resulting
    // conversation ownership below.
    button.click();
    return true;
  }, projectSelector, projectKey, selectors.projectNewSession);
}

async function clickVisibleProjectCollapseToggle(browser, projectSelector, projectKey) {
  return browser.execute((selector, expectedProjectKey) => {
    const project = document.querySelector(selector);
    const button = project?.querySelector('button[data-project-collapse-toggle]');
    const style = button ? window.getComputedStyle(button) : null;
    if (
      !button ||
      project?.getAttribute("data-project-key") !== expectedProjectKey ||
      button.getClientRects().length === 0 ||
      style?.display === "none" ||
      style?.visibility === "hidden"
    ) return false;
    // Native WebDriver may acknowledge a transition-time click without
    // delivering it. Invoke the same visible DOM control and verify aria state
    // below; no hidden state or transport API is touched here.
    button.click();
    return true;
  }, projectSelector, projectKey);
}

async function projectTargetForWorkspace(browser, workspaceLabel) {
  await waitForWorkspaceVisible(browser, workspaceLabel);
  const result = await browser.execute((label) => {
    const matches = Array.from(document.querySelectorAll("[data-project-key]"))
      .filter((project) => {
        const style = window.getComputedStyle(project);
        return project.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
      })
      .filter((project) => {
        const heading = project.querySelector('button[data-project-collapse-toggle] span.truncate, button span.truncate');
        return heading?.textContent?.trim() === label;
      });
    if (matches.length !== 1) return { count: matches.length, key: null };
    return { count: 1, key: matches[0].getAttribute("data-project-key") };
  }, workspaceLabel);
  if (result?.count !== 1 || !normalize(result.key)) {
    fail(`Workspace label is not an unambiguous visible project heading: ${workspaceLabel}.`);
  }
  const escapedKey = await browser.execute((key) => CSS.escape(key), result.key);
  return {
    projectKey: result.key,
    projectSelector: `[data-project-key="${escapedKey}"]`,
  };
}

async function visibleComposerSessionQueueKey(browser) {
  return browser.execute((selector, attribute) => {
    const composer = Array.from(document.querySelectorAll(selector)).find((element) => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    return composer?.getAttribute(attribute) ?? null;
  }, selectors.composerInput, selectors.composerSessionQueueKey);
}

async function visibleComposerTargetHeading(browser) {
  return browser.execute((selector) => {
    const heading = Array.from(document.querySelectorAll(selector)).find((element) => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    return heading?.textContent?.trim() ?? null;
  }, selectors.composerTargetHeading);
}

export async function selectWorkspaceForNewConversation(
  browser,
  workspaceLabel,
  { requireDistinctConversation = false } = {},
) {
  const { projectKey, projectSelector } = await projectTargetForWorkspace(browser, workspaceLabel);
  const project = await browser.$(projectSelector);
  await project.waitForExist({ timeout: 10_000 });
  await waitForComposerReady(browser);
  const previousSessionQueueKey = await visibleComposerSessionQueueKey(browser);
  if (!await clickVisibleProjectNewSession(browser, projectSelector, projectKey)) {
    fail(`New conversation control became unavailable for ${workspaceLabel}.`);
  }
  await browser.waitUntil(async () => {
    const nextSessionQueueKey = await visibleComposerSessionQueueKey(browser);
    if (!nextSessionQueueKey) return false;
    if (requireDistinctConversation && nextSessionQueueKey === previousSessionQueueKey) return false;
    return (await visibleComposerTargetHeading(browser))?.includes(workspaceLabel) === true;
  }, {
    timeout: 15_000,
    timeoutMsg: `Pending-draft composer did not become ready for ${workspaceLabel}.`,
  });
}

export async function setWorkspaceConversationListExpanded(browser, workspaceLabel, expanded) {
  const { projectKey, projectSelector } = await projectTargetForWorkspace(browser, workspaceLabel);
  const project = await browser.$(projectSelector);
  const toggle = await project.$('button[data-project-collapse-toggle]');
  await toggle.waitForDisplayed({ timeout: 10_000 });
  const isExpanded = () => toggle.getAttribute("aria-expanded").then((value) => value === "true");
  if (await isExpanded() === expanded) return;
  if (!await clickVisibleProjectCollapseToggle(browser, projectSelector, projectKey)) {
    fail(`Workspace conversation toggle became unavailable: ${workspaceLabel}.`);
  }
  await browser.waitUntil(isExpanded, {
    timeout: 10_000,
    timeoutMsg: `Workspace conversation list did not become ${expanded ? "expanded" : "collapsed"}: ${workspaceLabel}.`,
  });
}
