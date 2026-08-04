import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { attachComposerFile, sendComposerMessage } from "../scenario-kit/composer.mjs";
import {
  requireSingleSubmitContract,
  traceCursor,
  waitForCanonicalIdentityAdoption,
} from "../scenario-kit/submit-contract.mjs";
import {
  beginUiWarningCapture,
  finishUiWarningCapture,
} from "../scenario-kit/ui-warning-capture.mjs";
import {
  visibleAssistantErrors,
  visibleAssistantMessages,
  waitForNoVisibleAssistantError,
  waitForSubmittedRunToSettle,
  waitForVisibleAssistantOutputCount,
} from "../scenario-kit/waits.mjs";
import {
  selectWorkspaceForNewConversation,
  waitForSelectedSidebarSessionId,
} from "../scenario-kit/workspace.mjs";
import { selectors } from "../scenario-kit/selectors.mjs";

export const continuationDocumentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/continuation-document.txt",
);

async function waitForCanonicalDocumentUserRow(browser, message, filename, timeout = 30_000) {
  let rows = [];
  await browser.waitUntil(async () => {
    rows = await browser.execute((centerSelector, expectedMessage, expectedFilename) => {
      const center = document.querySelector(centerSelector);
      if (!center) return [];
      return Array.from(center.querySelectorAll('[data-message-role="user"]')).flatMap((row) => {
        const style = window.getComputedStyle(row);
        const text = row.textContent?.trim() ?? "";
        const messageId = row.getAttribute("data-message-id")?.trim() ?? "";
        const visible = row.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
        return visible && messageId && text.includes(expectedMessage) && text.includes(expectedFilename)
          ? [{ messageId }]
          : [];
      });
    }, selectors.sessionCenterPane, message, filename);
    return rows.length === 1;
  }, {
    timeout,
    interval: 150,
    timeoutMsg: "The identity-adopted canonical document user row did not become uniquely visible.",
  });
  return rows[0];
}

async function submitAndProveOneAssistantTurn(context, {
  message,
  workspace,
  stepPrefix,
  expectedRoute,
  timeout = 180_000,
}) {
  const { browser, step, expectNoVisibleRuntimeError, sendWorkflowTrace } = context;
  const assistantBaseline = await visibleAssistantMessages(browser);
  const assistantErrorBaseline = await visibleAssistantErrors(browser);
  const traceBaseline = traceCursor(await sendWorkflowTrace());
  await step(`${stepPrefix}.submit`, () => sendComposerMessage(browser, message, workspace));
  await step(`${stepPrefix}.settle`, () => waitForSubmittedRunToSettle(browser, workspace, timeout));
  const outputs = await step(`${stepPrefix}.output`, () =>
    waitForVisibleAssistantOutputCount(browser, assistantBaseline, 1, timeout));
  if (outputs.length !== 1) {
    throw new Error(`${stepPrefix} produced ${outputs.length} new visible assistant turns instead of exactly one.`);
  }
  const submitContract = requireSingleSubmitContract(
    await sendWorkflowTrace(),
    traceBaseline,
    expectedRoute,
  );
  await expectNoVisibleRuntimeError();
  await step(`${stepPrefix}.no-terminal-error`, () =>
    waitForNoVisibleAssistantError(browser, assistantErrorBaseline));
  return { outputs, submitContract, traceBaseline };
}

async function submitDocumentAndAwaitCanonical(context, input, expectedRoute) {
  const { browser, step, sendWorkflowTrace } = context;
  const traceBaseline = traceCursor(await sendWorkflowTrace());
  const attachment = await step("document.attach", () =>
    attachComposerFile(browser, continuationDocumentPath, input.workspace));
  const assistantBaseline = await visibleAssistantMessages(browser);
  const assistantErrorBaseline = await visibleAssistantErrors(browser);
  await step("document.message.submit", () =>
    sendComposerMessage(browser, input.documentMessage, input.workspace));
  await step("document.message.settle", () =>
    waitForSubmittedRunToSettle(browser, input.workspace, 180_000));
  const outputs = await step("document.message.output", () =>
    waitForVisibleAssistantOutputCount(browser, assistantBaseline, 1, 180_000));
  if (outputs.length !== 1) {
    throw new Error(`Document message produced ${outputs.length} new visible assistant turns instead of exactly one.`);
  }
  const identityAdoption = await step("document.message.identity-canonical-adoption", () =>
    waitForCanonicalIdentityAdoption(browser, traceBaseline));
  const canonicalUserRow = await step("document.message.canonical-user-row", () =>
    waitForCanonicalDocumentUserRow(browser, input.documentMessage, attachment.filename));
  const submitContract = requireSingleSubmitContract(
    await sendWorkflowTrace(),
    traceBaseline,
    expectedRoute,
  );
  await context.expectNoVisibleRuntimeError();
  await step("document.message.no-terminal-error", () =>
    waitForNoVisibleAssistantError(browser, assistantErrorBaseline));
  return {
    attachment,
    identityAdoption,
    canonicalUserRow,
    outputCount: outputs.length,
    submitContract,
  };
}

