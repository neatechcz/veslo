import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createSessionConversationFlow,
  createIdleRunState,
  remapPendingQueueToSession,
  remapPendingRunStateToSession,
  remapQueuePausedToSession,
  resolveActiveUiConversationWorkspaceId,
  resolveCurrentSessionQueueKey,
  resolvePendingSessionHandoffScope,
  resolvePendingSessionHandoffFailureAction,
  resolvePendingSessionHandoffMaterialization,
  resolvePendingDraftWorkspaceId,
  resolvePendingSessionQueueKey,
  resolveTranscriptDisplaySessionId,
  removePendingSubmittedDraftById,
  resetRunStateRecord,
  resolveSessionIdForQueueKey,
  resolveSessionQueueKeyForSessionId,
  queueKeysShareWorkspace,
  markMatchingPendingSubmittedDraftFailed,
  resolveQueueDrainCompletionAction,
  resolveQueueDrainStart,
  restoreMaterializedQueueToPending,
  restoreQueuePausedToPending,
  resolveWorkspaceIdForQueueKey,
  resolveWorkspaceIdForSessionQueue,
  resolveSendPromptAction,
  shouldClearMaterializedSubmitDisplayHold,
  runUiStateEqual,
  updateRunStateRecord,
  type SessionQueueKeyContext,
  type RunUiState,
} from "../../pages/session-conversation-flow.js";
import type { PendingSubmittedDraft } from "../../components/session/pending-submit-model.js";
import type { PendingSubmittedDraftBySessionKey } from "../../components/session/pending-session-instance-model.js";
import type { QueuedDraft } from "../../components/session/session-queue-model.js";
import {
  createUiConversationKey,
  parseUiConversationKey,
} from "../../lib/ui-conversation-scope.js";
import {
  createMaterializedSessionHandoff,
  sessionSubmitAcceptedResult,
  sessionSubmitBlockedResult,
  sessionSubmitFailedResult,
  sessionSubmitQueuedResult,
  type SessionSubmitResult,
} from "../../lib/session-send-contract.js";

const sessionConversationFlowSource = readFileSync(
  new URL("../../pages/session-conversation-flow.ts", import.meta.url),
  "utf8",
);

const runState = (overrides: Partial<RunUiState> = {}): RunUiState => {
  const { baseline, ...stateOverrides } = overrides;
  return {
    startedAt: 10,
    hasBegun: false,
    tick: 11,
    lastProgressAt: 12,
    ...stateOverrides,
    baseline: {
      assistantId: "assistant-1",
      partCount: 3,
      ...baseline,
    },
  };
};

const queueContext = (overrides: Partial<SessionQueueKeyContext> = {}): SessionQueueKeyContext => ({
  activeWorkspaceId: "workspace-active",
  activeUiConversationRef: null,
  activePendingDraftKey: null,
  activePendingDraftMeta: null,
  ...overrides,
});

