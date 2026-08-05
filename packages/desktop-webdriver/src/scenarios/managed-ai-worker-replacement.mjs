import { sendComposerMessage } from "../scenario-kit/composer.mjs";
import { selectWorkspaceForNewConversation } from "../scenario-kit/workspace.mjs";
import { restartVesloServerWorker } from "../scenario-kit/tauri-command.mjs";
import {
  visibleAssistantErrors,
  visibleAssistantMessages,
  waitForNoVisibleAssistantError,
  waitForRunToStart,
  waitForSubmittedRunToSettle,
  waitForVisibleAssistantOutputCount,
} from "../scenario-kit/waits.mjs";
import { collectSendWorkflowTrace } from "../scenario-kit/transcript-trace-summary.mjs";

export function runtimeAuthorizationPrimeCount(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => /(?:^|:)managed-ai-runtime-auth-prime:start$/.test(String(entry?.event ?? "")))
    .length;
}

export async function executeManagedAiWorkerReplacementScenario(context, input) {
  const { browser, step, snapshot, expectNoVisibleRuntimeError } = context;
  await step("worker-replacement.workspace.select", () =>
    selectWorkspaceForNewConversation(browser, input.workspace, { requireDistinctConversation: true }));
  const assistantBaseline = await visibleAssistantMessages(browser);
  const assistantErrorBaseline = await visibleAssistantErrors(browser);

  await step("worker-replacement.submit", () => sendComposerMessage(browser, input.message, input.workspace));
  await step("worker-replacement.run-started", () => waitForRunToStart(browser));
  await snapshot("worker-replacement.active-run");
  const primeCountBeforeReplacement = runtimeAuthorizationPrimeCount(await collectSendWorkflowTrace(browser));
  const replacement = await step("worker-replacement.server-worker-restart", () =>
    restartVesloServerWorker(browser));
  const primeCountAfterReplacement = await step("worker-replacement.runtime-auth-reprime", async () => {
    await browser.waitUntil(
      async () => runtimeAuthorizationPrimeCount(await collectSendWorkflowTrace(browser)) > primeCountBeforeReplacement,
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: "Desktop did not re-prime managed AI authorization after the server worker generation changed.",
      },
    );
    return runtimeAuthorizationPrimeCount(await collectSendWorkflowTrace(browser));
  });
  await step("worker-replacement.run-settled", () => waitForSubmittedRunToSettle(browser, input.workspace));
  const outputs = await step("worker-replacement.visible-output", () =>
    waitForVisibleAssistantOutputCount(browser, assistantBaseline, 1));
  await step("worker-replacement.no-assistant-error", () =>
    waitForNoVisibleAssistantError(browser, assistantErrorBaseline));
  await expectNoVisibleRuntimeError();

  return {
    workspace: input.workspace,
    messageLength: input.message.length,
    outputCount: outputs.length,
    runtimeAuthorizationPrimeCountBeforeReplacement: primeCountBeforeReplacement,
    runtimeAuthorizationPrimeCountAfterReplacement: primeCountAfterReplacement,
    previousWorkerGeneration: replacement.previousGeneration,
    nextWorkerGeneration: replacement.nextGeneration,
  };
}