async function submitFollowUp(context, input) {
  const { browser, step, sendWorkflowTrace } = context;
  const assistantBaseline = await visibleAssistantMessages(browser);
  const assistantErrorBaseline = await visibleAssistantErrors(browser);
  const traceBaseline = traceCursor(await sendWorkflowTrace());
  await step("document.follow-up.submit", () =>
    sendComposerMessage(browser, input.followUpMessage, input.workspace));
  await step("document.follow-up.settle", () =>
    waitForSubmittedRunToSettle(browser, input.workspace, 180_000));
  const outputs = await step("document.follow-up.output", () =>
    waitForVisibleAssistantOutputCount(browser, assistantBaseline, 1, 180_000));
  if (outputs.length !== 1) {
    throw new Error(`Document follow-up produced ${outputs.length} new visible assistant turns instead of exactly one.`);
  }
  const submitContract = requireSingleSubmitContract(
    await sendWorkflowTrace(),
    traceBaseline,
    "existing",
  );
  await context.expectNoVisibleRuntimeError();
  await step("document.follow-up.no-terminal-error", () =>
    waitForNoVisibleAssistantError(browser, assistantErrorBaseline));
  return { outputCount: outputs.length, submitContract };
}

async function executeDocumentFollowUpScenario(context, input, { existingSession }) {
  const { browser, step, snapshot } = context;
  await step("document.open-new", () =>
    selectWorkspaceForNewConversation(browser, input.workspace, {
      requireDistinctConversation: true,
      acceptEmptyExistingDraft: true,
    }));

  let seed = null;
  if (existingSession) {
    seed = await submitAndProveOneAssistantTurn(context, {
      message: input.seedMessage,
      workspace: input.workspace,
      stepPrefix: "document.seed",
      expectedRoute: "new",
    });
  }

  await beginUiWarningCapture(browser, {
    captureKey: "__vesloDocumentSynchronizingUi",
    pattern: "synchron",
  });
  const document = await submitDocumentAndAwaitCanonical(
    context,
    input,
    existingSession ? "existing" : "new",
  );
  const sessionId = await step("document.capture-session", () =>
    waitForSelectedSidebarSessionId(browser, { expectedText: input.documentMessage }));
  await snapshot(existingSession ? "existing-session-document-canonical" : "first-session-document-canonical");

  const followUp = await submitFollowUp(context, input);
  const selectedAfterFollowUp = await waitForSelectedSidebarSessionId(browser, {
    expectedText: input.documentMessage,
  });
  if (selectedAfterFollowUp !== sessionId) {
    throw new Error("Document follow-up changed conversation identity.");
  }
  await finishUiWarningCapture(browser, {
    captureKey: "__vesloDocumentSynchronizingUi",
    label: "synchronizing toast or inline status",
  });

  return {
    workspace: input.workspace,
    sessionId,
    documentFilename: document.attachment.filename,
    canonicalUserMessageId: document.canonicalUserRow.messageId,
    identityAdoptionMatch: document.identityAdoption.matchKind,
    documentSubmitCount: document.submitContract.submitStartCount,
    documentAssistantTurnCount: document.outputCount,
    followUpSubmitCount: followUp.submitContract.submitStartCount,
    followUpAssistantTurnCount: followUp.outputCount,
    seedSubmitCount: seed?.submitContract.submitStartCount ?? null,
  };
}

export async function executeFirstSessionDocumentFollowUpScenario(context, input) {
  return executeDocumentFollowUpScenario(context, input, { existingSession: false });
}

export async function executeExistingSessionDocumentFollowUpScenario(context, input) {
  return executeDocumentFollowUpScenario(context, input, { existingSession: true });
}
