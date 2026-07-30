import { fail } from "../attach-smoke.mjs";
import { selectors } from "./selectors.mjs";
import { waitForComposerReady, waitForWorkspaceVisible } from "./waits.mjs";

function normalize(value) {
  return String(value ?? "").trim();
}

async function projectSelectorForWorkspace(browser, workspaceLabel) {
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
  return `[data-project-key="${escapedKey}"]`;
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

export async function selectWorkspaceForNewConversation(
  browser,
  workspaceLabel,
  { requireDistinctConversation = false } = {},
) {
  const project = await browser.$(await projectSelectorForWorkspace(browser, workspaceLabel));
  await project.waitForExist({ timeout: 10_000 });
  await waitForComposerReady(browser);
  const previousSessionQueueKey = await visibleComposerSessionQueueKey(browser);
  const projectKey = await project.getAttribute("data-project-key");
  await project.moveTo();
  let newConversation = null;
  await browser.waitUntil(async () => {
    const candidates = await browser.$$(selectors.projectNewSession);
    for (const candidate of candidates) {
      const candidateProjectKey = await browser.execute(
        (element) => element.closest("[data-project-key]")?.getAttribute("data-project-key") ?? null,
        candidate,
      );
      const rendered = await browser.execute((element) => {
        const style = window.getComputedStyle(element);
        return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
      }, candidate);
      if (candidateProjectKey === projectKey && rendered) {
        newConversation = candidate;
        return true;
      }
    }
    return false;
  }, { timeout: 10_000, timeoutMsg: `New conversation control did not become visible for ${workspaceLabel}.` });
  if (!newConversation) {
    fail(`New conversation control is unavailable for ${workspaceLabel}.`);
  }
  // This contextual control intentionally fades in with the project hover
  // state.  WebDriver can report it as not enabled while it is still a normal
  // button with no disabled attribute, so assert rendered presence and use
  // the same hover-then-click interaction a user performs.
  await newConversation.moveTo();
  await newConversation.click();
  if (requireDistinctConversation) {
    await browser.waitUntil(async () => {
      const nextSessionQueueKey = await visibleComposerSessionQueueKey(browser);
      return Boolean(nextSessionQueueKey && nextSessionQueueKey !== previousSessionQueueKey);
    }, {
      timeout: 15_000,
      timeoutMsg: `New conversation did not receive a distinct conversation ownership state for ${workspaceLabel}.`,
    });
  }

  await browser.waitUntil(() => browser.execute((selector, label) => {
    const visibleHeading = Array.from(document.querySelectorAll(selector)).find((element) => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    // Once a conversation exists the footer composer intentionally omits this
    // heading. The exact project button was already resolved and clicked.
    return !visibleHeading || visibleHeading.textContent?.includes(label);
  }, selectors.composerTargetHeading, workspaceLabel), {
    timeout: 15_000,
    timeoutMsg: `Composer did not switch to ${workspaceLabel}.`,
  });
}

export async function setWorkspaceConversationListExpanded(browser, workspaceLabel, expanded) {
  const project = await browser.$(await projectSelectorForWorkspace(browser, workspaceLabel));
  const toggle = await project.$('button[data-project-collapse-toggle]');
  await toggle.waitForDisplayed({ timeout: 10_000 });
  const isExpanded = () => toggle.getAttribute("aria-expanded").then((value) => value === "true");
  if (await isExpanded() === expanded) return;
  await toggle.click();
  await browser.waitUntil(isExpanded, {
    timeout: 10_000,
    timeoutMsg: `Workspace conversation list did not become ${expanded ? "expanded" : "collapsed"}: ${workspaceLabel}.`,
  });
}
