import { sendComposerMessage } from "../scenario-kit/composer.mjs";
import { selectWorkspaceForNewConversation } from "../scenario-kit/workspace.mjs";
import {
  visibleAssistantMessages,
  waitForSubmittedRunToSettle,
  waitForVisibleAssistantOutput,
} from "../scenario-kit/waits.mjs";

export async function executeWorkspaceRoundtripScenario(context, input) {
  const { browser, step, snapshot, expectNoVisibleRuntimeError } = context;
  await step("workspace.initial.select", () =>
    selectWorkspaceForNewConversation(browser, input.initialWorkspace, { requireDistinctConversation: true }));
  await snapshot("workspace.initial.composer-ready");
  const initialAssistantMessages = await visibleAssistantMessages(browser);
  await step("workspace.initial.submit", () => sendComposerMessage(browser, input.firstMessage, input.initialWorkspace));
  await step("workspace.initial.settle", () => waitForSubmittedRunToSettle(browser, input.initialWorkspace));
  await step("workspace.initial.output", () =>
    waitForVisibleAssistantOutput(browser, initialAssistantMessages));
  await expectNoVisibleRuntimeError();
  await step("workspace.second.select", () =>
    selectWorkspaceForNewConversation(browser, input.secondWorkspace, { requireDistinctConversation: true }));
  await snapshot("workspace.second.composer-ready");
  const secondAssistantMessages = await visibleAssistantMessages(browser);
  await step("workspace.second.submit", () => sendComposerMessage(browser, input.secondMessage, input.secondWorkspace));
  await step("workspace.second.settle", () => waitForSubmittedRunToSettle(browser, input.secondWorkspace));
  await step("workspace.second.output", () =>
    waitForVisibleAssistantOutput(browser, secondAssistantMessages));
  await expectNoVisibleRuntimeError();
  return {
    workspaces: [input.initialWorkspace, input.secondWorkspace],
    messageLengths: [input.firstMessage.length, input.secondMessage.length],
  };
}
