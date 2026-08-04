import { sendComposerMessage } from "../scenario-kit/composer.mjs";
import {
  openSidebarSession,
  sidebarSessionIdForVisibleText,
  selectWorkspaceForNewConversation,
  waitForSelectedSidebarSessionId,
} from "../scenario-kit/workspace.mjs";
import { disposeDirectWorkspaceEngine } from "../scenario-kit/orchestrator-control.mjs";
import {
  requireSingleSubmitContract,
  traceCursor,
} from "../scenario-kit/submit-contract.mjs";
import {
  beginUiWarningCapture,
  finishUiWarningCapture,
} from "../scenario-kit/ui-warning-capture.mjs";
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
      (!interludeMessage || !messages.some((text) => text.includes(interludeMessage)));
  }, {
    timeout: 30_000,
    interval: 150,
    timeoutMsg: "Reopened historical conversation did not show its own transcript without the intervening conversation.",
  });
}

async function submitAndProveSingleAssistantTurn(context, message, workspace, stepPrefix) {
  const { browser, step, expectNoVisibleRuntimeError } = context;
  const assistantBaseline = await visibleAssistantMessages(browser);
  const assistantErrorBaseline = await visibleAssistantErrors(browser);
  await step(`${stepPrefix}.submit`, () => sendComposerMessage(browser, message, workspace));
  await step(`${stepPrefix}.settle`, () => waitForSubmittedRunToSettle(browser, workspace));
  const outputs = await step(`${stepPrefix}.output`, () =>
    waitForVisibleAssistantOutputCount(browser, assistantBaseline, 1));
  if (outputs.length !== 1) {
    throw new Error(`${stepPrefix} produced ${outputs.length} new visible assistant turns instead of exactly one.`);
  }
  await expectNoVisibleRuntimeError();
  await step(`${stepPrefix}.no-terminal-error`, () =>
    waitForNoVisibleAssistantError(browser, assistantErrorBaseline));
}

export async function seedHistoricalConversationScenario(context, input) {
  const { browser, step, expectNoVisibleRuntimeError } = context;

  await step("historical.seed.open-new", () =>
    selectWorkspaceForNewConversation(browser, input.workspace, { requireDistinctConversation: true }));
  await submitAndProveSingleAssistantTurn(context, input.seedMessage, input.workspace, "historical.seed");
  const seedSessionId = await step("historical.seed.capture-session", async () => {
    return sidebarSessionIdForVisibleText(browser, input.seedMessage);
  });

  await step("historical.interlude.open-new", () =>
    selectWorkspaceForNewConversation(browser, input.workspace, { requireDistinctConversation: true }));
  await submitAndProveSingleAssistantTurn(context, input.interludeMessage, input.workspace, "historical.interlude");
  const interludeSessionId = await step("historical.interlude.capture-session", async () => {
    const sessionId = await sidebarSessionIdForVisibleText(browser, input.interludeMessage);
    if (!sessionId || sessionId === seedSessionId) {
      throw new Error("Intervening conversation did not receive a distinct visible sidebar identity.");
    }
    return sessionId;
  });

  await expectNoVisibleRuntimeError();
  return {
    workspace: input.workspace,
    seedSessionId,
    interludeSessionId,
  };
}

export async function continueHistoricalConversationScenario(context, input, sessions) {
  const { browser, step, snapshot, expectNoVisibleRuntimeError } = context;
  const { seedSessionId, interludeSessionId } = sessions;
  if (!seedSessionId || !interludeSessionId || seedSessionId === interludeSessionId) {
    throw new Error("Historical continuation requires two distinct persisted conversation identities.");
  }

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

export async function executeExistingHistoricalContinuationScenario(context, input) {
  const { browser, step, snapshot, expectNoVisibleRuntimeError } = context;
  await step("historical.existing.reopen", () => openSidebarSession(browser, input.sessionId, input.workspace));
  await step("historical.existing.transcript-present", async () => {
    await browser.waitUntil(async () => (await visibleUserTranscriptText(browser)).length > 0, {
      timeout: 30_000,
      interval: 150,
      timeoutMsg: "Reopened historical conversation did not render an existing user transcript.",
    });
  });
  await snapshot("historical-existing-reopened");

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
    historicalSessionId: input.sessionId,
    continuationOutputCount: outputs.length,
  };
}

