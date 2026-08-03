import { sendComposerMessage } from "../scenario-kit/composer.mjs";
import {
  openSidebarSession,
  sidebarSessionIdForVisibleText,
  selectWorkspaceForNewConversation,
} from "../scenario-kit/workspace.mjs";
import {
  visibleAssistantErrors,
  visibleAssistantMessages,
  waitForNoVisibleAssistantError,
  waitForRunToStart,
  waitForSubmittedRunToSettle,
  waitForVisibleAssistantOutputCount,
} from "../scenario-kit/waits.mjs";
import { selectors } from "../scenario-kit/selectors.mjs";

async function visibleUserTranscriptText(browser) {
  return browser.execute((centerSelector) => {
    const center = document.querySelector(centerSelector);
    if (!center) return [];
    return Array.from(center.querySelectorAll('[data-message-role="user"]')).flatMap((row) => {
      const style = window.getComputedStyle(row);
      const visible = row.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
      const text = row.textContent?.trim() ?? "";
      return visible && text ? [text] : [];
    });
  }, selectors.sessionCenterPane);
}

async function waitForHistoricalTranscript(browser, seedMessage, interludeMessage) {
  await browser.waitUntil(async () => {
    const messages = await visibleUserTranscriptText(browser);
    return messages.some((text) => text.includes(seedMessage)) &&
      !messages.some((text) => text.includes(interludeMessage));
  }, {
    timeout: 30_000,
    interval: 150,
    timeoutMsg: "Reopened historical conversation did not show its own transcript without the intervening conversation.",
  });
}

export async function executeHistoricalConversationRoundtripScenario(context, input) {
  const { browser, step, snapshot, expectNoVisibleRuntimeError } = context;

  await step("historical.seed.open-new", () =>
    selectWorkspaceForNewConversation(browser, input.workspace, { requireDistinctConversation: true }));
  await step("historical.seed.submit", () => sendComposerMessage(browser, input.seedMessage, input.workspace));
  await step("historical.seed.settle", () => waitForSubmittedRunToSettle(browser, input.workspace));
  const seedSessionId = await step("historical.seed.capture-session", async () => {
    return sidebarSessionIdForVisibleText(browser, input.seedMessage);
  });

  await step("historical.interlude.open-new", () =>
    selectWorkspaceForNewConversation(browser, input.workspace, { requireDistinctConversation: true }));
  await step("historical.interlude.submit", () => sendComposerMessage(browser, input.interludeMessage, input.workspace));
  await step("historical.interlude.settle", () => waitForSubmittedRunToSettle(browser, input.workspace));
  const interludeSessionId = await step("historical.interlude.capture-session", async () => {
    const sessionId = await sidebarSessionIdForVisibleText(browser, input.interludeMessage);
    if (!sessionId || sessionId === seedSessionId) {
      throw new Error("Intervening conversation did not receive a distinct visible sidebar identity.");
    }
    return sessionId;
  });

  await step("historical.seed.reopen", () => openSidebarSession(browser, seedSessionId, input.workspace));
  await step("historical.seed.projection-isolated", () =>
    waitForHistoricalTranscript(browser, input.seedMessage, input.interludeMessage));
  await snapshot("historical-reopened");

  const assistantBaseline = await visibleAssistantMessages(browser);
  const assistantErrorBaseline = await visibleAssistantErrors(browser);
  await step("historical.continuation.submit", () =>
    sendComposerMessage(browser, input.continuationMessage, input.workspace));
  await step("historical.continuation.started", () => waitForRunToStart(browser));
  await step("historical.continuation.settle", () => waitForSubmittedRunToSettle(browser, input.workspace));
  const outputs = await step("historical.continuation.output", () =>
    waitForVisibleAssistantOutputCount(browser, assistantBaseline, 1));
  if (outputs.length !== 1) {
    throw new Error(`Historical continuation produced ${outputs.length} new visible assistant turns instead of exactly one.`);
  }
  await expectNoVisibleRuntimeError();
  await step("historical.continuation.no-terminal-error", () =>
    waitForNoVisibleAssistantError(browser, assistantErrorBaseline));

  return {
    workspace: input.workspace,
    seedSessionId,
    interludeSessionId,
    continuationOutputCount: outputs.length,
  };
}
