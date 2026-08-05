import { sendComposerMessage } from "../scenario-kit/composer.mjs";
import { selectors } from "../scenario-kit/selectors.mjs";
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
import { runtimeAuthorizationPrimeCount } from "./managed-ai-worker-replacement.mjs";

async function waitForIsolatedWorkspaceComposer(browser, workspaceLabel) {
  // This runtime owns a brand-new profile with exactly one active workspace
  // and draft.  The sidebar's project-list component is intentionally lazy
  // and need not mount for that first draft, whereas the visible composer
  // provides the stronger proof that the submit is bound to our workspace.
  await browser.waitUntil(
    () => browser.execute((selector, expectedLabel) => {
      const candidates = Array.from(document.querySelectorAll(selector));
      return candidates.some((heading) => {
        const style = window.getComputedStyle(heading);
        return heading.getClientRects().length > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          (heading.textContent ?? "").includes(expectedLabel);
      });
    }, selectors.composerTargetHeading, workspaceLabel),
    {
      timeout: 90_000,
      interval: 150,
      timeoutMsg: `The isolated desktop composer did not bind to ${workspaceLabel}.`,
    },
  );
}

export async function executeIsolatedManagedAiWorkerReplacementScenario(context, input) {
  const { browser, step, snapshot, expectNoVisibleRuntimeError } = context;
  await step("controlled-worker-replacement.workspace.ready", () =>
    waitForIsolatedWorkspaceComposer(browser, input.workspace));

  // A completed warm-up proves the desktop is using the loopback fixture before
  // the recovery run starts. The next response is held by the fixture, not by a
  // browser mock, so worker replacement crosses the real native/server path.
  const warmupBaseline = await visibleAssistantMessages(browser);
  await step("controlled-worker-replacement.warmup.submit", () =>
    sendComposerMessage(browser, input.warmupMessage, input.workspace));
  await step("controlled-worker-replacement.warmup.provider", () =>
    input.fixture.waitForAttempts(1, { timeoutMs: 90_000 }));
  await step("controlled-worker-replacement.warmup.settle", () =>
    waitForSubmittedRunToSettle(browser, input.workspace));
  await step("controlled-worker-replacement.warmup.output", () =>
    waitForVisibleAssistantOutputCount(browser, warmupBaseline, 1));

  input.fixture.setHoldResponses(true);
  const responseBaseline = await visibleAssistantMessages(browser);
  const errorBaseline = await visibleAssistantErrors(browser);
  await step("controlled-worker-replacement.recovery.submit", () =>
    sendComposerMessage(browser, input.recoveryMessage, input.workspace));
  await step("controlled-worker-replacement.recovery.active", () => waitForRunToStart(browser));
  await step("controlled-worker-replacement.recovery.provider-held", () =>
    input.fixture.waitForAttempts(2, { timeoutMs: 90_000 }));
  await snapshot("controlled-worker-replacement.provider-held");

  const primeCountBeforeReplacement = runtimeAuthorizationPrimeCount(await collectSendWorkflowTrace(browser));
  const replacement = await step("controlled-worker-replacement.server-worker-restart", () =>
    restartVesloServerWorker(browser));
  const primeCountAfterReplacement = await step("controlled-worker-replacement.runtime-auth-reprime", async () => {
    await browser.waitUntil(
      async () => runtimeAuthorizationPrimeCount(await collectSendWorkflowTrace(browser)) > primeCountBeforeReplacement,
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: "The isolated desktop did not send a fresh managed-AI authorization prime after worker replacement.",
      },
    );
    return runtimeAuthorizationPrimeCount(await collectSendWorkflowTrace(browser));
  });

  await step("controlled-worker-replacement.provider-release", () => input.fixture.releaseHeldResponses());
  await step("controlled-worker-replacement.recovery.settle", () =>
    waitForSubmittedRunToSettle(browser, input.workspace));
  const outputs = await step("controlled-worker-replacement.recovery.one-visible-output", () =>
    waitForVisibleAssistantOutputCount(browser, responseBaseline, 1));
  if (outputs.length !== 1) {
    throw new Error(`Worker replacement produced ${outputs.length} visible assistant outputs for one recovery submit.`);
  }
  await step("controlled-worker-replacement.recovery.no-visible-error", () =>
    waitForNoVisibleAssistantError(browser, errorBaseline));
  await expectNoVisibleRuntimeError();

  const recoveryProviderAttempts = input.fixture.attempts.filter((attempt) =>
    attempt.prompt.includes(input.recoveryMessage));
  return {
    workspace: input.workspace,
    previousWorkerGeneration: replacement.previousGeneration,
    nextWorkerGeneration: replacement.nextGeneration,
    runtimeAuthorizationPrimeCountBeforeReplacement: primeCountBeforeReplacement,
    runtimeAuthorizationPrimeCountAfterReplacement: primeCountAfterReplacement,
    warmupProviderAttemptCount: input.fixture.attempts.length - recoveryProviderAttempts.length,
    recoveryProviderAttemptCount: recoveryProviderAttempts.length,
    visibleRecoveryOutputCount: outputs.length,
  };
}