export async function executeHistoricalConversationRoundtripScenario(context, input) {
  const sessions = await seedHistoricalConversationScenario(context, input);
  return continueHistoricalConversationScenario(context, input, sessions);
}

export async function executeIdleSuspendHistoricalContinuationScenario(context, input) {
  const {
    browser,
    runtimeInfo,
    step,
    snapshot,
    expectNoVisibleRuntimeError,
    sendWorkflowTrace,
  } = context;

  await step("historical.seed.open-new", () =>
    selectWorkspaceForNewConversation(browser, input.workspace, {
      requireDistinctConversation: true,
      acceptEmptyExistingDraft: true,
    }));
  await submitAndProveSingleAssistantTurn(context, input.seedMessage, input.workspace, "historical.seed");
  const seedSessionId = await step("historical.seed.capture-selected-session", () =>
    waitForSelectedSidebarSessionId(browser, { expectedText: input.seedMessage }));

  const suspension = await step("historical.idle-suspend.dispose-direct-engine", () =>
    disposeDirectWorkspaceEngine({
      dataDir: runtimeInfo.dataDir,
      workspaceIdentity: input.workspace,
    }));
  if (suspension.childKind !== "direct" || suspension.childExitObserved !== true) {
    throw new Error("Idle-suspend continuation did not prove an observed direct child exit.");
  }

  await step("historical.seed.reopen", () => openSidebarSession(browser, seedSessionId, input.workspace));
  await step("historical.seed.projection-retained", () =>
    waitForHistoricalTranscript(browser, input.seedMessage, ""));
  await snapshot("historical-idle-suspend-reopened");

  const assistantBaseline = await visibleAssistantMessages(browser);
  const assistantErrorBaseline = await visibleAssistantErrors(browser);
  const submitTraceBaseline = traceCursor(await sendWorkflowTrace());
  await beginUiWarningCapture(browser, {
    captureKey: "__vesloIdleSuspendRecoveryUi",
    pattern: "terminal[_ -]handoff|recovery(?: is)? required|terminal_handoff_recovery_required",
  });
  await step("historical.continuation.submit", () =>
    sendComposerMessage(browser, input.continuationMessage, input.workspace));
  await step("historical.continuation.started", () => waitForRunToStart(browser));
  await step("historical.continuation.settle", () =>
    waitForSubmittedRunToSettle(browser, input.workspace));
  const outputs = await step("historical.continuation.output", () =>
    waitForVisibleAssistantOutputCount(browser, assistantBaseline, 1));
  if (outputs.length !== 1) {
    throw new Error(`Idle-suspend continuation produced ${outputs.length} new visible assistant turns instead of exactly one.`);
  }
  const submitContract = requireSingleSubmitContract(
    await sendWorkflowTrace(),
    submitTraceBaseline,
    "existing",
  );
  await finishUiWarningCapture(browser, {
    captureKey: "__vesloIdleSuspendRecoveryUi",
    label: "recovery-required UI",
  });
  await expectNoVisibleRuntimeError();
  await step("historical.continuation.no-terminal-error", () =>
    waitForNoVisibleAssistantError(browser, assistantErrorBaseline));

  return {
    workspace: input.workspace,
    seedSessionId,
    continuationOutputCount: outputs.length,
    continuationSubmitCount: submitContract.submitStartCount,
    suspendedChildKind: suspension.childKind,
    suspendedChildExitObserved: suspension.childExitObserved,
    suspendedEngineOwnerId: suspension.engineOwnerId,
    suspendedEnginePid: suspension.pid,
  };
}
