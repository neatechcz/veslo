import { sendComposerMessage } from "../scenario-kit/composer.mjs";
import { selectWorkspaceForNewConversation } from "../scenario-kit/workspace.mjs";
import { waitForSubmittedRunToSettle } from "../scenario-kit/waits.mjs";

export async function executeWorkspaceRoundtripScenario(context, input) {
  const { browser, step, snapshot, expectNoVisibleRuntimeError } = context;
  await step("workspace.initial.select", () => selectWorkspaceForNewConversation(browser, input.initialWorkspace));
  await snapshot("workspace.initial.composer-ready");
  await step("workspace.initial.submit", () => sendComposerMessage(browser, input.firstMessage, input.initialWorkspace));
  await step("workspace.initial.settle", () => waitForSubmittedRunToSettle(browser, input.initialWorkspace));
  await expectNoVisibleRuntimeError();
  await step("workspace.second.select", () => selectWorkspaceForNewConversation(browser, input.secondWorkspace));
  await snapshot("workspace.second.composer-ready");
  await step("workspace.second.submit", () => sendComposerMessage(browser, input.secondMessage, input.secondWorkspace));
  return {
    workspaces: [input.initialWorkspace, input.secondWorkspace],
    messageLengths: [input.firstMessage.length, input.secondMessage.length],
  };
}
