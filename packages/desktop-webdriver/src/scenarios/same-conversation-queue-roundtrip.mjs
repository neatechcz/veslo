import { queueComposerMessageWithEnter, sendComposerMessage } from "../scenario-kit/composer.mjs";
import { selectWorkspaceForNewConversation } from "../scenario-kit/workspace.mjs";
import {
  visibleAssistantMessages,
  visibleAssistantErrors,
  waitForNoVisibleAssistantError,
  waitForRunToStart,
  waitForSubmittedRunToSettle,
  waitForVisibleAssistantOutputCount,
} from "../scenario-kit/waits.mjs";

export async function executeSameConversationQueueRoundtripScenario(context, input) {
  const { browser, step, snapshot, expectNoVisibleRuntimeError } = context;
  await step("queue.workspace.select", () =>
    selectWorkspaceForNewConversation(browser, input.workspace, { requireDistinctConversation: true }));
  await snapshot("queue.composer-ready");

  const assistantBaseline = await visibleAssistantMessages(browser);
  const assistantErrorBaseline = await visibleAssistantErrors(browser);
  await step("queue.first.submit", () => sendComposerMessage(browser, input.firstMessage, input.workspace));
  await step("queue.first.run-started", () => waitForRunToStart(browser));
  await step("queue.second.submit-while-running", () =>
    queueComposerMessageWithEnter(browser, input.secondMessage, input.workspace));
  const messages = [input.firstMessage, input.secondMessage];
  if (input.thirdMessage && input.thirdAfterSettleMs === null) {
    await step("queue.third.submit-while-running", () =>
      queueComposerMessageWithEnter(browser, input.thirdMessage, input.workspace));
    messages.push(input.thirdMessage);
  }
  await step("queue.all-runs-settle", () => waitForSubmittedRunToSettle(browser, input.workspace));
  if (input.thirdMessage && input.thirdAfterSettleMs !== null) {
    await step("queue.third.wait-after-settle", () => browser.pause(input.thirdAfterSettleMs));
    await step("queue.third.submit-after-settle", () =>
      sendComposerMessage(browser, input.thirdMessage, input.workspace));
    await step("queue.third.run-settle", () => waitForSubmittedRunToSettle(browser, input.workspace));
    messages.push(input.thirdMessage);
  }
  const outputs = await step("queue.visible-outputs", () =>
    waitForVisibleAssistantOutputCount(browser, assistantBaseline, messages.length));
  await expectNoVisibleRuntimeError();
  await step("queue.no-terminal-assistant-error", () =>
    waitForNoVisibleAssistantError(browser, assistantErrorBaseline));

  return {
    workspace: input.workspace,
    messageLengths: messages.map((message) => message.length),
    outputCount: outputs.length,
  };
}