test("conversation flow trace sources use owner names instead of SessionView names", () => {
  assert.doesNotMatch(
    sessionConversationFlowSource,
    /markTempRuntimeUiRenderSource\(\s*"SessionView\./,
    "conversation flow should not report SessionView as the trace source owner",
  );
  assert.match(
    sessionConversationFlowSource,
    /"SessionConversationFlow\.sendPromptImmediate"/,
    "sendPromptImmediate should report the conversation flow owner",
  );
  assert.match(
    sessionConversationFlowSource,
    /"SessionConversationFlow\.handleMaterializedSessionId"/,
    "pending handoff materialization should report the conversation flow owner",
  );
  assert.match(
    sessionConversationFlowSource,
    /"SessionConversationFlow\.sendPromptImmediate:accepted"/,
    "accepted sends should report the conversation flow owner",
  );
});

const pendingSubmittedDraft = (
  overrides: Partial<PendingSubmittedDraft> = {},
): PendingSubmittedDraft => ({
  id: "submit-1",
  clientMessageId: "submit-1",
  sessionKey: "pending-session:created-1",
  sessionId: null,
  createdAt: 1,
  transcriptMessageIdsAtSubmit: [],
  draft: {
    mode: "prompt",
    parts: [],
    attachments: [],
    text: "hello",
    resolvedText: "hello",
  },
  state: "sending",
  ...overrides,
});

const draft = {
  mode: "prompt" as const,
  parts: [],
  attachments: [],
  text: "hello",
  resolvedText: "hello",
};

const acceptedSubmitResult = (): SessionSubmitResult => sessionSubmitAcceptedResult();

const blockedSubmitResult = (message = "send rejected"): SessionSubmitResult =>
  sessionSubmitBlockedResult({
    code: "test_rejected",
    message,
  });

test("conversation flow controller blocks before transport while preserving optimistic failure state", async () => {
  const mappings: Array<[string, string]> = [];
  const startedRuns: string[] = [];
  const resetRuns: string[] = [];
  const toasts: string[] = [];
  const transportCalls: string[] = [];
  let pendingDrafts: PendingSubmittedDraftBySessionKey = {};

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-1",
      createPendingSessionInstanceId: () => "pending-session:generated",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "pending:base",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => null,
      sessionIdForQueueKey: () => null,
      sessionQueueKeyForSessionId: (sessionId) => `session:${sessionId ?? ""}`,
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => "draft-1",
      aiAccessBlockedReason: () => "AI access blocked",
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: (baseKey, pendingKey) => {
        mappings.push([baseKey, pendingKey]);
      },
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: (sessionKey, submitted) => {
        pendingDrafts = { ...pendingDrafts, [sessionKey]: submitted };
      },
      updatePendingSubmittedDrafts: (updater) => {
        pendingDrafts = updater(pendingDrafts);
      },
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => [],
      queuedDraftsBySessionKey: () => ({}),
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: () => undefined,
      updateQueueForSessionKey: () => undefined,
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: () => undefined,
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "idle",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: (sessionKey) => {
        resetRuns.push(sessionKey);
      },
      showRunIndicator: () => false,
      startRun: (sessionKey) => {
        startedRuns.push(sessionKey);
      },
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => {
        transportCalls.push("replace");
        return acceptedSubmitResult();
      },
      sendPromptAsync: async () => {
        transportCalls.push("send");
        return acceptedSubmitResult();
      },
    },
    feedback: {
      setToastMessage: (message) => {
        toasts.push(message);
      },
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  const accepted = await controller.sendPromptImmediate(draft);

  assert.equal(accepted.accepted, false);
  assert.deepEqual(transportCalls, []);
  assert.deepEqual(mappings, [
    ["pending:base", "pending-session:generated"],
    ["pending:base", "pending-session:generated"],
  ]);
  assert.deepEqual(startedRuns, ["pending-session:generated"]);
  assert.deepEqual(resetRuns, ["pending-session:generated"]);
  assert.deepEqual(toasts, ["AI access blocked"]);
  assert.equal(pendingDrafts["pending-session:generated"]?.state, "error");
  assert.equal(pendingDrafts["pending-session:generated"]?.error, "AI access blocked");
});

test("conversation flow starts materialized first sends on the captured scoped session key", async () => {
  const mappings: Array<[string, string]> = [];
  const remaps: Array<{ pendingKey: string; sessionId: string; sessionKey: string | null | undefined }> = [];
  const startedRuns: string[] = [];
  let materializedSessionKeyCalls = 0;

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-materialized",
      createPendingSessionInstanceId: () => "pending-session:generated",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "pending:base",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => null,
      sessionIdForQueueKey: () => null,
      sessionQueueKeyForSessionId: (sessionId) => {
        if (sessionId === "sess-real") {
          materializedSessionKeyCalls += 1;
          return materializedSessionKeyCalls === 1
            ? "ws2:workspace-1:session:sess-real:/repo:/repo:conv-real:sess-real"
            : "ws2:workspace-1:session:sess-real:/repo:/repo::";
        }
        return `session:${sessionId ?? ""}`;
      },
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => "draft-1",
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/repo",
      remapPendingQueueToSession: (pendingKey, sessionId, sessionKey) => {
        remaps.push({ pendingKey, sessionId, sessionKey });
      },
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: (baseKey, pendingKey) => {
        mappings.push([baseKey, pendingKey]);
      },
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: () => undefined,
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => [],
      queuedDraftsBySessionKey: () => ({}),
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: () => undefined,
      updateQueueForSessionKey: () => undefined,
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: () => undefined,
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "idle",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => false,
      startRun: (sessionKey) => {
        startedRuns.push(sessionKey);
      },
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => {
        throw new Error("replacement should not run for a first send");
      },
      sendPromptAsync: async (_sentDraft, options) => {
        options.onMaterializedSessionId?.(createMaterializedSessionHandoff({
          workspaceId: "workspace-1",
          workspaceRoot: "/repo",
          directory: "/repo",
          pendingSessionKey: "pending-session:generated",
          sessionId: "sess-real",
          clientMessageId: options.clientMessageId,
          sendTraceId: options.sendTraceId ?? null,
          conversationId: "conv-real",
          opencodeSessionId: "sess-real",
        }));
        return acceptedSubmitResult();
      },
    },
    feedback: {
      setToastMessage: () => undefined,
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  const result = await controller.sendPromptImmediate(draft);

  const scopedSessionKey = "ws2:workspace-1:session:sess-real:%2Frepo:%2Frepo:conv-real:sess-real";
  assert.equal(result.accepted, true);
  assert.deepEqual(startedRuns, ["pending-session:generated", scopedSessionKey]);
  assert.deepEqual(remaps, [
    {
      pendingKey: "pending-session:generated",
      sessionId: "sess-real",
      sessionKey: scopedSessionKey,
    },
  ]);
  assert.equal(materializedSessionKeyCalls, 0);
  assert.equal(mappings.at(-1)?.[1], scopedSessionKey);
});

test("conversation flow controller submits running Enter to the server queue", async () => {
  const queueAppends: string[] = [];
  const sendCalls: Array<{
    text: string;
    origin: string;
    targetSessionId: string | null | undefined;
    clientMessageId: string;
  }> = [];

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-running-enter",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-a",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: (sessionKey) => (sessionKey === "session-a" ? "session-a" : null),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: () => undefined,
    },
    queue: {
      appendDraftToCurrentQueue: (queuedDraft) => {
        queueAppends.push(queuedDraft.text);
      },
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => [],
      queuedDraftsBySessionKey: () => ({}),
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: () => undefined,
      updateQueueForSessionKey: () => undefined,
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: () => undefined,
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "thinking",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => true,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => {
        throw new Error("replacement should not run for running Enter");
      },
      sendPromptAsync: async (sentDraft, options) => {
        sendCalls.push({
          text: sentDraft.text,
          origin: options.origin,
          targetSessionId: options.targetSessionId,
          clientMessageId: options.clientMessageId,
        });
        return sessionSubmitQueuedResult({
          queueItemId: "queue-running-enter",
          reservedRunId: "run-running-enter",
          queuePosition: 1,
          clientMessageId: options.clientMessageId,
        });
      },
    },
    feedback: {
      setToastMessage: () => undefined,
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  const result = await controller.handleSendPrompt(
    { ...draft, text: "queue me", resolvedText: "queue me" },
  );

  assert.deepEqual(queueAppends, []);
  assert.deepEqual(sendCalls, [
    {
      text: "queue me",
      origin: "session:queue-drain",
      targetSessionId: "session-a",
      clientMessageId: "submit-running-enter",
    },
  ]);
  assert.equal(result.accepted, true);
  assert.equal(result.status, "queued");
  assert.equal(result.queueItemId, "queue-running-enter");
  assert.equal(result.reservedRunId, "run-running-enter");
  assert.equal(result.clientMessageId, "submit-running-enter");
});

test("conversation flow controller preserves running Enter drafts when server queue admission is blocked", async () => {
  const queueAppends: string[] = [];
  const composerDrafts: string[] = [];
  const toasts: string[] = [];
  const sendOrigins: string[] = [];

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-running-enter-blocked",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-a",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: (sessionKey) => (sessionKey === "session-a" ? "session-a" : null),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: () => undefined,
    },
    queue: {
      appendDraftToCurrentQueue: (queuedDraft) => {
        queueAppends.push(queuedDraft.text);
      },
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => [],
      queuedDraftsBySessionKey: () => ({}),
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: () => undefined,
      updateQueueForSessionKey: () => undefined,
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: (nextDraft) => {
        composerDrafts.push(nextDraft.text);
      },
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "thinking",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => true,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => {
        throw new Error("replacement should not run for running Enter");
      },
      sendPromptAsync: async (_sentDraft, options) => {
        sendOrigins.push(options.origin);
        return sessionSubmitBlockedResult({
          code: "queue_admission_blocked",
          message: "Server queue is unavailable.",
          draftDisposition: "restore",
        });
      },
    },
    feedback: {
      setToastMessage: (message) => {
        toasts.push(message);
      },
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  const result = await controller.handleSendPrompt(
    { ...draft, text: "keep me", resolvedText: "keep me" },
  );

  assert.deepEqual(queueAppends, []);
  assert.deepEqual(sendOrigins, ["session:queue-drain"]);
  assert.equal(result.accepted, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "queue_admission_blocked");
  assert.equal(result.message, "Server queue is unavailable.");
  assert.equal(result.draftDisposition, "restore");
  assert.deepEqual(composerDrafts, []);
  assert.deepEqual(toasts, ["Server queue is unavailable."]);
});

test("conversation flow controller drains one queued draft per captured session lock", async () => {
  let queues: Record<string, QueuedDraft[]> = {
    "session-a": [
      { id: "queued-1", draft, createdAt: 1, updatedAt: 1, state: "queued" },
      { id: "queued-2", draft: { ...draft, text: "second" }, createdAt: 2, updatedAt: 2, state: "queued" },
    ],
  };
  const sends: Array<{ text: string; expectedSessionKey: string | null }> = [];
  const updates: Array<{ sessionKey: string; states: string[] }> = [];
  let sendReleaseArmed = false;
  let releaseSend: (accepted: SessionSubmitResult) => void = (_accepted) => {
    assert.fail("test transport should be waiting for the first queued send");
  };
  let pendingDrafts: PendingSubmittedDraftBySessionKey = {};

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-queue",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-a",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: (sessionKey) => (sessionKey.startsWith("pending") ? null : sessionKey),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: (sessionKey, submitted) => {
        pendingDrafts = { ...pendingDrafts, [sessionKey]: submitted };
      },
      updatePendingSubmittedDrafts: (updater) => {
        pendingDrafts = updater(pendingDrafts);
      },
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => queues["session-a"] ?? [],
      queuedDraftsBySessionKey: () => queues,
      resolveQueueKeyForQueuedDraft: (originalSessionKey, draftId) => {
        const entry = Object.entries(queues).find(([, queue]) =>
          queue.some((item) => item.id === draftId),
        );
        return entry?.[0] ?? originalSessionKey;
      },
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: (updater) => {
        queues = { ...queues, "session-a": updater(queues["session-a"] ?? []) };
      },
      updateQueueForSessionKey: (sessionKey, updater) => {
        queues = {
          ...queues,
          [sessionKey]: updater(queues[sessionKey] ?? []),
        };
        updates.push({
          sessionKey,
          states: (queues[sessionKey] ?? []).map((item) => `${item.id}:${item.state}`),
        });
      },
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: () => undefined,
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "idle",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => false,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => acceptedSubmitResult(),
      sendPromptAsync: async (sentDraft, options) => {
        sends.push({
          text: sentDraft.text,
          expectedSessionKey: options.targetSessionId ?? null,
        });
        return new Promise<SessionSubmitResult>((resolve) => {
          sendReleaseArmed = true;
          releaseSend = resolve;
        });
      },
    },
    feedback: {
      setToastMessage: () => undefined,
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  const firstDrain = controller.drainNextQueuedDraft("queue-drain", "session-a");
  await Promise.resolve();
  await controller.drainNextQueuedDraft("queue-drain", "session-a");

  assert.deepEqual(sends, [{ text: "hello", expectedSessionKey: "session-a" }]);
  assert.deepEqual(updates[0], {
    sessionKey: "session-a",
    states: ["queued-1:sending", "queued-2:queued"],
  });

  assert.equal(sendReleaseArmed, true, "test transport should be waiting for the first queued send");
  releaseSend(acceptedSubmitResult());
  await firstDrain;

  assert.deepEqual(
    queues["session-a"]?.map((item) => `${item.id}:${item.state}`),
    ["queued-2:queued"],
  );
  assert.deepEqual(Object.keys(pendingDrafts), []);
});

test("conversation flow controller surfaces terminal server queue failure on queued draft rows", async () => {
  const sessionAKey = createUiConversationKey({
    workspaceId: "workspace-1",
    kind: "session",
    id: "session-a",
  });
  let queues: Record<string, QueuedDraft[]> = {
    [sessionAKey]: [
      { id: "queued-1", draft, createdAt: 1, updatedAt: 1, state: "queued" },
    ],
  };
  const updates: Array<{ sessionKey: string; states: string[] }> = [];

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "msg-queued-failed",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => sessionAKey,
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: resolveSessionIdForQueueKey,
      sessionQueueKeyForSessionId: (sessionId) => sessionId ? sessionAKey : "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: () => undefined,
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => queues[sessionAKey] ?? [],
      queuedDraftsBySessionKey: () => queues,
      resolveQueueKeyForQueuedDraft: (originalSessionKey, draftId) => {
        const entry = Object.entries(queues).find(([, queue]) =>
          queue.some((item) => item.id === draftId),
        );
        return entry?.[0] ?? originalSessionKey;
      },
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: (updater) => {
        queues = { ...queues, [sessionAKey]: updater(queues[sessionAKey] ?? []) };
      },
      updateQueueForSessionKey: (sessionKey, updater) => {
        queues = {
          ...queues,
          [sessionKey]: updater(queues[sessionKey] ?? []),
        };
        updates.push({
          sessionKey,
          states: (queues[sessionKey] ?? []).map((item) => `${item.id}:${item.state}:${item.error ?? ""}`),
        });
      },
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: () => undefined,
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "idle",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => false,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => acceptedSubmitResult(),
      sendPromptAsync: async () =>
        sessionSubmitFailedResult({
          code: "queued_run_failed",
          message: "queued drain failed",
          queueItemId: "queue-1",
          reservedRunId: "run-1",
          clientMessageId: "msg-queued-failed",
          draftDisposition: "restore",
        }),
    },
    feedback: {
      setToastMessage: () => undefined,
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  await controller.drainNextQueuedDraft("queue-drain", sessionAKey);

  assert.deepEqual(updates[0], {
    sessionKey: sessionAKey,
    states: ["queued-1:sending:"],
  });
  assert.deepEqual(updates.at(-1), {
    sessionKey: sessionAKey,
    states: ["queued-1:error:queued drain failed"],
  });
});

test("conversation flow controller sends edited queued drafts now with remap-aware rejection", async () => {
  let queues: Record<string, QueuedDraft[]> = {
    "session-a": [
      { id: "queued-1", draft: { ...draft, text: "original" }, createdAt: 1, updatedAt: 1, state: "editing" },
    ],
  };
  const sentDrafts: string[] = [];
  const composerDrafts: string[] = [];
  const pauseWrites: Array<{ sessionKey: string; paused: boolean }> = [];
  const updates: Array<{ sessionKey: string; states: string[] }> = [];
  let pendingDrafts: PendingSubmittedDraftBySessionKey = {};

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-edited",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-a",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: (sessionKey) => (sessionKey.startsWith("pending") ? null : sessionKey),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => "send rejected",
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: (sessionKey, submitted) => {
        pendingDrafts = { ...pendingDrafts, [sessionKey]: submitted };
      },
      updatePendingSubmittedDrafts: (updater) => {
        pendingDrafts = updater(pendingDrafts);
      },
    },
    queue: {
      appendDraftToCurrentQueue: (queuedDraft) => {
        queues = {
          ...queues,
          "session-a": [
            ...(queues["session-a"] ?? []),
            { id: `queued-${queues["session-a"]?.length ?? 0}`, draft: queuedDraft, createdAt: 1, updatedAt: 1, state: "queued" },
          ],
        };
      },
      editingQueuedDraftId: () => "queued-1",
      queuePaused: () => true,
      queuePausedForSessionKey: () => true,
      queuedDrafts: () => queues["session-a"] ?? [],
      queuedDraftsBySessionKey: () => queues,
      resolveQueueKeyForQueuedDraft: (originalSessionKey, draftId) => {
        const entry = Object.entries(queues).find(([, queue]) =>
          queue.some((item) => item.id === draftId),
        );
        return entry?.[0] ?? originalSessionKey;
      },
      setEditingQueuedDraftId: (id) => {
        assert.equal(id, null);
      },
      setQueuePausedForSessionKey: (sessionKey, paused) => {
        pauseWrites.push({ sessionKey, paused });
      },
      updateCurrentQueue: (updater) => {
        queues = { ...queues, "session-a": updater(queues["session-a"] ?? []) };
      },
      updateQueueForSessionKey: (sessionKey, updater) => {
        queues = { ...queues, [sessionKey]: updater(queues[sessionKey] ?? []) };
        updates.push({
          sessionKey,
          states: (queues[sessionKey] ?? []).map((item) => `${item.id}:${item.state}:${item.error ?? ""}`),
        });
      },
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: (nextDraft) => {
        composerDrafts.push(nextDraft.text);
      },
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "idle",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => false,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => acceptedSubmitResult(),
      sendPromptAsync: async (sentDraft) => {
        sentDrafts.push(sentDraft.text);
        return blockedSubmitResult();
      },
    },
    feedback: {
      setToastMessage: () => undefined,
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  const accepted = await controller.handleSendPrompt(
    { ...draft, text: "edited", resolvedText: "edited" },
    { sendNow: true, sendTraceId: "trace-1" },
  );

  assert.equal(accepted.accepted, false);
  assert.deepEqual(sentDrafts, ["edited"]);
  assert.deepEqual(composerDrafts, [""]);
  assert.deepEqual(pauseWrites, []);
  assert.equal(pendingDrafts["session-a"]?.state, "error");
  assert.deepEqual(updates[0], {
    sessionKey: "session-a",
    states: ["queued-1:sending:"],
  });
  assert.deepEqual(updates.at(-1), {
    sessionKey: "session-a",
    states: ["queued-1:error:send rejected"],
  });
});

test("conversation flow controller owns queued draft edit actions", () => {
  let queues: Record<string, QueuedDraft[]> = {
    "session-a": [
      { id: "queued-1", draft: { ...draft, text: "first" }, createdAt: 1, updatedAt: 1, state: "queued" },
      { id: "queued-2", draft: { ...draft, text: "second" }, createdAt: 2, updatedAt: 2, state: "queued" },
    ],
  };
  let editingId: string | null = null;
  const composerDrafts: string[] = [];

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-edit-action",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-a",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: (sessionKey) => (sessionKey.startsWith("pending") ? null : sessionKey),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: () => undefined,
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => editingId,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => queues["session-a"] ?? [],
      queuedDraftsBySessionKey: () => queues,
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: (id) => {
        editingId = id;
      },
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: (updater) => {
        queues = { ...queues, "session-a": updater(queues["session-a"] ?? []) };
      },
      updateQueueForSessionKey: (sessionKey, updater) => {
        queues = { ...queues, [sessionKey]: updater(queues[sessionKey] ?? []) };
      },
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: (nextDraft) => {
        composerDrafts.push(nextDraft.text);
      },
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "idle",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => false,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => acceptedSubmitResult(),
      sendPromptAsync: async () => acceptedSubmitResult(),
    },
    feedback: {
      setToastMessage: () => undefined,
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  controller.handleMoveQueuedDraft("queued-2", 0);
  assert.deepEqual(
    queues["session-a"]?.map((item) => item.id),
    ["queued-2", "queued-1"],
  );

  editingId = "queued-1";
  queues = {
    ...queues,
    "session-a": (queues["session-a"] ?? []).map((item) =>
      item.id === "queued-1" ? { ...item, state: "editing" } : item,
    ),
  };

  assert.equal(controller.handleEditQueuedDraft("queued-2"), true);
  assert.equal(editingId, "queued-2");
  assert.deepEqual(
    queues["session-a"]?.map((item) => `${item.id}:${item.state}`),
    ["queued-2:editing", "queued-1:queued"],
  );
  assert.deepEqual(composerDrafts, ["second"]);

  assert.equal(controller.handleCancelQueuedDraft("queued-2"), true);
  assert.equal(editingId, null);
  assert.deepEqual(
    queues["session-a"]?.map((item) => `${item.id}:${item.state}`),
    ["queued-1:queued"],
  );
  assert.deepEqual(composerDrafts, ["second", ""]);
});

test("conversation flow controller owns transcript edit recovery", () => {
  let pendingDrafts: PendingSubmittedDraftBySessionKey = {
    "session-a": {
      id: "pending-message-1",
      clientMessageId: "pending-message-1",
      sessionKey: "session-a",
      sessionId: null,
      createdAt: 1,
      draft: { ...draft, text: "failed pending", resolvedText: "failed pending" },
      state: "error",
      error: "failed",
    },
  };
  let transcriptEditId: string | null = null;
  const composerDrafts: string[] = [];
  const editableTranscriptDraft = {
    messageId: "message-1",
    draft: { ...draft, text: "transcript edit", resolvedText: "transcript edit" },
  };

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-transcript-edit",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-a",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: (sessionKey) => (sessionKey.startsWith("pending") ? null : sessionKey),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => pendingDrafts["session-a"] ?? null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: (updater) => {
        pendingDrafts = updater(pendingDrafts);
      },
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => [],
      queuedDraftsBySessionKey: () => ({}),
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: () => undefined,
      updateQueueForSessionKey: () => undefined,
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: (nextDraft) => {
        composerDrafts.push(nextDraft.text);
      },
    },
    transcriptEdit: {
      editableUserMessage: () => editableTranscriptDraft,
      editingTranscriptMessageId: () => transcriptEditId,
      setEditingTranscriptMessageId: (id) => {
        transcriptEditId = id;
      },
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "idle",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => false,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => acceptedSubmitResult(),
      sendPromptAsync: async () => acceptedSubmitResult(),
    },
    feedback: {
      setToastMessage: () => undefined,
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  assert.equal(controller.handleEditUserMessage({ messageId: "pending-message-1", draft }), true);
  assert.deepEqual(Object.keys(pendingDrafts), []);
  assert.equal(transcriptEditId, null);
  assert.deepEqual(composerDrafts, ["failed pending"]);

  assert.equal(controller.handleEditUserMessage(editableTranscriptDraft), true);
  assert.equal(transcriptEditId, "message-1");
  assert.deepEqual(composerDrafts, ["failed pending", "transcript edit"]);

  assert.equal(controller.handleEditUserMessage({ messageId: "unknown", draft }), false);
  assert.deepEqual(composerDrafts, ["failed pending", "transcript edit"]);
});

test("conversation flow controller surfaces typed replacement server failures", async () => {
  const toasts: string[] = [];
  const replaceCalls: string[] = [];
  let transcriptEditId: string | null = "message-1";

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "client-replace-failed",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-a",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: (sessionKey) => (sessionKey.startsWith("pending") ? null : sessionKey),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 1,
      messageIds: () => ["message-1"],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: () => undefined,
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => [],
      queuedDraftsBySessionKey: () => ({}),
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: () => undefined,
      updateQueueForSessionKey: () => undefined,
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: () => undefined,
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => transcriptEditId,
      setEditingTranscriptMessageId: (id) => {
        transcriptEditId = id;
      },
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "idle",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => false,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async (messageId) => {
        replaceCalls.push(messageId);
        return sessionSubmitBlockedResult({
          code: "replacement_state_unavailable",
          message: "Replacement state is unavailable.",
          draftDisposition: "restore",
        });
      },
      sendPromptAsync: async () => {
        throw new Error("normal send should not run for replacement failure");
      },
    },
    feedback: {
      setToastMessage: (message) => {
        toasts.push(message);
      },
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  const result = await controller.handleSendPrompt(draft, {
    sendTraceId: "trace-1",
    source: "test",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "replacement_state_unavailable");
  assert.equal(result.message, "Replacement state is unavailable.");
  assert.equal(result.draftDisposition, "restore");
  assert.deepEqual(replaceCalls, ["message-1"]);
  assert.deepEqual(toasts, ["Replacement state is unavailable."]);
  assert.equal(transcriptEditId, null);
});

test("conversation flow controller pauses queues before cancelling active runs", async () => {
  let abortBusy = false;
  const events: string[] = [];
  const toasts: string[] = [];

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-cancel",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-a",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: (sessionKey) => (sessionKey.startsWith("pending") ? null : sessionKey),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: () => undefined,
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => [],
      queuedDraftsBySessionKey: () => ({}),
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: (sessionKey, paused) => {
        events.push(`pause:${sessionKey}:${paused}`);
      },
      updateCurrentQueue: () => undefined,
      updateQueueForSessionKey: () => undefined,
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: () => undefined,
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => abortBusy,
      abortSession: async (sessionId) => {
        events.push(`abort:${sessionId ?? ""}`);
      },
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "sending",
      setAbortBusy: (busy) => {
        abortBusy = busy;
        events.push(`busy:${busy}`);
      },
      setEscapeStopConfirmationPending: (pending) => {
        events.push(`escape:${pending}`);
      },
    },
    runState: {
      resetRunState: (sessionKey) => {
        events.push(`reset:${sessionKey}`);
      },
      showRunIndicator: () => true,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => acceptedSubmitResult(),
      sendPromptAsync: async () => acceptedSubmitResult(),
    },
    feedback: {
      setToastMessage: (message) => {
        toasts.push(message);
      },
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  await controller.cancelRun();

  assert.deepEqual(events, [
    "escape:false",
    "pause:session-a:true",
    "busy:true",
    "abort:session-a",
    "busy:false",
  ]);
  assert.deepEqual(toasts, ["session.stopping_run", "session.run_stopped"]);
});

test("conversation flow controller aborts backend-active error runs", async () => {
  let abortBusy = false;
  const events: string[] = [];
  const toasts: string[] = [];

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-cancel-blocked",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-a",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: (sessionKey) => (sessionKey.startsWith("pending") ? null : sessionKey),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: () => undefined,
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => [],
      queuedDraftsBySessionKey: () => ({}),
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: (sessionKey, paused) => {
        events.push(`pause:${sessionKey}:${paused}`);
      },
      updateCurrentQueue: () => undefined,
      updateQueueForSessionKey: () => undefined,
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: () => undefined,
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => abortBusy,
      abortSession: async (sessionId) => {
        events.push(`abort:${sessionId ?? ""}`);
      },
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "error",
      hasAbortableBackendRun: () => true,
      setAbortBusy: (busy) => {
        abortBusy = busy;
        events.push(`busy:${busy}`);
      },
      setEscapeStopConfirmationPending: (pending) => {
        events.push(`escape:${pending}`);
      },
    },
    runState: {
      resetRunState: (sessionKey) => {
        events.push(`reset:${sessionKey}`);
      },
      showRunIndicator: () => true,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => acceptedSubmitResult(),
      sendPromptAsync: async () => acceptedSubmitResult(),
    },
    feedback: {
      setToastMessage: (message) => {
        toasts.push(message);
      },
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  await controller.cancelRun();

  assert.deepEqual(events, [
    "escape:false",
    "pause:session-a:true",
    "busy:true",
    "abort:session-a",
    "busy:false",
  ]);
  assert.deepEqual(toasts, ["session.stopping_run", "session.run_stopped"]);
});

test("conversation flow controller retries after best-effort abort failure", async () => {
  let abortBusy = false;
  const events: string[] = [];
  const toasts: string[] = [];

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-retry",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-a",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-a",
      sessionIdForQueueKey: (sessionKey) => (sessionKey.startsWith("pending") ? null : sessionKey),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: () => undefined,
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => null,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => [],
      queuedDraftsBySessionKey: () => ({}),
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: () => undefined,
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: () => undefined,
      updateQueueForSessionKey: () => undefined,
    },
    composer: {
      clearComposerDraftForSession: () => undefined,
      currentDraftMode: () => "prompt",
      setComposerDraft: () => undefined,
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => null,
      setEditingTranscriptMessageId: () => undefined,
    },
    runControl: {
      abortBusy: () => abortBusy,
      abortSession: async (sessionId) => {
        events.push(`abort:${sessionId ?? ""}`);
        throw new Error("abort failed");
      },
      lastPromptSent: () => "retry me",
      retryLastPrompt: () => {
        events.push("retry");
      },
      runPhase: () => "thinking",
      setAbortBusy: (busy) => {
        abortBusy = busy;
        events.push(`busy:${busy}`);
      },
      setEscapeStopConfirmationPending: (pending) => {
        events.push(`escape:${pending}`);
      },
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => true,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => acceptedSubmitResult(),
      sendPromptAsync: async () => acceptedSubmitResult(),
    },
    feedback: {
      setToastMessage: (message) => {
        toasts.push(message);
      },
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  await controller.retryRun();

  assert.deepEqual(events, [
    "escape:false",
    "busy:true",
    "abort:session-a",
    "busy:false",
    "retry",
  ]);
  assert.deepEqual(toasts, ["session.trying_again"]);
});

test("conversation flow controller restores edit state when sessions switch", () => {
  let queues: Record<string, QueuedDraft[]> = {
    "session-old": [
      { id: "queued-1", draft: { ...draft, text: "editing" }, createdAt: 1, updatedAt: 1, state: "editing" },
    ],
  };
  let editingQueuedDraftId: string | null = "queued-1";
  let editingTranscriptMessageId: string | null = "message-1";
  const clearedComposerSessions: Array<string | null | undefined> = [];

  const controller = createSessionConversationFlow({
    identity: {
      createClientMessageId: () => "submit-session-switch",
      createPendingSessionInstanceId: () => "pending-session:unused",
      now: () => 123,
    },
    sessionKeys: {
      activeUiConversationWorkspaceId: () => "workspace-1",
      activeWorkspaceId: () => "workspace-1",
      currentSessionQueueKey: () => "session-new",
      pendingSessionQueueKey: () => "pending:base",
      selectedSessionId: () => "session-new",
      sessionIdForQueueKey: (sessionKey) => (sessionKey.startsWith("pending") ? null : sessionKey),
      sessionQueueKeyForSessionId: (sessionId) => sessionId ?? "pending:base",
      workspaceIdForQueueKey: () => "workspace-1",
    },
    runtime: {
      activePendingDraftKey: () => null,
      aiAccessBlockedReason: () => null,
      busyHint: () => null,
      busyLabel: () => null,
      error: () => null,
    },
    transcript: {
      messageCount: () => 0,
      messageIds: () => [],
    },
    pendingHandoff: {
      clearPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
      createPendingSidebarSessionWorkspaceId: () => "workspace-1",
      createPendingSidebarSessionWorkspaceRoot: () => "/workspace",
      remapPendingQueueToSession: () => undefined,
      restoreMaterializedQueueToPending: () => undefined,
      setPendingQueueKeyAwaitingSessionIdForBaseKey: () => undefined,
    },
    pendingSubmitted: {
      optimisticSubmittedDraft: () => null,
      setOptimisticSubmittedDraft: () => undefined,
      updatePendingSubmittedDrafts: () => undefined,
    },
    queue: {
      appendDraftToCurrentQueue: () => undefined,
      editingQueuedDraftId: () => editingQueuedDraftId,
      queuePaused: () => false,
      queuePausedForSessionKey: () => false,
      queuedDrafts: () => [],
      queuedDraftsBySessionKey: () => queues,
      resolveQueueKeyForQueuedDraft: (sessionKey) => sessionKey,
      setEditingQueuedDraftId: (id) => {
        editingQueuedDraftId = id;
      },
      setQueuePausedForSessionKey: () => undefined,
      updateCurrentQueue: () => undefined,
      updateQueueForSessionKey: (sessionKey, updater) => {
        queues = { ...queues, [sessionKey]: updater(queues[sessionKey] ?? []) };
      },
    },
    composer: {
      clearComposerDraftForSession: (sessionId) => {
        clearedComposerSessions.push(sessionId);
      },
      currentDraftMode: () => "prompt",
      setComposerDraft: () => undefined,
    },
    transcriptEdit: {
      editableUserMessage: () => null,
      editingTranscriptMessageId: () => editingTranscriptMessageId,
      setEditingTranscriptMessageId: (id) => {
        editingTranscriptMessageId = id;
      },
    },
    runControl: {
      abortBusy: () => false,
      abortSession: async () => undefined,
      lastPromptSent: () => "",
      retryLastPrompt: () => undefined,
      runPhase: () => "idle",
      setAbortBusy: () => undefined,
      setEscapeStopConfirmationPending: () => undefined,
    },
    runState: {
      resetRunState: () => undefined,
      showRunIndicator: () => false,
      startRun: () => undefined,
    },
    viewport: {
      scheduleScrollToLatest: () => undefined,
      setStickToBottom: () => undefined,
    },
    transport: {
      replaceUserMessageAsync: async () => acceptedSubmitResult(),
      sendPromptAsync: async () => acceptedSubmitResult(),
    },
    feedback: {
      setToastMessage: () => undefined,
      tr: (key) => key,
    },
    trace: {
      markTempRuntimeUiRenderSource: () => undefined,
      recordSendTrace: () => undefined,
      reportError: () => undefined,
    },
    effects: {
      batch: (fn) => fn(),
    },
  });

  controller.handleSessionSwitchEditState("session-old");

  assert.equal(queues["session-old"]?.[0]?.state, "queued");
  assert.equal(editingQueuedDraftId, null);
  assert.equal(editingTranscriptMessageId, null);
  assert.deepEqual(clearedComposerSessions, ["session-old"]);
});

test("session queue workspace scope prefers the visible conversation ref", () => {
  const context = queueContext({
    activeWorkspaceId: "workspace-active",
    activeUiConversationRef: {
      workspaceId: " workspace-visible ",
      sessionId: "session-1",
      conversationId: "conversation-1",
      opencodeSessionId: "opencode-1",
    },
  });

  assert.equal(resolveActiveUiConversationWorkspaceId(context), "workspace-visible");
  assert.equal(resolveWorkspaceIdForSessionQueue(context, "conversation-1"), "workspace-visible");
  assert.equal(resolveWorkspaceIdForSessionQueue(context, "opencode-1"), "workspace-visible");
  assert.equal(resolveWorkspaceIdForSessionQueue(context, "session-other"), "workspace-active");
  assert.equal(resolveActiveUiConversationWorkspaceId(queueContext({ activeWorkspaceId: "" })), "default");
});

test("pending draft queue keys are scoped by pending draft workspace", () => {
  const privateContext = queueContext({
    activeWorkspaceId: "workspace-active",
    activePendingDraftKey: " pending-draft-1 ",
    activePendingDraftMeta: {
      kind: "new-private",
      workspaceId: "workspace-source",
      privateWorkspaceId: " workspace-private ",
    },
  });
  const directoryContext = queueContext({
    activePendingDraftKey: "pending-draft-2",
    activePendingDraftMeta: {
      kind: "directory",
      workspaceId: " workspace-directory ",
      privateWorkspaceId: null,
    },
  });

  assert.equal(resolvePendingDraftWorkspaceId(privateContext), "workspace-private");
  assert.equal(parseUiConversationKey(resolvePendingSessionQueueKey(privateContext))?.workspaceId, "workspace-private");
  assert.equal(parseUiConversationKey(resolvePendingSessionQueueKey(privateContext))?.kind, "pending-draft");
  assert.equal(parseUiConversationKey(resolvePendingSessionQueueKey(privateContext))?.id, "pending-draft-1");
  assert.equal(resolvePendingDraftWorkspaceId(directoryContext), "workspace-directory");
  assert.deepEqual(parseUiConversationKey(resolvePendingSessionQueueKey(queueContext())), {
    workspaceId: "workspace-active",
    kind: "pending-workspace",
    id: "active",
  });
});

test("session queue keys distinguish real scoped sessions from pending identities", () => {
  const context = queueContext({
    activeWorkspaceId: "workspace-active",
    activePendingDraftMeta: {
      kind: "directory",
      workspaceId: "workspace-pending",
      privateWorkspaceId: null,
    },
    activeUiConversationRef: {
      workspaceId: "workspace-visible",
      sessionId: "session-1",
      conversationId: "conversation-1",
      opencodeSessionId: "opencode-1",
    },
  });

  assert.deepEqual(parseUiConversationKey(resolveSessionQueueKeyForSessionId(context, "conversation-1")), {
    workspaceId: "workspace-visible",
    workspaceRoot: "",
    directory: "",
    conversationId: "conversation-1",
    opencodeSessionId: "opencode-1",
    kind: "session",
    id: "conversation-1",
  });
  assert.deepEqual(parseUiConversationKey(resolveSessionQueueKeyForSessionId(context, "pending:legacy")), {
    workspaceId: "workspace-pending",
    kind: "pending-session",
    id: "pending:legacy",
  });
  assert.equal(resolveSessionQueueKeyForSessionId(context, null), resolvePendingSessionQueueKey(context));
});

test("session queue keys preserve already-scoped pending identities", () => {
  const scopedPendingKey = createUiConversationKey({
    workspaceId: "workspace-pending",
    kind: "pending-session",
    id: "pending-session:created-1",
  });
  const context = queueContext({ activeWorkspaceId: "workspace-active" });

  assert.equal(resolveSessionQueueKeyForSessionId(context, scopedPendingKey), scopedPendingKey);
  assert.equal(resolveSessionIdForQueueKey(scopedPendingKey), null);
  assert.equal(resolveWorkspaceIdForQueueKey(context, scopedPendingKey), "workspace-pending");
});

test("session queue keys distinguish same session id in different directories", () => {
  const left = resolveSessionQueueKeyForSessionId(
    queueContext({
      activeUiConversationRef: {
        workspaceId: "workspace-visible",
        workspaceRoot: "/repo",
        directory: "/repo/packages/a",
        sessionId: "same-session",
        conversationId: "conv-a",
        opencodeSessionId: "same-session",
      } as any,
    }),
    "same-session",
  );
  const right = resolveSessionQueueKeyForSessionId(
    queueContext({
      activeUiConversationRef: {
        workspaceId: "workspace-visible",
        workspaceRoot: "/repo",
        directory: "/repo/packages/b",
        sessionId: "same-session",
        conversationId: "conv-b",
        opencodeSessionId: "same-session",
      } as any,
    }),
    "same-session",
  );

  assert.notEqual(left, right);
  assert.deepEqual(parseUiConversationKey(left), {
    workspaceId: "workspace-visible",
    workspaceRoot: "/repo",
    directory: "/repo/packages/a",
    conversationId: "conv-a",
    opencodeSessionId: "same-session",
    kind: "session",
    id: "same-session",
  });
});

test("queue key parsing preserves scoped and legacy session identities", () => {
  const realKey = createUiConversationKey({
    workspaceId: "workspace-real",
    kind: "session",
    id: "session-1",
  });
  const pendingKey = createUiConversationKey({
    workspaceId: "workspace-real",
    kind: "pending-draft",
    id: "draft-1",
  });
  const context = queueContext({ activeWorkspaceId: "workspace-active" });

  assert.equal(resolveSessionIdForQueueKey(realKey), "session-1");
  assert.equal(resolveSessionIdForQueueKey(pendingKey), null);
  assert.equal(resolveSessionIdForQueueKey("pending-workspace:active"), null);
  assert.equal(resolveSessionIdForQueueKey("legacy-session-id"), "legacy-session-id");
  assert.equal(resolveWorkspaceIdForQueueKey(context, realKey), "workspace-real");
  assert.equal(resolveWorkspaceIdForQueueKey(context, "legacy-session-id"), "workspace-active");
});

test("pending queue remap scope rejects cross-workspace keys", () => {
  const pendingKey = createUiConversationKey({
    workspaceId: "workspace-pending",
    kind: "pending-session",
    id: "pending-session:created-1",
  });
  const realSameWorkspace = createUiConversationKey({
    workspaceId: "workspace-pending",
    kind: "session",
    id: "session-real",
  });
  const realOtherWorkspace = createUiConversationKey({
    workspaceId: "workspace-other",
    kind: "session",
    id: "session-real",
  });

  const resolveWorkspaceId = (sessionKey: string) =>
    resolveWorkspaceIdForQueueKey({ activeWorkspaceId: "workspace-active" }, sessionKey);

  assert.equal(queueKeysShareWorkspace(resolveWorkspaceId, pendingKey, realSameWorkspace), true);
  assert.equal(queueKeysShareWorkspace(resolveWorkspaceId, pendingKey, realOtherWorkspace), false);
});

test("current session queue key selects a captured pending handoff for its own base key", () => {
  const context = queueContext({
    activePendingDraftKey: "draft-1",
    activePendingDraftMeta: {
      kind: "directory",
      workspaceId: "workspace-pending",
      privateWorkspaceId: null,
    },
  });
  const basePendingKey = resolvePendingSessionQueueKey(context);
  const pendingInstanceKey = resolveSessionQueueKeyForSessionId(context, "pending-session:instance-1");

  assert.equal(
    resolveCurrentSessionQueueKey({
      ...context,
      selectedSessionId: null,
      pendingQueueKeyAwaitingSessionIdByBaseKey: {
        [basePendingKey]: pendingInstanceKey,
        unrelated: "pending-session:unrelated",
      },
    }),
    pendingInstanceKey,
  );
  assert.equal(
    resolveCurrentSessionQueueKey({
      ...context,
      selectedSessionId: "session-real",
      pendingQueueKeyAwaitingSessionIdByBaseKey: {
        [basePendingKey]: pendingInstanceKey,
      },
    }),
    resolveSessionQueueKeyForSessionId(context, "session-real"),
  );
});

test("transcript display session id holds pending materialization until server transcript arrives", () => {
  assert.equal(
    resolveTranscriptDisplaySessionId({
      selectedSessionId: "session-real",
      heldMaterializedSessionId: "session-real",
      hasSendingOptimisticSubmit: true,
      transcriptMessageCount: 0,
    }),
    null,
  );

  assert.equal(
    resolveTranscriptDisplaySessionId({
      selectedSessionId: "session-real",
      heldMaterializedSessionId: "session-real",
      hasSendingOptimisticSubmit: true,
      transcriptMessageCount: 1,
    }),
    "session-real",
  );

  assert.equal(
    resolveTranscriptDisplaySessionId({
      selectedSessionId: "session-real",
      heldMaterializedSessionId: null,
      hasSendingOptimisticSubmit: true,
      transcriptMessageCount: 0,
    }),
    "session-real",
  );
});

test("materialized submit display hold clears on real transcript, session change, or completed optimistic state", () => {
  assert.equal(
    shouldClearMaterializedSubmitDisplayHold({
      selectedSessionId: "session-real",
      heldMaterializedSessionId: "session-real",
      hasSendingOptimisticSubmit: true,
      transcriptMessageCount: 0,
    }),
    false,
  );

  assert.equal(
    shouldClearMaterializedSubmitDisplayHold({
      selectedSessionId: "session-real",
      heldMaterializedSessionId: "session-real",
      hasSendingOptimisticSubmit: true,
      transcriptMessageCount: 1,
    }),
    true,
  );

  assert.equal(
    shouldClearMaterializedSubmitDisplayHold({
      selectedSessionId: "session-other",
      heldMaterializedSessionId: "session-real",
      hasSendingOptimisticSubmit: true,
      transcriptMessageCount: 0,
    }),
    true,
  );

  assert.equal(
    shouldClearMaterializedSubmitDisplayHold({
      selectedSessionId: "session-real",
      heldMaterializedSessionId: "session-real",
      hasSendingOptimisticSubmit: false,
      transcriptMessageCount: 0,
    }),
    true,
  );
});

test("pending handoff scope creates a unique instance for first sends without a real target", () => {
  const context = queueContext({
    activePendingDraftKey: "draft-1",
    activePendingDraftMeta: {
      kind: "directory",
      workspaceId: "workspace-pending",
      privateWorkspaceId: null,
    },
  });
  const baseSessionKey = resolvePendingSessionQueueKey(context);
  const createdIds: string[] = [];

  const scope = resolvePendingSessionHandoffScope({
    baseSessionKey,
    targetSessionId: null,
    pendingSessionQueueKey: baseSessionKey,
    createPendingSessionInstanceId: () => {
      createdIds.push("called");
      return "pending-session:created-1";
    },
  });

  assert.deepEqual(createdIds, ["called"]);
  const expectedPendingInstanceKey = createUiConversationKey({
    workspaceId: "workspace-pending",
    kind: "pending-session",
    id: "pending-session:created-1",
  });

  assert.deepEqual(scope, {
    pendingSessionBaseKeyBeforeHandoff: baseSessionKey,
    pendingInstanceKey: expectedPendingInstanceKey,
    sessionKey: expectedPendingInstanceKey,
    pendingSessionKeyBeforeHandoff: expectedPendingInstanceKey,
  });
});

test("pending handoff scope reuses an existing pending instance without creating another", () => {
  const basePendingKey = resolvePendingSessionQueueKey(queueContext());
  const scope = resolvePendingSessionHandoffScope({
    baseSessionKey: "pending-session:existing-1",
    targetSessionId: null,
    pendingSessionQueueKey: basePendingKey,
    createPendingSessionInstanceId: () => {
      throw new Error("should not create another pending instance");
    },
  });

  assert.deepEqual(scope, {
    pendingSessionBaseKeyBeforeHandoff: basePendingKey,
    pendingInstanceKey: null,
    sessionKey: "pending-session:existing-1",
    pendingSessionKeyBeforeHandoff: "pending-session:existing-1",
  });
});

test("pending handoff scope leaves real session sends on their captured session key", () => {
  const realKey = createUiConversationKey({
    workspaceId: "workspace-real",
    kind: "session",
    id: "session-1",
  });
  const scope = resolvePendingSessionHandoffScope({
    baseSessionKey: realKey,
    targetSessionId: "session-1",
    pendingSessionQueueKey: resolvePendingSessionQueueKey(queueContext()),
    createPendingSessionInstanceId: () => {
      throw new Error("real session sends should not allocate pending instances");
    },
  });

  assert.deepEqual(scope, {
    pendingSessionBaseKeyBeforeHandoff: null,
    pendingInstanceKey: null,
    sessionKey: realKey,
    pendingSessionKeyBeforeHandoff: null,
  });
});

test("pending handoff failure action keeps optimistic pending sends selected without a real session", () => {
  assert.deepEqual(
    resolvePendingSessionHandoffFailureAction({
      pendingSessionBaseKeyBeforeHandoff: "pending:base",
      pendingSessionKeyBeforeHandoff: "pending-session:created-1",
      materializedSessionIdFromHandoff: null,
      showOptimisticSubmit: true,
      selectedSessionId: null,
    }),
    {
      kind: "keep-pending-instance",
      pendingSessionBaseKey: "pending:base",
      pendingSessionKey: "pending-session:created-1",
    },
  );
});

test("pending handoff failure action clears mappings after materialization or navigation", () => {
  assert.deepEqual(
    resolvePendingSessionHandoffFailureAction({
      pendingSessionBaseKeyBeforeHandoff: "pending:base",
      pendingSessionKeyBeforeHandoff: "pending-session:created-1",
      materializedSessionIdFromHandoff: "session-real",
      showOptimisticSubmit: true,
      selectedSessionId: null,
    }),
    {
      kind: "clear-base-mapping",
      pendingSessionBaseKey: "pending:base",
      pendingSessionKey: null,
    },
  );

  assert.deepEqual(
    resolvePendingSessionHandoffFailureAction({
      pendingSessionBaseKeyBeforeHandoff: "pending:base",
      pendingSessionKeyBeforeHandoff: "pending-session:created-1",
      materializedSessionIdFromHandoff: null,
      showOptimisticSubmit: true,
      selectedSessionId: "session-other",
    }),
    {
      kind: "clear-matching-pending-instance",
      pendingSessionBaseKey: "pending:base",
      pendingSessionKey: "pending-session:created-1",
    },
  );
});

test("pending handoff failure action skips when no pending handoff was captured", () => {
  assert.deepEqual(
    resolvePendingSessionHandoffFailureAction({
      pendingSessionBaseKeyBeforeHandoff: null,
      pendingSessionKeyBeforeHandoff: "pending-session:created-1",
      materializedSessionIdFromHandoff: null,
      showOptimisticSubmit: true,
      selectedSessionId: null,
    }),
    { kind: "none" },
  );
});

test("pending handoff materialization accepts the captured pending key and client message", () => {
  assert.deepEqual(
    resolvePendingSessionHandoffMaterialization({
      pendingSessionBaseKeyBeforeHandoff: "pending:base",
      pendingSessionKeyBeforeHandoff: "pending-session:created-1",
      clientMessageId: "client-1",
      handoff: {
        pendingSessionKey: " pending-session:created-1 ",
        clientMessageId: " client-1 ",
        sessionId: " session-real ",
      },
    }),
    {
      kind: "materialize",
      pendingSessionBaseKey: "pending:base",
      pendingSessionKey: "pending-session:created-1",
      materializedPendingKey: "pending-session:created-1",
      materializedSessionId: "session-real",
    },
  );
});

test("pending handoff materialization falls back to the captured pending key when callback omits it", () => {
  assert.deepEqual(
    resolvePendingSessionHandoffMaterialization({
      pendingSessionBaseKeyBeforeHandoff: "pending:base",
      pendingSessionKeyBeforeHandoff: "pending-session:created-1",
      clientMessageId: "client-1",
      handoff: {
        sessionId: "session-real",
      },
    }),
    {
      kind: "materialize",
      pendingSessionBaseKey: "pending:base",
      pendingSessionKey: "pending-session:created-1",
      materializedPendingKey: "pending-session:created-1",
      materializedSessionId: "session-real",
    },
  );
});

test("pending handoff materialization rejects stale pending keys and client messages", () => {
  const base = {
    pendingSessionBaseKeyBeforeHandoff: "pending:base",
    pendingSessionKeyBeforeHandoff: "pending-session:created-1",
    clientMessageId: "client-1",
  };

  assert.deepEqual(
    resolvePendingSessionHandoffMaterialization({
      ...base,
      handoff: {
        pendingSessionKey: "pending-session:other",
        clientMessageId: "client-1",
        sessionId: "session-real",
      },
    }),
    { kind: "skip", reason: "pending-key-mismatch" },
  );
  assert.deepEqual(
    resolvePendingSessionHandoffMaterialization({
      ...base,
      handoff: {
        pendingSessionKey: "pending-session:created-1",
        clientMessageId: "client-other",
        sessionId: "session-real",
      },
    }),
    { kind: "skip", reason: "client-message-mismatch" },
  );
});

test("pending handoff materialization requires a real materialized session id", () => {
  const base = {
    pendingSessionBaseKeyBeforeHandoff: "pending:base",
    pendingSessionKeyBeforeHandoff: "pending-session:created-1",
    clientMessageId: "client-1",
  };

  assert.deepEqual(
    resolvePendingSessionHandoffMaterialization({ ...base, handoff: null }),
    { kind: "skip", reason: "missing-session-id" },
  );
  assert.deepEqual(
    resolvePendingSessionHandoffMaterialization({
      ...base,
      handoff: {
        pendingSessionKey: "pending-session:created-1",
        clientMessageId: "client-1",
        sessionId: "pending-session:not-real",
      },
    }),
    { kind: "skip", reason: "pending-session-id" },
  );
  assert.deepEqual(
    resolvePendingSessionHandoffMaterialization({
      pendingSessionBaseKeyBeforeHandoff: null,
      pendingSessionKeyBeforeHandoff: "pending-session:created-1",
      clientMessageId: "client-1",
      handoff: { sessionId: "session-real" },
    }),
    { kind: "skip", reason: "no-pending-handoff" },
  );
});

test("pending submitted cleanup removes the matching submit id wherever it was remapped", () => {
  const matching = pendingSubmittedDraft({
    id: "submit-1",
    sessionKey: "session:real",
    sessionId: "real",
  });
  const unrelated = pendingSubmittedDraft({
    id: "submit-2",
    clientMessageId: "submit-2",
    sessionKey: "pending:other",
  });
  const current = {
    "session:real": matching,
    "pending:other": unrelated,
  };

  const next = removePendingSubmittedDraftById(current, "submit-1");

  assert.deepEqual(next, { "pending:other": unrelated });
  assert.equal(removePendingSubmittedDraftById(current, "missing"), current);
});

test("pending submitted failure marks materialized drafts in place and reports the real reset key", () => {
  const materialized = pendingSubmittedDraft({
    id: "submit-1",
    sessionKey: "session:real",
    sessionId: "real",
  });
  const current = {
    "session:real": materialized,
  };

  const result = markMatchingPendingSubmittedDraftFailed({
    draftsBySessionKey: current,
    sessionKey: "pending-session:created-1",
    pendingSubmitId: "submit-1",
    pendingSessionKeyBeforeHandoff: "pending-session:created-1",
    materializedSessionIdFromHandoff: null,
    errorMessage: "failed",
  });

  assert.equal(result.materializedSessionIdToRestore, "real");
  assert.equal(result.materializedSessionIdForRunStateReset, "real");
  assert.equal(result.draftsBySessionKey["session:real"]?.state, "error");
  assert.equal(result.draftsBySessionKey["session:real"]?.error, "failed");
  assert.equal(result.draftsBySessionKey["session:real"]?.sessionKey, "session:real");
});

test("pending submitted failure restores non-materialized drafts to the captured pending key", () => {
  const current = {
    "session:remapped": pendingSubmittedDraft({
      id: "submit-1",
      sessionKey: "session:remapped",
      sessionId: null,
    }),
  };

  const result = markMatchingPendingSubmittedDraftFailed({
    draftsBySessionKey: current,
    sessionKey: "pending-session:created-1",
    pendingSubmitId: "submit-1",
    pendingSessionKeyBeforeHandoff: "pending-session:created-1",
    materializedSessionIdFromHandoff: "real-from-callback",
    errorMessage: "failed",
  });

  assert.equal(result.materializedSessionIdToRestore, "real-from-callback");
  assert.equal(result.materializedSessionIdForRunStateReset, null);
  assert.deepEqual(Object.keys(result.draftsBySessionKey), ["session:remapped", "pending-session:created-1"]);
  assert.equal(result.draftsBySessionKey["pending-session:created-1"]?.state, "error");
  assert.equal(result.draftsBySessionKey["pending-session:created-1"]?.sessionId, null);
  assert.equal(result.draftsBySessionKey["pending-session:created-1"]?.sessionKey, "pending-session:created-1");
});

test("pending submitted failure preserves identity when the submit id is missing", () => {
  const current = {
    "session:real": pendingSubmittedDraft({
      id: "submit-2",
      sessionKey: "session:real",
      sessionId: "real",
    }),
  };

  const result = markMatchingPendingSubmittedDraftFailed({
    draftsBySessionKey: current,
    sessionKey: "session:real",
    pendingSubmitId: "submit-1",
    pendingSessionKeyBeforeHandoff: null,
    materializedSessionIdFromHandoff: null,
    errorMessage: "failed",
  });

  assert.equal(result.draftsBySessionKey, current);
  assert.equal(result.materializedSessionIdToRestore, null);
  assert.equal(result.materializedSessionIdForRunStateReset, null);
});

test("run UI state equality compares baseline fields and preserves no-op update identity", () => {
  const current = { "session:a": runState() };
  const same = { ...current["session:a"], baseline: { ...current["session:a"].baseline } };
  const changed = { ...same, baseline: { ...same.baseline, partCount: 4 } };

  assert.equal(runUiStateEqual(current["session:a"], same), true);
  assert.equal(runUiStateEqual(current["session:a"], changed), false);
  assert.equal(
    updateRunStateRecord(current, "session:a", () => same),
    current,
    "no-op run state updates should keep the containing record identity",
  );
});

test("run UI state updates create an idle baseline only for the requested session key", () => {
  const current = { "session:other": runState({ startedAt: 20 }) };
  const next = updateRunStateRecord(
    current,
    " session:new ",
    (state) => ({ ...state, hasBegun: true }),
    42,
  );

  assert.notEqual(next, current);
  assert.equal(next["session:other"], current["session:other"]);
  assert.deepEqual(next["session:new"], {
    ...createIdleRunState(42),
    hasBegun: true,
  });
  assert.equal(updateRunStateRecord(current, "   ", (state) => state), current);
});

test("pending run state remaps only the materialized pending key", () => {
  const pendingRun = runState({ startedAt: 100 });
  const realRun = runState({ startedAt: 200 });
  const current = {
    "pending:base": pendingRun,
    "session:existing": realRun,
    "pending:other": runState({ startedAt: 300 }),
  };
  const next = remapPendingRunStateToSession(current, "pending:base", "session:real");

  assert.deepEqual(Object.keys(next).sort(), ["pending:other", "session:existing", "session:real"]);
  assert.equal(next["session:real"], pendingRun);
  assert.equal(next["session:existing"], realRun);
  assert.equal(remapPendingRunStateToSession(current, "pending:missing", "session:real"), current);
});

test("reset run state removes only the requested session key", () => {
  const current = {
    "session:a": runState({ startedAt: 1 }),
    "session:b": runState({ startedAt: 2 }),
  };
  const next = resetRunStateRecord(current, "session:a");

  assert.deepEqual(Object.keys(next), ["session:b"]);
  assert.equal(next["session:b"], current["session:b"]);
  assert.equal(resetRunStateRecord(current, "session:missing"), current);
});

test("pending queue remap appends behind an existing real queue and preserves unrelated queues", () => {
  const current = {
    "pending:base": ["pending-1", "pending-2"],
    "session:real": ["real-1"],
    "session:other": ["other-1"],
  };
  const next = remapPendingQueueToSession(current, "pending:base", "session:real");

  assert.deepEqual(next, {
    "session:real": ["real-1", "pending-1", "pending-2"],
    "session:other": ["other-1"],
  });
  assert.equal(remapPendingQueueToSession(current, "pending:missing", "session:real"), current);
});

test("pending queue pause remap keeps existing real pause state", () => {
  assert.deepEqual(
    remapQueuePausedToSession(
      {
        "pending:base": true,
        "session:real": false,
        "session:other": true,
      },
      "pending:base",
      "session:real",
    ),
    {
      "session:real": true,
      "session:other": true,
    },
  );

  const current = { "session:real": true };
  assert.equal(remapQueuePausedToSession(current, "pending:missing", "session:real"), current);
});

test("failed materialized first send restores queue and pause state to the pending key", () => {
  const queue = {
    "pending:base": ["pending-existing"],
    "session:real": ["materialized-follow-up"],
    "session:other": ["other"],
  };
  const paused = {
    "pending:base": false,
    "session:real": true,
  };

  assert.deepEqual(restoreMaterializedQueueToPending(queue, "pending:base", "session:real"), {
    "pending:base": ["pending-existing", "materialized-follow-up"],
    "session:other": ["other"],
  });
  assert.deepEqual(restoreQueuePausedToPending(paused, "pending:base", "session:real"), {
    "pending:base": true,
  });
  assert.equal(restoreMaterializedQueueToPending(queue, "pending:base", "session:missing"), queue);
  assert.equal(restoreQueuePausedToPending(paused, "pending:base", "session:missing"), paused);
});

test("send prompt action saves queued edits unless send-now is requested", () => {
  assert.deepEqual(
    resolveSendPromptAction({
      sendNow: false,
      editingQueuedDraftId: " queued-1 ",
      editingTranscriptMessageId: "message-1",
      queuePaused: true,
      queuedDraftCount: 3,
      runVisible: true,
    }),
    { kind: "save-edited-queued-draft", editingId: "queued-1" },
  );

  assert.deepEqual(
    resolveSendPromptAction({
      sendNow: true,
      editingQueuedDraftId: "queued-1",
      editingTranscriptMessageId: "message-1",
      queuePaused: true,
      queuedDraftCount: 3,
      runVisible: true,
    }),
    { kind: "send-edited-queued-draft-now", editingId: "queued-1" },
  );
});

test("send prompt action replaces transcript edits before queue state is considered", () => {
  assert.deepEqual(
    resolveSendPromptAction({
      sendNow: false,
      editingQueuedDraftId: null,
      editingTranscriptMessageId: " message-1 ",
      queuePaused: true,
      queuedDraftCount: 3,
      runVisible: true,
    }),
    { kind: "replace-transcript-message", messageId: "message-1" },
  );
});

test("send prompt action preserves queue branch priority", () => {
  const base = {
    editingQueuedDraftId: null,
    editingTranscriptMessageId: null,
  };

  assert.deepEqual(
    resolveSendPromptAction({
      ...base,
      sendNow: false,
      queuePaused: true,
      queuedDraftCount: 3,
      runVisible: true,
    }),
    { kind: "append-to-paused-queue-and-drain" },
  );

  assert.deepEqual(
    resolveSendPromptAction({
      ...base,
      sendNow: false,
      queuePaused: false,
      queuedDraftCount: 3,
      runVisible: true,
    }),
    { kind: "append-to-existing-queue-and-drain-if-idle" },
  );

  assert.deepEqual(
    resolveSendPromptAction({
      ...base,
      sendNow: false,
      queuePaused: false,
      queuedDraftCount: 0,
      runVisible: true,
    }),
    { kind: "send-running-server-queue" },
  );
});

test("send prompt action distinguishes explicit send-now from normal sends", () => {
  const base = {
    editingQueuedDraftId: null,
    editingTranscriptMessageId: null,
    queuePaused: false,
    queuedDraftCount: 0,
    runVisible: false,
  };

  assert.deepEqual(resolveSendPromptAction({ ...base, sendNow: true }), { kind: "send-now" });
  assert.deepEqual(resolveSendPromptAction({ ...base, sendNow: false }), { kind: "send-normal" });
});

test("queue drain start skips blank, in-flight, paused, and empty queues", () => {
  const item = { id: "queued-1" };

  assert.deepEqual(
    resolveQueueDrainStart({ sessionKey: "   ", inFlight: false, queuePaused: false, item }),
    { kind: "skip", reason: "empty-session-key" },
  );
  assert.deepEqual(
    resolveQueueDrainStart({ sessionKey: "session:a", inFlight: true, queuePaused: false, item }),
    { kind: "skip", reason: "in-flight" },
  );
  assert.deepEqual(
    resolveQueueDrainStart({ sessionKey: "session:a", inFlight: false, queuePaused: true, item }),
    { kind: "skip", reason: "paused" },
  );
  assert.deepEqual(
    resolveQueueDrainStart({ sessionKey: "session:a", inFlight: false, queuePaused: false, item: null }),
    { kind: "skip", reason: "empty-queue" },
  );
});

test("queue drain start returns the trimmed captured session key and item", () => {
  const item = { id: "queued-1" };

  assert.deepEqual(
    resolveQueueDrainStart({ sessionKey: " session:a ", inFlight: false, queuePaused: false, item }),
    { kind: "send", drainSessionKey: "session:a", item },
  );
});

test("queue drain completion restores stale pending queues without sending errors to the active session", () => {
  assert.deepEqual(
    resolveQueueDrainCompletionAction({
      accepted: false,
      currentSessionKey: "session:active",
      drainSessionKey: "pending:old",
      drainSessionId: null,
      queuedDraftSessionKey: "pending:remapped",
    }),
    { kind: "mark-queued", sessionKey: "pending:remapped" },
  );
});

test("queue drain completion removes accepted items from the key that currently owns the draft", () => {
  assert.deepEqual(
    resolveQueueDrainCompletionAction({
      accepted: true,
      currentSessionKey: "session:active",
      drainSessionKey: "pending:old",
      drainSessionId: null,
      queuedDraftSessionKey: "session:materialized",
    }),
    { kind: "remove", sessionKey: "session:materialized" },
  );
});

test("queue drain completion marks rejected active drains as errors on the current owner key", () => {
  assert.deepEqual(
    resolveQueueDrainCompletionAction({
      accepted: false,
      currentSessionKey: "session:active",
      drainSessionKey: "session:active",
      drainSessionId: "active",
      queuedDraftSessionKey: "session:active",
    }),
    { kind: "mark-error", sessionKey: "session:active" },
  );
});
