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
import {
  armWorkspaceEventStreamGate,
  readPooledWorkspaceEngine,
  releaseWorkspaceEventStreamGate,
  sameEngineGeneration,
} from "../scenario-kit/event-stream-gate-control.mjs";
import {
  analyzeCausalGapFrames,
  beginTurnContinuityCapture,
  findCausalGapTrace,
  finishTurnContinuityCapture,
  readTurnContinuityCapture,
  summarizeTurnContinuityFrames,
  waitForNewCapturedQueueOwner,
} from "../scenario-kit/turn-continuity-capture.mjs";
import { waitForWorkflowTraceEvent } from "../scenario-kit/workflow-trace-reader.mjs";

const requiredTracePath = (runtimeInfo, source) => {
  const path = runtimeInfo?.traces?.sendWorkflowTraceFiles?.[source]
    ?? runtimeInfo?.traces?.sendWorkflowTraceMirrorFiles?.[source];
  if (typeof path !== "string" || !path.trim()) {
    throw new Error(`The event-stream gate scenario requires the ${source} workflow trace file.`);
  }
  return path;
};

async function waitForUiReconnectState(sendWorkflowTrace, {
  afterTs,
  workspaceId,
  nextStatus,
  timeout = 30_000,
}) {
  let matched = null;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const entries = await sendWorkflowTrace();
    matched = entries.find((entry) =>
      entry?.event === "session-sse:reconnect-state-transition" &&
      Number(entry?.ts ?? 0) >= afterTs &&
      entry?.workspaceId === workspaceId &&
      entry?.nextStatus === nextStatus) ?? null;
    if (matched) return matched;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The UI did not enter reconnect state ${nextStatus} for ${workspaceId}.`);
}

export async function executeSameConversationQueueRoundtripScenario(context, input) {
  const {
    browser,
    runtimeInfo,
    step,
    snapshot,
    expectNoVisibleRuntimeError,
    sendWorkflowTrace,
  } = context;
  await step("queue.workspace.select", () =>
    selectWorkspaceForNewConversation(browser, input.workspace, { requireDistinctConversation: true }));
  await snapshot("queue.composer-ready");

  const assistantBaseline = await visibleAssistantMessages(browser);
  const assistantErrorBaseline = await visibleAssistantErrors(browser);
  await step("queue.first.submit", () => sendComposerMessage(browser, input.firstMessage, input.workspace));
  await step("queue.first.run-started", () => waitForRunToStart(browser));
  await step("queue.turn-continuity-capture.start", () => beginTurnContinuityCapture(browser));
  const initialFrames = await readTurnContinuityCapture(browser);
  const baselineQueueItemIds = initialFrames.flatMap((frame) => frame.queue ?? [])
    .map((item) => item.queueItemId)
    .filter(Boolean);

  const messages = [input.firstMessage, input.secondMessage];
  let queuedTurn = null;
  let gateControl = null;
  let gateReleased = false;
  let gateEvidence = null;
  let outputs = [];
  let continuityFrames = [];
  try {
    await step("queue.second.submit-while-running", () =>
      queueComposerMessageWithEnter(browser, input.secondMessage, input.workspace));
    queuedTurn = await step("queue.second.identity-observed", () =>
      waitForNewCapturedQueueOwner(
        browser,
        baselineQueueItemIds,
        20_000,
        { requireOwner: input.eventStreamGate ? "server" : null },
      ));

    if (input.eventStreamGate) {
      gateControl = await step("queue.event-stream-gate.arm", () =>
        armWorkspaceEventStreamGate({
          dataDir: runtimeInfo.dataDir,
          workspaceIdentity: input.workspace,
        }));
      const armedAt = Number(gateControl.gate.armedAt);
      const serverTracePath = requiredTracePath(runtimeInfo, "server");
      const orchestratorTracePath = requiredTracePath(runtimeInfo, "orchestrator");

      await step("queue.event-stream-gate.ui-reconnecting", () =>
        waitForUiReconnectState(sendWorkflowTrace, {
          afterTs: armedAt,
          workspaceId: gateControl.workspaceId,
          nextStatus: "reconnecting",
        }));
      const blocked = await step("queue.event-stream-gate.reconnect-blocked", () =>
        waitForWorkflowTraceEvent({
          path: orchestratorTracePath,
          event: "orchestrator:e2e-event-stream-gate:reconnect-blocked",
          afterTs: armedAt,
          matches: (entry) => entry.workspaceId === gateControl.workspaceId && entry.gateId === gateControl.gate.gateId,
        }));
      const claimed = await step("queue.second.server-claimed", () =>
        waitForWorkflowTraceEvent({
          path: serverTracePath,
          event: "server:conversation-run:queue-drain-claimed",
          afterTs: armedAt,
          timeoutMs: 120_000,
          matches: (entry) =>
            entry.workspaceId === gateControl.workspaceId &&
            entry.queueItemId === queuedTurn.queueItemId,
        }));
      const admitted = await step("queue.second.server-admitted", () =>
        waitForWorkflowTraceEvent({
          path: serverTracePath,
          event: "server:conversation-run:admitted",
          afterTs: armedAt,
          timeoutMs: 30_000,
          matches: (entry) =>
            entry.workspaceId === gateControl.workspaceId &&
            entry.clientMessageId === queuedTurn.clientMessageId &&
            entry.origin === "session:queue-drain",
        }));
      const engineDuringGate = await readPooledWorkspaceEngine({
        baseUrl: gateControl.baseUrl,
        workspaceId: gateControl.workspaceId,
      });
      if (!sameEngineGeneration(gateControl.engineBefore, engineDuringGate)) {
        throw new Error("The pooled engine owner or generation changed while the app-facing event stream was gated.");
      }

      await step("queue.event-stream-gate.release", () =>
        releaseWorkspaceEventStreamGate({
          baseUrl: gateControl.baseUrl,
          workspaceId: gateControl.workspaceId,
          gateId: gateControl.gate.gateId,
        }));
      gateReleased = true;
      const resumed = await step("queue.event-stream-gate.connection-resumed", () =>
        waitForWorkflowTraceEvent({
          path: orchestratorTracePath,
          event: "orchestrator:e2e-event-stream-gate:connection-resumed",
          afterTs: armedAt,
          matches: (entry) => entry.workspaceId === gateControl.workspaceId && entry.gateId === gateControl.gate.gateId,
        }));
      await step("queue.event-stream-gate.ui-live", () =>
        waitForUiReconnectState(sendWorkflowTrace, {
          afterTs: armedAt,
          workspaceId: gateControl.workspaceId,
          nextStatus: "live",
        }));
      const engineAfterRelease = await readPooledWorkspaceEngine({
        baseUrl: gateControl.baseUrl,
        workspaceId: gateControl.workspaceId,
      });
      if (!sameEngineGeneration(gateControl.engineBefore, engineAfterRelease)) {
        throw new Error("The pooled engine owner or generation changed after releasing the app-facing event stream gate.");
      }
      gateEvidence = {
        gateId: gateControl.gate.gateId,
        workspaceId: gateControl.workspaceId,
        connectionId: gateControl.gate.connectionId,
        engineOwnerId: gateControl.gate.engineOwnerId,
        directoryInstanceEpoch: gateControl.gate.directoryInstanceEpoch,
        blockedReconnectAttempts: blocked.blockedReconnectAttempts,
        queueItemId: claimed.queueItemId,
        runId: admitted.runId,
        clientMessageId: admitted.clientMessageId,
        resumedConnectionId: resumed.connectionId,
        ownerAndGenerationPreserved: true,
      };
    }

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
    outputs = await step("queue.visible-outputs", () =>
      waitForVisibleAssistantOutputCount(browser, assistantBaseline, messages.length));
    await expectNoVisibleRuntimeError();
    await step("queue.no-terminal-assistant-error", () =>
      waitForNoVisibleAssistantError(browser, assistantErrorBaseline));
  } finally {
    if (gateControl && !gateReleased) {
      await releaseWorkspaceEventStreamGate({
        baseUrl: gateControl.baseUrl,
        workspaceId: gateControl.workspaceId,
        gateId: gateControl.gate.gateId,
      }).catch(() => {});
    }
    continuityFrames = await finishTurnContinuityCapture(browser).catch(() => []);
  }

  const uiTrace = await sendWorkflowTrace();
  const causalGap = gateControl
    ? findCausalGapTrace(uiTrace, {
        afterTs: Number(gateControl.gate.armedAt),
        workspaceId: gateControl.workspaceId,
      })
    : null;
  const continuitySummary = summarizeTurnContinuityFrames(
    continuityFrames,
    queuedTurn?.clientMessageId,
  );
  const visibleCausalGap = causalGap
    ? analyzeCausalGapFrames(continuityFrames, {
        ...causalGap,
        clientMessageId: queuedTurn?.clientMessageId,
      })
    : null;

  return {
    workspace: input.workspace,
    messageLengths: messages.map((message) => message.length),
    outputCount: outputs.length,
    queuedTurn: queuedTurn ? {
      owner: queuedTurn.owner,
      queueItemId: queuedTurn.queueItemId,
      clientMessageId: queuedTurn.clientMessageId,
      reservedRunId: queuedTurn.reservedRunId,
    } : null,
    gateEvidence,
    causalGap,
    continuitySummary,
    visibleCausalGap,
  };
}
