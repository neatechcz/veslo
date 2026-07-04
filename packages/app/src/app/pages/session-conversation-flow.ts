import {
  createPendingSubmittedDraft,
  markPendingSubmittedFailed,
  pendingSubmittedDraftToEditable,
  type PendingSubmittedDraft,
} from "../components/session/pending-submit-model";
import type { EditableUserMessageDraft } from "../components/session/message-editability";
import {
  isPendingSessionInstanceId,
  removePendingSubmittedDraftForKey,
  setPendingSubmittedDraftForKey,
  type PendingSubmittedDraftBySessionKey,
} from "../components/session/pending-session-instance-model";
import {
  firstQueuedDraft,
  markQueuedDraftEditing,
  markQueuedDraftError,
  markQueuedDraftQueued,
  markQueuedDraftSending,
  moveQueuedDraft,
  removeQueuedDraft,
  updateQueuedDraft,
  type QueuedDraft,
} from "../components/session/session-queue-model.js";
import type { ComposerDraft, PendingSidebarSessionMetadata } from "../types";
import type {
  MaterializedSessionHandoff,
  SessionSendOptionsBase,
  SessionSendOrigin,
} from "../lib/session-send-contract";
import {
  createUiConversationKey,
  parseUiConversationKey,
  sessionIdFromUiConversationKey,
} from "../lib/ui-conversation-scope";

export type SessionQueueConversationRef = {
  workspaceId?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

export type SessionQueuePendingDraftMeta = {
  kind: string;
  workspaceId: string;
  privateWorkspaceId?: string | null;
};

export type SessionQueueKeyContext = {
  activeWorkspaceId: string;
  activeUiConversationRef?: SessionQueueConversationRef | null;
  activePendingDraftKey?: string | null;
  activePendingDraftMeta?: SessionQueuePendingDraftMeta | null;
};

export type CurrentSessionQueueKeyInput = SessionQueueKeyContext & {
  selectedSessionId?: string | null;
  pendingQueueKeyAwaitingSessionIdByBaseKey: Record<string, string>;
};

const isLegacyPendingSessionKey = (value: string) =>
  isPendingSessionInstanceId(value) ||
  value.startsWith("pending:") ||
  value.startsWith("pending-draft:") ||
  value.startsWith("pending-workspace:");

export const resolveActiveUiConversationWorkspaceId = ({
  activeUiConversationRef,
  activeWorkspaceId,
}: SessionQueueKeyContext) =>
  activeUiConversationRef?.workspaceId?.trim() || activeWorkspaceId || "default";

export const resolvePendingDraftWorkspaceId = (context: SessionQueueKeyContext) => {
  const meta = context.activePendingDraftMeta;
  if (!meta) return resolveActiveUiConversationWorkspaceId(context);
  const workspaceId =
    meta.kind === "new-private"
      ? (meta.privateWorkspaceId ?? meta.workspaceId).trim()
      : meta.workspaceId.trim();
  return workspaceId || resolveActiveUiConversationWorkspaceId(context);
};

export const resolveWorkspaceIdForSessionQueue = (
  context: SessionQueueKeyContext,
  sessionId: string,
) => {
  const id = sessionId.trim();
  if (!id) return resolvePendingDraftWorkspaceId(context);
  const ref = context.activeUiConversationRef;
  if (
    ref &&
    [
      ref.sessionId?.trim() ?? "",
      ref.conversationId?.trim() ?? "",
      ref.opencodeSessionId?.trim() ?? "",
    ].includes(id)
  ) {
    return ref.workspaceId?.trim() || resolveActiveUiConversationWorkspaceId(context);
  }
  return context.activeWorkspaceId || resolveActiveUiConversationWorkspaceId(context);
};

export const resolvePendingSessionQueueKey = (context: SessionQueueKeyContext) => {
  const pendingDraftKey = context.activePendingDraftKey?.trim();
  const workspaceId = resolvePendingDraftWorkspaceId(context);
  if (pendingDraftKey) {
    return createUiConversationKey({
      workspaceId,
      kind: "pending-draft",
      id: pendingDraftKey,
    });
  }
  return createUiConversationKey({
    workspaceId: resolveActiveUiConversationWorkspaceId(context),
    kind: "pending-workspace",
    id: "active",
  });
};

export const resolveSessionQueueKeyForSessionId = (
  context: SessionQueueKeyContext,
  sessionId: string | null | undefined,
) => {
  const id = sessionId?.trim() ?? "";
  if (!id) return resolvePendingSessionQueueKey(context);
  const pending = isLegacyPendingSessionKey(id);
  return createUiConversationKey({
    workspaceId: pending
      ? resolvePendingDraftWorkspaceId(context)
      : resolveWorkspaceIdForSessionQueue(context, id),
    kind: pending ? "pending-session" : "session",
    id,
  });
};

export const resolveSessionIdForQueueKey = (sessionKey: string) => {
  const scopedSessionId = sessionIdFromUiConversationKey(sessionKey);
  if (scopedSessionId) return scopedSessionId;
  const parsed = parseUiConversationKey(sessionKey);
  if (parsed) return null;
  return isLegacyPendingSessionKey(sessionKey) ? null : sessionKey;
};

export const resolveWorkspaceIdForQueueKey = (
  context: Pick<SessionQueueKeyContext, "activeWorkspaceId">,
  sessionKey: string,
) => parseUiConversationKey(sessionKey)?.workspaceId ?? context.activeWorkspaceId;

export const resolveCurrentSessionQueueKey = ({
  selectedSessionId,
  pendingQueueKeyAwaitingSessionIdByBaseKey,
  ...context
}: CurrentSessionQueueKeyInput) => {
  const selectedSessionKey = selectedSessionId?.trim();
  if (selectedSessionKey) return resolveSessionQueueKeyForSessionId(context, selectedSessionKey);
  const basePendingKey = resolvePendingSessionQueueKey(context);
  return pendingQueueKeyAwaitingSessionIdByBaseKey[basePendingKey] ?? basePendingKey;
};

export type ResolveTranscriptDisplaySessionIdInput = {
  selectedSessionId?: string | null;
  heldMaterializedSessionId?: string | null;
  hasSendingOptimisticSubmit: boolean;
  transcriptMessageCount: number;
};

// First-send handoff can select the newly-created real session before OpenCode
// has returned the user message in the transcript. Keep the viewport on the
// pending/no-session surface during that gap so the optimistic row does not
// flicker through an empty real-session loading state.
export const resolveTranscriptDisplaySessionId = ({
  selectedSessionId,
  heldMaterializedSessionId,
  hasSendingOptimisticSubmit,
  transcriptMessageCount,
}: ResolveTranscriptDisplaySessionIdInput) => {
  const selected = selectedSessionId?.trim() || null;
  const held = heldMaterializedSessionId?.trim() || null;
  if (
    selected &&
    held === selected &&
    hasSendingOptimisticSubmit &&
    transcriptMessageCount === 0
  ) {
    return null;
  }
  return selected;
};

export const shouldClearMaterializedSubmitDisplayHold = ({
  selectedSessionId,
  heldMaterializedSessionId,
  hasSendingOptimisticSubmit,
  transcriptMessageCount,
}: ResolveTranscriptDisplaySessionIdInput) => {
  const held = heldMaterializedSessionId?.trim() || null;
  if (!held) return false;
  const selected = selectedSessionId?.trim() || null;
  if (selected !== held) return true;
  if (transcriptMessageCount > 0) return true;
  return !hasSendingOptimisticSubmit;
};

export type PendingSessionHandoffScope = {
  pendingSessionBaseKeyBeforeHandoff: string | null;
  pendingInstanceKey: string | null;
  sessionKey: string;
  pendingSessionKeyBeforeHandoff: string | null;
};

export type ResolvePendingSessionHandoffScopeInput = {
  baseSessionKey: string;
  targetSessionId: string | null;
  pendingSessionQueueKey: string;
  createPendingSessionInstanceId: () => string;
};

export const resolvePendingSessionHandoffScope = ({
  baseSessionKey,
  targetSessionId,
  pendingSessionQueueKey,
  createPendingSessionInstanceId,
}: ResolvePendingSessionHandoffScopeInput): PendingSessionHandoffScope => {
  const baseKey = baseSessionKey.trim();
  const pendingSessionBaseKeyBeforeHandoff =
    !targetSessionId && !resolveSessionIdForQueueKey(baseKey)
      ? isPendingSessionInstanceId(baseKey)
        ? pendingSessionQueueKey
        : baseKey
      : null;
  const needsPendingSessionInstance =
    Boolean(pendingSessionBaseKeyBeforeHandoff) && !isPendingSessionInstanceId(baseKey);
  const pendingInstanceKey = needsPendingSessionInstance ? createPendingSessionInstanceId() : null;
  const sessionKey = pendingInstanceKey ?? baseKey;
  const pendingSessionKeyBeforeHandoff =
    !targetSessionId && !resolveSessionIdForQueueKey(sessionKey) ? sessionKey : null;

  return {
    pendingSessionBaseKeyBeforeHandoff,
    pendingInstanceKey,
    sessionKey,
    pendingSessionKeyBeforeHandoff,
  };
};

export type PendingSessionHandoffFailureAction =
  | { kind: "none" }
  | {
      kind: "clear-base-mapping";
      pendingSessionBaseKey: string;
      pendingSessionKey: null;
    }
  | {
      kind: "keep-pending-instance";
      pendingSessionBaseKey: string;
      pendingSessionKey: string;
    }
  | {
      kind: "clear-matching-pending-instance";
      pendingSessionBaseKey: string;
      pendingSessionKey: string;
    };

export type ResolvePendingSessionHandoffFailureActionInput = {
  pendingSessionBaseKeyBeforeHandoff: string | null;
  pendingSessionKeyBeforeHandoff: string | null;
  materializedSessionIdFromHandoff: string | null;
  showOptimisticSubmit: boolean;
  selectedSessionId?: string | null;
};

export const resolvePendingSessionHandoffFailureAction = ({
  pendingSessionBaseKeyBeforeHandoff,
  pendingSessionKeyBeforeHandoff,
  materializedSessionIdFromHandoff,
  showOptimisticSubmit,
  selectedSessionId,
}: ResolvePendingSessionHandoffFailureActionInput): PendingSessionHandoffFailureAction => {
  if (!pendingSessionBaseKeyBeforeHandoff || !pendingSessionKeyBeforeHandoff) {
    return { kind: "none" };
  }
  if (materializedSessionIdFromHandoff) {
    return {
      kind: "clear-base-mapping",
      pendingSessionBaseKey: pendingSessionBaseKeyBeforeHandoff,
      pendingSessionKey: null,
    };
  }
  if (showOptimisticSubmit && !selectedSessionId?.trim()) {
    return {
      kind: "keep-pending-instance",
      pendingSessionBaseKey: pendingSessionBaseKeyBeforeHandoff,
      pendingSessionKey: pendingSessionKeyBeforeHandoff,
    };
  }
  return {
    kind: "clear-matching-pending-instance",
    pendingSessionBaseKey: pendingSessionBaseKeyBeforeHandoff,
    pendingSessionKey: pendingSessionKeyBeforeHandoff,
  };
};

export type PendingSessionHandoffMaterializationInput = {
  pendingSessionBaseKeyBeforeHandoff: string | null;
  pendingSessionKeyBeforeHandoff: string | null;
  clientMessageId: string;
  handoff?: {
    pendingSessionKey?: string | null;
    clientMessageId?: string | null;
    sessionId?: string | null;
  } | null;
};

export type PendingSessionHandoffMaterialization =
  | {
      kind: "skip";
      reason:
        | "no-pending-handoff"
        | "pending-key-mismatch"
        | "client-message-mismatch"
        | "missing-session-id"
        | "pending-session-id";
    }
  | {
      kind: "materialize";
      pendingSessionBaseKey: string;
      pendingSessionKey: string;
      materializedPendingKey: string;
      materializedSessionId: string;
    };

export const resolvePendingSessionHandoffMaterialization = ({
  pendingSessionBaseKeyBeforeHandoff,
  pendingSessionKeyBeforeHandoff,
  clientMessageId,
  handoff,
}: PendingSessionHandoffMaterializationInput): PendingSessionHandoffMaterialization => {
  const pendingSessionBaseKey = pendingSessionBaseKeyBeforeHandoff?.trim() ?? "";
  const pendingSessionKey = pendingSessionKeyBeforeHandoff?.trim() ?? "";
  if (!pendingSessionBaseKey || !pendingSessionKey) {
    return { kind: "skip", reason: "no-pending-handoff" };
  }

  const materializedPendingKey = handoff?.pendingSessionKey?.trim() || pendingSessionKey;
  if (materializedPendingKey !== pendingSessionKey) {
    return { kind: "skip", reason: "pending-key-mismatch" };
  }

  const handoffClientMessageId = handoff?.clientMessageId?.trim();
  if (handoffClientMessageId && handoffClientMessageId !== clientMessageId) {
    return { kind: "skip", reason: "client-message-mismatch" };
  }

  const materializedSessionId = handoff?.sessionId?.trim();
  if (!materializedSessionId) return { kind: "skip", reason: "missing-session-id" };
  if (isPendingSessionInstanceId(materializedSessionId)) {
    return { kind: "skip", reason: "pending-session-id" };
  }

  return {
    kind: "materialize",
    pendingSessionBaseKey,
    pendingSessionKey,
    materializedPendingKey,
    materializedSessionId,
  };
};

export const removePendingSubmittedDraftById = (
  current: PendingSubmittedDraftBySessionKey,
  pendingSubmitId: string,
) => {
  const id = pendingSubmitId.trim();
  if (!id) return current;
  const matchingEntry = Object.entries(current).find(([, draft]) => draft.id === id);
  if (!matchingEntry) return current;
  const [matchingSessionKey] = matchingEntry;
  return removePendingSubmittedDraftForKey(current, matchingSessionKey, id);
};

export type MarkMatchingPendingSubmittedDraftFailedInput = {
  draftsBySessionKey: PendingSubmittedDraftBySessionKey;
  sessionKey: string;
  pendingSubmitId: string;
  pendingSessionKeyBeforeHandoff: string | null;
  materializedSessionIdFromHandoff: string | null;
  errorMessage: string;
};

export type MarkMatchingPendingSubmittedDraftFailedResult = {
  draftsBySessionKey: PendingSubmittedDraftBySessionKey;
  materializedSessionIdToRestore: string | null;
  materializedSessionIdForRunStateReset: string | null;
};

export const markMatchingPendingSubmittedDraftFailed = ({
  draftsBySessionKey,
  sessionKey,
  pendingSubmitId,
  pendingSessionKeyBeforeHandoff,
  materializedSessionIdFromHandoff,
  errorMessage,
}: MarkMatchingPendingSubmittedDraftFailedInput): MarkMatchingPendingSubmittedDraftFailedResult => {
  const submitId = pendingSubmitId.trim();
  const directMatch = draftsBySessionKey[sessionKey];
  const matchingEntry =
    directMatch?.id === submitId
      ? ([sessionKey, directMatch] as const)
      : Object.entries(draftsBySessionKey).find(([, draft]) => draft.id === submitId);
  if (!matchingEntry) {
    return {
      draftsBySessionKey,
      materializedSessionIdToRestore: null,
      materializedSessionIdForRunStateReset: null,
    };
  }

  const [matchingSessionKey, current] = matchingEntry;
  const failed = markPendingSubmittedFailed(current, errorMessage);
  if (!pendingSessionKeyBeforeHandoff) {
    return {
      draftsBySessionKey: setPendingSubmittedDraftForKey(draftsBySessionKey, matchingSessionKey, failed),
      materializedSessionIdToRestore: null,
      materializedSessionIdForRunStateReset: null,
    };
  }

  const materializedSessionIdToRestore =
    current.sessionId || materializedSessionIdFromHandoff || null;
  if (current.sessionId) {
    return {
      draftsBySessionKey: setPendingSubmittedDraftForKey(draftsBySessionKey, matchingSessionKey, failed),
      materializedSessionIdToRestore,
      materializedSessionIdForRunStateReset: current.sessionId,
    };
  }

  return {
    draftsBySessionKey: setPendingSubmittedDraftForKey(
      draftsBySessionKey,
      pendingSessionKeyBeforeHandoff,
      {
        ...failed,
        sessionKey: pendingSessionKeyBeforeHandoff,
        sessionId: null,
      },
    ),
    materializedSessionIdToRestore,
    materializedSessionIdForRunStateReset: null,
  };
};

export type SendPromptImmediateReason = "normal" | "queue-drain" | "send-now" | "replacement";

export type SendPromptImmediateOptions = {
  reason?: SendPromptImmediateReason;
  expectedSessionKey?: string;
  replaceMessageId?: string;
  restoreDraftOnFailure?: boolean;
  sendTraceId?: string | null;
};

export type HandleSendPromptOptions = {
  sendNow?: boolean;
  sendTraceId?: string | null;
};

export type SessionConversationFlowControllerDeps = {
  identity: {
    createClientMessageId: () => string;
    createPendingSessionInstanceId: () => string;
    now: () => number;
  };
  sessionKeys: {
    activeUiConversationWorkspaceId: () => string;
    activeWorkspaceId: () => string;
    currentSessionQueueKey: () => string;
    pendingSessionQueueKey: () => string;
    selectedSessionId: () => string | null;
    sessionIdForQueueKey: (sessionKey: string) => string | null;
    sessionQueueKeyForSessionId: (sessionId: string | null | undefined) => string;
    workspaceIdForQueueKey: (sessionKey: string) => string;
  };
  runtime: {
    activePendingDraftKey: () => string | null;
    aiAccessBlockedReason: () => string | null;
    busyHint: () => string | null;
    busyLabel: () => string | null;
    error: () => string | null;
  };
  transcript: {
    messageCount: () => number;
    messageIds: () => string[];
  };
  pendingHandoff: {
    clearPendingQueueKeyAwaitingSessionIdForBaseKey: (
      baseKey: string | null,
      pendingKey: string | null,
    ) => void;
    createPendingSidebarSessionWorkspaceId: () => string;
    createPendingSidebarSessionWorkspaceRoot: (workspaceId: string) => string;
    remapPendingQueueToSession: (pendingKey: string, sessionId: string) => void;
    restoreMaterializedQueueToPending: (pendingKey: string, sessionId: string | null | undefined) => void;
    setPendingQueueKeyAwaitingSessionIdForBaseKey: (baseKey: string, pendingKey: string) => void;
  };
  pendingSubmitted: {
    pendingSubmittedDrafts?: () => PendingSubmittedDraftBySessionKey;
    optimisticSubmittedDraft: () => PendingSubmittedDraft | null;
    setOptimisticSubmittedDraft: (sessionKey: string, draft: PendingSubmittedDraft) => void;
    updatePendingSubmittedDrafts: (
      updater: (current: PendingSubmittedDraftBySessionKey) => PendingSubmittedDraftBySessionKey,
    ) => void;
  };
  queue: {
    appendDraftToCurrentQueue: (draft: ComposerDraft) => void;
    editingQueuedDraftId: () => string | null;
    queuePaused: () => boolean;
    queuedDraftsBySessionKey: () => Record<string, QueuedDraft[]>;
    queuedDrafts: () => QueuedDraft[];
    queuePausedForSessionKey: (sessionKey: string) => boolean;
    resolveQueueKeyForQueuedDraft: (originalSessionKey: string, draftId: string) => string;
    setEditingQueuedDraftId: (id: string | null) => void;
    setQueuePausedForSessionKey: (sessionKey: string, paused: boolean) => void;
    updateCurrentQueue: (updater: (queue: QueuedDraft[]) => QueuedDraft[]) => void;
    updateQueueForSessionKey: (
      sessionKey: string,
      updater: (queue: QueuedDraft[]) => QueuedDraft[],
    ) => void;
  };
  composer: {
    clearComposerDraftForSession: (sessionId: string | null | undefined) => void;
    currentDraftMode: () => ComposerDraft["mode"];
    setComposerDraft: (draft: ComposerDraft) => void;
  };
  transcriptEdit: {
    editableUserMessage: () => EditableUserMessageDraft | null;
    editingTranscriptMessageId: () => string | null;
    setEditingTranscriptMessageId: (id: string | null) => void;
  };
  runControl: {
    abortBusy: () => boolean;
    abortSession: (sessionId?: string) => Promise<void>;
    lastPromptSent: () => string;
    retryLastPrompt: () => void;
    runPhase: () => string;
    hasAbortableBackendRun?: () => boolean;
    setAbortBusy: (busy: boolean) => void;
    setEscapeStopConfirmationPending: (pending: boolean) => void;
  };
  runState: {
    resetRunState: (sessionKey: string) => void;
    showRunIndicator: () => boolean;
    startRun: (sessionKey: string) => void;
  };
  sessionStatus?: {
    statusForQueueKey: (sessionKey: string, statuses: Record<string, string>) => string;
    statusForSessionId: (sessionId: string, statuses: Record<string, string>) => string;
  };
  viewport: {
    scheduleScrollToLatest: (behavior: ScrollBehavior) => void;
    setStickToBottom: (value: boolean) => void;
  };
  transport: {
    replaceUserMessageAsync: (
      messageId: string,
      draft: ComposerDraft,
      options: SessionSendOptionsBase & { targetSessionId?: string | null },
    ) => Promise<boolean>;
    sendPromptAsync: (
      draft: ComposerDraft,
      options: SessionSendOptionsBase & {
        targetSessionId?: string | null;
        onMaterializedSessionId?: (handoff: MaterializedSessionHandoff) => void;
        pendingSession?: PendingSidebarSessionMetadata | null;
      },
    ) => Promise<boolean>;
  };
  feedback: {
    setToastMessage: (message: string) => void;
    tr: (key: string) => string;
  };
  trace: {
    markTempRuntimeUiRenderSource: (
      source: string,
      reason: string,
      extras?: { clientMessageId?: string; origin?: SessionSendOrigin; detail?: string },
    ) => void;
    recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
    reportError: (error: unknown, context: string) => void;
  };
  effects: {
    batch: (fn: () => void) => void;
  };
};

export type SessionConversationFlowController = {
  cancelRun: () => Promise<void>;
  drainNextQueuedDraft: (
    reason: Extract<SendPromptImmediateReason, "normal" | "queue-drain">,
    sessionKey?: string,
  ) => Promise<void>;
  handleCancelQueuedDraft: (id: string) => boolean;
  handleEditQueuedDraft: (id: string) => boolean;
  handleEditUserMessage: (editable: EditableUserMessageDraft) => boolean;
  handleMoveQueuedDraft: (id: string, targetIndex: number) => void;
  handleSendPrompt: (draft: ComposerDraft, options?: HandleSendPromptOptions) => Promise<boolean>;
  handleActiveSessionStatusChanged: (status: string, previousStatus: string | undefined) => void;
  handleSelectedSessionChanged: (input: {
    sessionId: string | null | undefined;
    previousSessionId: string | null | undefined;
    pendingBaseKey: string;
    pendingKey: string | null;
    sessionStatusById: Record<string, string>;
  }) => {
    selectedSessionId: string | null;
    materializedPendingSubmit: boolean;
    shouldMarkInitialAnchor: boolean;
  };
  handleSessionSwitchEditState: (previousSessionId: string | null | undefined) => void;
  handleSessionStatusMapChanged: (
    statuses: Record<string, string>,
    previousStatuses: Record<string, string> | undefined,
  ) => void;
  retryRun: () => Promise<void>;
  restoreEditingQueuedDraft: (sessionKey: string, id: string | null) => void;
  sendPromptImmediate: (draft: ComposerDraft, options?: SendPromptImmediateOptions) => Promise<boolean>;
};

export const resolveSessionSendOriginForReason = (
  reason: SendPromptImmediateReason = "normal",
): SessionSendOrigin => {
  if (reason === "queue-drain") return "session:queue-drain";
  if (reason === "send-now") return "session:send-now";
  if (reason === "replacement") return "session:replacement";
  return "session:normal";
};

const createEmptyComposerDraft = (mode: ComposerDraft["mode"] = "prompt"): ComposerDraft => ({
  mode,
  parts: [],
  attachments: [],
  text: "",
  resolvedText: "",
});

export function createSessionConversationFlow(deps: SessionConversationFlowControllerDeps): SessionConversationFlowController {
  const queueDrainAttemptInFlightBySessionKey = new Set<string>();
  const pendingSubmittedDrafts = () => deps.pendingSubmitted.pendingSubmittedDrafts?.() ?? {};
  const statusForSessionId = (sessionId: string, statuses: Record<string, string>) =>
    deps.sessionStatus?.statusForSessionId(sessionId, statuses) ?? statuses[sessionId]?.trim() ?? "idle";
  const statusForQueueKey = (sessionKey: string, statuses: Record<string, string>) =>
    deps.sessionStatus?.statusForQueueKey(sessionKey, statuses) ?? statuses[sessionKey]?.trim() ?? "idle";
  const controller: SessionConversationFlowController = {
    cancelRun: async () => {
      deps.runControl.setEscapeStopConfirmationPending(false);
      if (deps.runControl.abortBusy()) return;

      const sessionKey = deps.sessionKeys.currentSessionQueueKey();
      deps.queue.setQueuePausedForSessionKey(sessionKey, true);

      if (deps.runControl.runPhase() === "error" && deps.runControl.hasAbortableBackendRun?.() !== true) {
        deps.runState.resetRunState(sessionKey);
        return;
      }

      const selectedSessionId = deps.sessionKeys.selectedSessionId();
      if (!selectedSessionId) {
        deps.feedback.setToastMessage(deps.feedback.tr("session.no_session_selected_toast"));
        return;
      }

      deps.runControl.setAbortBusy(true);
      deps.feedback.setToastMessage(deps.feedback.tr("session.stopping_run"));
      try {
        await deps.runControl.abortSession(selectedSessionId);
        deps.feedback.setToastMessage(deps.feedback.tr("session.run_stopped"));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : deps.feedback.tr("session.failed_to_stop");
        deps.feedback.setToastMessage(message);
      } finally {
        deps.runControl.setAbortBusy(false);
      }
    },
    retryRun: async () => {
      const text = deps.runControl.lastPromptSent().trim();
      if (!text) {
        deps.feedback.setToastMessage(deps.feedback.tr("session.nothing_to_retry"));
        return;
      }

      if (deps.runControl.abortBusy()) return;
      deps.runControl.setEscapeStopConfirmationPending(false);
      deps.runControl.setAbortBusy(true);
      deps.feedback.setToastMessage(deps.feedback.tr("session.trying_again"));
      try {
        const selectedSessionId = deps.sessionKeys.selectedSessionId();
        if (deps.runState.showRunIndicator() && selectedSessionId) {
          await deps.runControl.abortSession(selectedSessionId);
        }
      } catch {
        // Retry should still proceed; users care more about forward motion than abort cleanup here.
      } finally {
        deps.runControl.setAbortBusy(false);
      }

      deps.runControl.retryLastPrompt();
    },
    handleSelectedSessionChanged: ({
      sessionId,
      previousSessionId,
      pendingBaseKey,
      pendingKey,
      sessionStatusById,
    }) => {
      controller.handleSessionSwitchEditState(previousSessionId);
      const selectedSessionId = sessionId?.trim() || null;
      if (!selectedSessionId) {
        return {
          selectedSessionId: null,
          materializedPendingSubmit: false,
          shouldMarkInitialAnchor: false,
        };
      }

      const materializedPendingSubmit = pendingKey
        ? pendingSubmittedDrafts()[pendingKey]?.state === "sending"
        : false;
      if (pendingKey && !isPendingSessionInstanceId(selectedSessionId)) {
        deps.pendingHandoff.remapPendingQueueToSession(pendingKey, selectedSessionId);
        deps.pendingHandoff.clearPendingQueueKeyAwaitingSessionIdForBaseKey(pendingBaseKey, pendingKey);
      }

      const sessionKey = deps.sessionKeys.sessionQueueKeyForSessionId(selectedSessionId);
      if (
        !materializedPendingSubmit &&
        statusForSessionId(selectedSessionId, sessionStatusById) === "idle" &&
        !deps.queue.queuePausedForSessionKey(sessionKey)
      ) {
        void controller.drainNextQueuedDraft("queue-drain", sessionKey);
      }

      return {
        selectedSessionId,
        materializedPendingSubmit,
        shouldMarkInitialAnchor: !materializedPendingSubmit,
      };
    },
    handleActiveSessionStatusChanged: (status, previousStatus) => {
      if (previousStatus === undefined || previousStatus === "idle" || status !== "idle") return;
      const sessionKey = deps.sessionKeys.currentSessionQueueKey();
      if (deps.queue.queuePausedForSessionKey(sessionKey)) return;
      void controller.drainNextQueuedDraft("queue-drain", sessionKey);
    },
    handleSessionStatusMapChanged: (statuses, previousStatuses) => {
      if (!previousStatuses) return;
      for (const sessionKey of Object.keys(deps.queue.queuedDraftsBySessionKey())) {
        const sessionId = deps.sessionKeys.sessionIdForQueueKey(sessionKey);
        if (!sessionId) continue;
        if (statusForQueueKey(sessionKey, previousStatuses) === "idle") continue;
        if (statusForQueueKey(sessionKey, statuses) !== "idle") continue;
        if (deps.queue.queuePausedForSessionKey(sessionKey)) continue;
        void controller.drainNextQueuedDraft("queue-drain", sessionKey);
      }
    },
    handleSessionSwitchEditState: (previousSessionId) => {
      const previousEditingQueuedDraftId = deps.queue.editingQueuedDraftId();
      controller.restoreEditingQueuedDraft(
        deps.sessionKeys.sessionQueueKeyForSessionId(previousSessionId),
        previousEditingQueuedDraftId,
      );
      if (previousEditingQueuedDraftId) {
        deps.composer.clearComposerDraftForSession(previousSessionId);
      }
      deps.queue.setEditingQueuedDraftId(null);
      deps.transcriptEdit.setEditingTranscriptMessageId(null);
    },
    restoreEditingQueuedDraft: (sessionKey, id) => {
      if (!id) return;
      deps.queue.updateQueueForSessionKey(sessionKey, (queue) => markQueuedDraftQueued(queue, id));
    },
    handleEditQueuedDraft: (id) => {
      const item = deps.queue.queuedDrafts().find((draft) => draft.id === id);
      if (!item || item.state === "sending") return false;

      const currentEditingId = deps.queue.editingQueuedDraftId();
      if (currentEditingId && currentEditingId !== id) {
        controller.restoreEditingQueuedDraft(deps.sessionKeys.currentSessionQueueKey(), currentEditingId);
      }

      deps.queue.setEditingQueuedDraftId(id);
      deps.queue.updateCurrentQueue((queue) => markQueuedDraftEditing(queue, id));
      deps.composer.setComposerDraft(item.draft);
      return true;
    },
    handleCancelQueuedDraft: (id) => {
      const item = deps.queue.queuedDrafts().find((draft) => draft.id === id);
      if (!item || item.state === "sending") return false;

      deps.queue.updateCurrentQueue((queue) => removeQueuedDraft(queue, id));
      if (deps.queue.editingQueuedDraftId() === id) {
        deps.queue.setEditingQueuedDraftId(null);
        deps.composer.setComposerDraft(createEmptyComposerDraft(deps.composer.currentDraftMode()));
      }
      return true;
    },
    handleMoveQueuedDraft: (id, targetIndex) => {
      deps.queue.updateCurrentQueue((queue) => moveQueuedDraft(queue, id, targetIndex));
    },
    handleEditUserMessage: (editable) => {
      const sessionKey = deps.sessionKeys.currentSessionQueueKey();
      const submitted = deps.pendingSubmitted.optimisticSubmittedDraft();
      const pendingEditable =
        submitted?.sessionKey === sessionKey ? pendingSubmittedDraftToEditable(submitted) : null;

      if (pendingEditable?.messageId === editable.messageId) {
        deps.pendingSubmitted.updatePendingSubmittedDrafts((current) =>
          removePendingSubmittedDraftForKey(current, sessionKey, pendingEditable.messageId),
        );
        deps.transcriptEdit.setEditingTranscriptMessageId(null);
        deps.composer.setComposerDraft(pendingEditable.draft);
        return true;
      }

      if (deps.transcriptEdit.editableUserMessage()?.messageId !== editable.messageId) return false;
      deps.composer.setComposerDraft(editable.draft);
      deps.transcriptEdit.setEditingTranscriptMessageId(editable.messageId);
      return true;
    },
    sendPromptImmediate: async (draft, options = {}) => {
      const origin = resolveSessionSendOriginForReason(options.reason);
      const clientMessageId = deps.identity.createClientMessageId();
      const expectedSessionKey = options.expectedSessionKey;
      const baseSessionKey = expectedSessionKey ?? deps.sessionKeys.currentSessionQueueKey();
      const targetSessionId = deps.sessionKeys.sessionIdForQueueKey(baseSessionKey);
      const expectedWorkspaceId =
        deps.sessionKeys.workspaceIdForQueueKey(baseSessionKey) || deps.sessionKeys.activeWorkspaceId();
      deps.trace.markTempRuntimeUiRenderSource(
        "SessionConversationFlow.sendPromptImmediate",
        options.reason ?? "normal",
        {
          clientMessageId,
          origin,
          detail: `expectedSessionKey=${expectedSessionKey ?? "current"} expectedWorkspace=${expectedWorkspaceId || "none"} targetSessionId=${targetSessionId ?? "none"}`,
        },
      );
      deps.trace.recordSendTrace("sendPromptImmediate:start", {
        sendTraceId: options.sendTraceId ?? null,
        clientMessageId,
        origin,
        aiAccessBlockedReason: deps.runtime.aiAccessBlockedReason(),
        busyHint: deps.runtime.busyHint(),
        busyLabel: deps.runtime.busyLabel(),
        activePendingDraftKey: deps.runtime.activePendingDraftKey(),
        currentSessionQueueKey: deps.sessionKeys.currentSessionQueueKey(),
        expectedSessionKey: expectedSessionKey ?? null,
        expectedWorkspaceId: expectedWorkspaceId || null,
        targetSessionId,
        reason: options.reason ?? "normal",
      });
      if (
        expectedSessionKey &&
        deps.sessionKeys.currentSessionQueueKey() !== expectedSessionKey &&
        !targetSessionId
      ) {
        return false;
      }

      const showOptimisticSubmit = !options.replaceMessageId && options.reason !== "queue-drain";
      const handoffScope = resolvePendingSessionHandoffScope({
        baseSessionKey,
        targetSessionId,
        pendingSessionQueueKey: deps.sessionKeys.pendingSessionQueueKey(),
        createPendingSessionInstanceId: deps.identity.createPendingSessionInstanceId,
      });
      const {
        pendingSessionBaseKeyBeforeHandoff,
        sessionKey,
        pendingSessionKeyBeforeHandoff,
      } = handoffScope;
      if (pendingSessionBaseKeyBeforeHandoff && pendingSessionKeyBeforeHandoff) {
        deps.pendingHandoff.setPendingQueueKeyAwaitingSessionIdForBaseKey(
          pendingSessionBaseKeyBeforeHandoff,
          pendingSessionKeyBeforeHandoff,
        );
      }

      const pendingSidebarSessionCreatedAt = deps.identity.now();
      const pendingSidebarWorkspaceId = deps.pendingHandoff.createPendingSidebarSessionWorkspaceId();
      const pendingSidebarWorkspaceRoot =
        deps.pendingHandoff.createPendingSidebarSessionWorkspaceRoot(pendingSidebarWorkspaceId);
      const pendingSidebarSession: PendingSidebarSessionMetadata | null = pendingSessionKeyBeforeHandoff
        ? {
            id: pendingSessionKeyBeforeHandoff,
            workspaceId: pendingSidebarWorkspaceId,
            workspaceRoot: pendingSidebarWorkspaceRoot,
            title: draft.text.trim(),
            createdAt: pendingSidebarSessionCreatedAt,
          }
        : null;

      deps.trace.recordSendTrace("sendPromptImmediate:queue-scope", {
        sendTraceId: options.sendTraceId ?? null,
        clientMessageId,
        origin,
        baseSessionKey,
        sessionKey,
        pendingSessionBaseKeyBeforeHandoff,
        pendingSessionKeyBeforeHandoff,
        pendingSidebarWorkspaceId,
        pendingSidebarWorkspaceRoot,
        currentSessionQueueKey: deps.sessionKeys.currentSessionQueueKey(),
        expectedWorkspaceId: expectedWorkspaceId || null,
        targetSessionId,
      });

      const pendingSubmitId = clientMessageId;
      let materializedSessionIdFromHandoff: string | null = null;
      let materializedSessionIdForRunStateReset: string | null = null;
      const runStateSessionKeyForHandoffFailure = () => {
        const materializedSessionId =
          materializedSessionIdForRunStateReset ?? materializedSessionIdFromHandoff;
        return materializedSessionId
          ? deps.sessionKeys.sessionQueueKeyForSessionId(materializedSessionId)
          : sessionKey;
      };
      const materializePendingHandoffToSession = (
        handoff: MaterializedSessionHandoff | null | undefined,
      ) => {
        const materialization = resolvePendingSessionHandoffMaterialization({
          pendingSessionBaseKeyBeforeHandoff,
          pendingSessionKeyBeforeHandoff,
          clientMessageId,
          handoff,
        });
        if (materialization.kind === "skip") return;
        const {
          pendingSessionBaseKey,
          pendingSessionKey,
          materializedPendingKey,
          materializedSessionId,
        } = materialization;
        materializedSessionIdFromHandoff = materializedSessionId;
        materializedSessionIdForRunStateReset = materializedSessionId;
        const materializedSessionKey = deps.sessionKeys.sessionQueueKeyForSessionId(materializedSessionId);
        deps.trace.recordSendTrace("sendPromptImmediate:pending-handoff-materialize", {
          sendTraceId: handoff?.sendTraceId ?? options.sendTraceId ?? null,
          clientMessageId,
          origin,
          pendingSessionBaseKeyBeforeHandoff: pendingSessionBaseKey,
          pendingSessionKeyBeforeHandoff: pendingSessionKey,
          materializedPendingKey,
          materializedSessionId,
          materializedSessionKey,
          handoffWorkspaceId: handoff?.workspaceId ?? null,
          conversationId: handoff?.conversationId ?? null,
          opencodeSessionId: handoff?.opencodeSessionId ?? null,
        });
        deps.effects.batch(() => {
          deps.pendingHandoff.setPendingQueueKeyAwaitingSessionIdForBaseKey(
            pendingSessionBaseKey,
            materializedSessionKey,
          );
          deps.pendingHandoff.remapPendingQueueToSession(pendingSessionKey, materializedSessionId);
        });
      };
      const handleMaterializedSessionId = (handoff: MaterializedSessionHandoff) => {
        deps.trace.markTempRuntimeUiRenderSource(
          "SessionConversationFlow.handleMaterializedSessionId",
          "pending-session-materialized",
          {
            clientMessageId,
            origin,
            detail: `workspaceId=${handoff.workspaceId} pendingSessionKey=${handoff.pendingSessionKey ?? "none"} materializedSessionId=${handoff.sessionId}`,
          },
        );
        materializePendingHandoffToSession(handoff);
      };
      const clearMatchingPendingSubmit = () => {
        deps.pendingSubmitted.updatePendingSubmittedDrafts((current) =>
          removePendingSubmittedDraftById(current, pendingSubmitId),
        );
      };
      const markMatchingPendingSubmitFailed = (errorMessage: string) => {
        let materializedSessionIdToRestore: string | null = null;
        deps.pendingSubmitted.updatePendingSubmittedDrafts((draftsBySessionKey) => {
          const result = markMatchingPendingSubmittedDraftFailed({
            draftsBySessionKey,
            sessionKey,
            pendingSubmitId,
            pendingSessionKeyBeforeHandoff,
            materializedSessionIdFromHandoff,
            errorMessage,
          });
          materializedSessionIdToRestore = result.materializedSessionIdToRestore;
          if (result.materializedSessionIdForRunStateReset) {
            materializedSessionIdForRunStateReset = result.materializedSessionIdForRunStateReset;
          }
          return result.draftsBySessionKey;
        });
        if (pendingSessionKeyBeforeHandoff) {
          deps.pendingHandoff.restoreMaterializedQueueToPending(
            pendingSessionKeyBeforeHandoff,
            materializedSessionIdToRestore,
          );
        }
      };
      const finishPendingSessionHandoffFailure = () => {
        const action = resolvePendingSessionHandoffFailureAction({
          pendingSessionBaseKeyBeforeHandoff,
          pendingSessionKeyBeforeHandoff,
          materializedSessionIdFromHandoff,
          showOptimisticSubmit,
          selectedSessionId: deps.sessionKeys.selectedSessionId(),
        });
        if (action.kind === "none") return;
        if (action.kind === "keep-pending-instance") {
          deps.pendingHandoff.setPendingQueueKeyAwaitingSessionIdForBaseKey(
            action.pendingSessionBaseKey,
            action.pendingSessionKey,
          );
          return;
        }
        deps.pendingHandoff.clearPendingQueueKeyAwaitingSessionIdForBaseKey(
          action.pendingSessionBaseKey,
          action.pendingSessionKey,
        );
      };

      if (showOptimisticSubmit) {
        deps.trace.recordSendTrace("sendPromptImmediate:optimistic-enqueue", {
          sendTraceId: options.sendTraceId ?? null,
          clientMessageId,
          origin,
          sessionKey,
          targetSessionId,
          pendingSessionKeyBeforeHandoff,
          transcriptMessageCountAtSubmit: deps.transcript.messageCount(),
        });
        deps.pendingSubmitted.setOptimisticSubmittedDraft(
          sessionKey,
          createPendingSubmittedDraft({
            id: pendingSubmitId,
            clientMessageId,
            sessionKey,
            createdAt: deps.identity.now(),
            transcriptMessageIdsAtSubmit: deps.transcript.messageIds(),
            sessionId:
              targetSessionId ??
              (isPendingSessionInstanceId(deps.sessionKeys.selectedSessionId())
                ? null
                : deps.sessionKeys.selectedSessionId()),
            draft,
          }),
        );
        deps.viewport.setStickToBottom(true);
        deps.viewport.scheduleScrollToLatest("auto");
        deps.runState.startRun(sessionKey);
      }

      const aiAccessBlockedReason = deps.runtime.aiAccessBlockedReason();
      if (aiAccessBlockedReason) {
        deps.trace.recordSendTrace("sendPromptImmediate:blocked-ai-access", {
          clientMessageId,
          origin,
          aiAccessBlockedReason,
          expectedSessionKey: expectedSessionKey ?? null,
          targetSessionId,
          reason: options.reason ?? "normal",
        });
        if (showOptimisticSubmit) {
          markMatchingPendingSubmitFailed(aiAccessBlockedReason);
          deps.runState.resetRunState(runStateSessionKeyForHandoffFailure());
        }
        finishPendingSessionHandoffFailure();
        deps.feedback.setToastMessage(aiAccessBlockedReason);
        return false;
      }

      try {
        const promptSendOptions: SessionSendOptionsBase & {
          targetSessionId?: string | null;
          onMaterializedSessionId?: (handoff: MaterializedSessionHandoff) => void;
          pendingSession?: PendingSidebarSessionMetadata | null;
        } = {
          clientMessageId,
          origin,
          ...(targetSessionId ? { targetSessionId } : {}),
          ...(options.sendTraceId ? { sendTraceId: options.sendTraceId } : {}),
          ...(pendingSessionKeyBeforeHandoff
            ? {
                onMaterializedSessionId: handleMaterializedSessionId,
                pendingSession: pendingSidebarSession,
              }
            : {}),
        };
        const replaceOptions: SessionSendOptionsBase & { targetSessionId?: string | null } = {
          clientMessageId,
          origin,
          ...(targetSessionId ? { targetSessionId } : {}),
          ...(options.sendTraceId ? { sendTraceId: options.sendTraceId } : {}),
        };
        const accepted = await (options.replaceMessageId
          ? deps.transport.replaceUserMessageAsync(options.replaceMessageId, draft, replaceOptions)
          : deps.transport.sendPromptAsync(draft, promptSendOptions)
        );
        deps.trace.recordSendTrace("sendPromptImmediate:result", {
          sendTraceId: options.sendTraceId ?? null,
          clientMessageId,
          origin,
          accepted,
          error: deps.runtime.error(),
          expectedSessionKey: expectedSessionKey ?? null,
          targetSessionId,
          reason: options.reason ?? "normal",
        });
        if (!accepted) {
          if (showOptimisticSubmit) {
            const errorMessage = deps.runtime.error() ?? deps.feedback.tr("session.connect_server_to_attach");
            markMatchingPendingSubmitFailed(errorMessage);
            deps.runState.resetRunState(runStateSessionKeyForHandoffFailure());
          }
          finishPendingSessionHandoffFailure();
          deps.feedback.setToastMessage(deps.runtime.error() ?? deps.feedback.tr("session.connect_server_to_attach"));
          return false;
        }
        deps.trace.markTempRuntimeUiRenderSource(
          "SessionConversationFlow.sendPromptImmediate:accepted",
          options.reason ?? "normal",
          {
            clientMessageId,
            origin,
            detail: `sessionKey=${sessionKey}`,
          },
        );
        if (accepted && pendingSessionKeyBeforeHandoff) {
          const materializedSessionId =
            materializedSessionIdFromHandoff ?? deps.sessionKeys.selectedSessionId()?.trim();
          if (materializedSessionId) {
            materializePendingHandoffToSession({
              workspaceId:
                expectedWorkspaceId || deps.sessionKeys.activeUiConversationWorkspaceId(),
              pendingSessionKey: pendingSessionKeyBeforeHandoff,
              sessionId: materializedSessionId,
              clientMessageId,
              sendTraceId: options.sendTraceId ?? null,
            });
          }
        }
        if (
          options.expectedSessionKey &&
          deps.sessionKeys.currentSessionQueueKey() !== options.expectedSessionKey
        ) {
          if (showOptimisticSubmit) {
            clearMatchingPendingSubmit();
          }
          return accepted;
        }
        deps.viewport.setStickToBottom(true);
        deps.viewport.scheduleScrollToLatest("auto");
        deps.runState.startRun(
          materializedSessionIdFromHandoff
            ? deps.sessionKeys.sessionQueueKeyForSessionId(materializedSessionIdFromHandoff)
            : sessionKey,
        );
        return true;
      } catch (error) {
        if (showOptimisticSubmit) {
          const errorMessage =
            deps.runtime.error() ??
            (error instanceof Error
              ? error.message
              : deps.feedback.tr("session.connect_server_to_attach"));
          markMatchingPendingSubmitFailed(errorMessage);
          deps.runState.resetRunState(runStateSessionKeyForHandoffFailure());
        }
        finishPendingSessionHandoffFailure();
        deps.trace.reportError(error, "session.sendPrompt");
        deps.feedback.setToastMessage(deps.runtime.error() ?? deps.feedback.tr("session.connect_server_to_attach"));
        return false;
      }
    },
    handleSendPrompt: async (draft, options = {}) => {
      const sendNow = Boolean(options.sendNow);
      const action = resolveSendPromptAction({
        sendNow,
        editingQueuedDraftId: deps.queue.editingQueuedDraftId(),
        editingTranscriptMessageId: deps.transcriptEdit.editingTranscriptMessageId(),
        queuePaused: deps.queue.queuePaused(),
        queuedDraftCount: deps.queue.queuedDrafts().length,
        runVisible: deps.runState.showRunIndicator(),
      });

      switch (action.kind) {
        case "save-edited-queued-draft": {
          const editingId = action.editingId;
          const sessionKey = deps.sessionKeys.currentSessionQueueKey();
          deps.queue.updateCurrentQueue((queue) =>
            markQueuedDraftQueued(updateQueuedDraft(queue, editingId, draft), editingId),
          );
          deps.queue.setEditingQueuedDraftId(null);
          deps.composer.setComposerDraft(createEmptyComposerDraft(draft.mode));
          if (!deps.runState.showRunIndicator() && !deps.queue.queuePausedForSessionKey(sessionKey)) {
            void controller.drainNextQueuedDraft("normal", sessionKey);
          }
          return true;
        }

        case "send-edited-queued-draft-now": {
          const editingId = action.editingId;
          const sessionKey = deps.sessionKeys.currentSessionQueueKey();
          const wasPaused = deps.queue.queuePausedForSessionKey(sessionKey);
          deps.queue.updateQueueForSessionKey(sessionKey, (queue) =>
            markQueuedDraftSending(updateQueuedDraft(queue, editingId, draft), editingId),
          );
          if (deps.sessionKeys.currentSessionQueueKey() === sessionKey) {
            deps.queue.setEditingQueuedDraftId(null);
            deps.composer.setComposerDraft(createEmptyComposerDraft(draft.mode));
          }
          const accepted = await controller.sendPromptImmediate(draft, {
            reason: "send-now",
            expectedSessionKey: sessionKey,
            restoreDraftOnFailure: false,
            sendTraceId: options.sendTraceId,
          });
          const resultSessionKey = deps.queue.resolveQueueKeyForQueuedDraft(sessionKey, editingId);
          if (!accepted) {
            deps.queue.updateQueueForSessionKey(resultSessionKey, (queue) =>
              markQueuedDraftError(
                queue,
                editingId,
                deps.runtime.error() ?? deps.feedback.tr("session.connect_server_to_attach"),
              ),
            );
            return false;
          }
          deps.queue.updateQueueForSessionKey(resultSessionKey, (queue) => removeQueuedDraft(queue, editingId));
          if (accepted && wasPaused) {
            deps.queue.setQueuePausedForSessionKey(sessionKey, false);
          }
          return true;
        }

        case "replace-transcript-message": {
          const sessionKey = deps.sessionKeys.currentSessionQueueKey();
          deps.transcriptEdit.setEditingTranscriptMessageId(null);
          const accepted = await controller.sendPromptImmediate(draft, {
            reason: "replacement",
            expectedSessionKey: sessionKey,
            replaceMessageId: action.messageId,
            sendTraceId: options.sendTraceId,
          });
          if (!accepted) return false;
          return true;
        }

        case "append-to-paused-queue-and-drain": {
          const sessionKey = deps.sessionKeys.currentSessionQueueKey();
          deps.queue.appendDraftToCurrentQueue(draft);
          deps.queue.setQueuePausedForSessionKey(sessionKey, false);
          void controller.drainNextQueuedDraft("normal", sessionKey);
          return true;
        }

        case "append-to-existing-queue-and-drain-if-idle": {
          const sessionKey = deps.sessionKeys.currentSessionQueueKey();
          deps.queue.appendDraftToCurrentQueue(draft);
          if (!deps.runState.showRunIndicator() && !deps.queue.queuePausedForSessionKey(sessionKey)) {
            void controller.drainNextQueuedDraft("normal", sessionKey);
          }
          return true;
        }

        case "append-to-running-queue": {
          deps.queue.appendDraftToCurrentQueue(draft);
          return true;
        }

        case "send-now": {
          const sessionKey = deps.sessionKeys.currentSessionQueueKey();
          const wasPaused = deps.queue.queuePausedForSessionKey(sessionKey);
          const accepted = await controller.sendPromptImmediate(draft, {
            reason: "send-now",
            expectedSessionKey: sessionKey,
            sendTraceId: options.sendTraceId,
          });
          if (accepted && wasPaused) {
            deps.queue.setQueuePausedForSessionKey(sessionKey, false);
          }
          return accepted;
        }

        case "send-normal":
          return controller.sendPromptImmediate(draft, {
            reason: "normal",
            sendTraceId: options.sendTraceId,
          });
      }
    },
    drainNextQueuedDraft: async (reason, sessionKey = deps.sessionKeys.currentSessionQueueKey()) => {
      const drainSessionKey = sessionKey.trim();
      const item = firstQueuedDraft(deps.queue.queuedDraftsBySessionKey()[drainSessionKey] ?? []);
      const start = resolveQueueDrainStart({
        sessionKey: drainSessionKey,
        inFlight: queueDrainAttemptInFlightBySessionKey.has(drainSessionKey),
        queuePaused: deps.queue.queuePausedForSessionKey(drainSessionKey),
        item,
      });
      if (start.kind === "skip") return;

      queueDrainAttemptInFlightBySessionKey.add(drainSessionKey);
      deps.queue.updateQueueForSessionKey(
        drainSessionKey,
        (queue) => markQueuedDraftSending(queue, start.item.id),
      );
      try {
        if (
          shouldRestoreQueuedDraftForStalePendingDrain({
            currentSessionKey: deps.sessionKeys.currentSessionQueueKey(),
            drainSessionKey,
            drainSessionId: deps.sessionKeys.sessionIdForQueueKey(drainSessionKey),
          })
        ) {
          const queuedSessionKey = deps.queue.resolveQueueKeyForQueuedDraft(
            drainSessionKey,
            start.item.id,
          );
          deps.queue.updateQueueForSessionKey(
            queuedSessionKey,
            (queue) => markQueuedDraftQueued(queue, start.item.id),
          );
          return;
        }

        const accepted = await controller.sendPromptImmediate(start.item.draft, {
          reason,
          expectedSessionKey: drainSessionKey,
        });
        const result = resolveQueueDrainCompletionAction({
          accepted,
          currentSessionKey: deps.sessionKeys.currentSessionQueueKey(),
          drainSessionKey,
          drainSessionId: deps.sessionKeys.sessionIdForQueueKey(drainSessionKey),
          queuedDraftSessionKey: deps.queue.resolveQueueKeyForQueuedDraft(
            drainSessionKey,
            start.item.id,
          ),
        });
        if (result.kind === "remove") {
          deps.queue.updateQueueForSessionKey(
            result.sessionKey,
            (queue) => removeQueuedDraft(queue, start.item.id),
          );
        } else if (result.kind === "mark-queued") {
          deps.queue.updateQueueForSessionKey(
            result.sessionKey,
            (queue) => markQueuedDraftQueued(queue, start.item.id),
          );
        } else {
          deps.queue.updateQueueForSessionKey(
            result.sessionKey,
            (queue) =>
              markQueuedDraftError(
                queue,
                start.item.id,
                deps.runtime.error() ?? deps.feedback.tr("session.connect_server_to_attach"),
              ),
          );
        }
      } finally {
        queueDrainAttemptInFlightBySessionKey.delete(drainSessionKey);
      }
    },
  };
  return controller;
}

export type RunBaseline = {
  assistantId: string | null;
  partCount: number;
};

export type RunUiState = {
  startedAt: number | null;
  hasBegun: boolean;
  tick: number;
  lastProgressAt: number | null;
  baseline: RunBaseline;
};

export const EMPTY_RUN_STATE: RunUiState = {
  startedAt: null,
  hasBegun: false,
  tick: 0,
  lastProgressAt: null,
  baseline: {
    assistantId: null,
    partCount: 0,
  },
};

export const createIdleRunState = (tick = 0): RunUiState => ({
  startedAt: null,
  hasBegun: false,
  tick,
  lastProgressAt: null,
  baseline: {
    assistantId: null,
    partCount: 0,
  },
});

export const runUiStateEqual = (left: RunUiState, right: RunUiState) =>
  left.startedAt === right.startedAt &&
  left.hasBegun === right.hasBegun &&
  left.tick === right.tick &&
  left.lastProgressAt === right.lastProgressAt &&
  left.baseline.assistantId === right.baseline.assistantId &&
  left.baseline.partCount === right.baseline.partCount;

export const updateRunStateRecord = (
  current: Record<string, RunUiState>,
  sessionKey: string,
  update: (current: RunUiState) => RunUiState,
  tick = Date.now(),
) => {
  const key = sessionKey.trim();
  if (!key) return current;
  const previous = current[key] ?? createIdleRunState(tick);
  const next = update(previous);
  if (runUiStateEqual(previous, next)) return current;
  return { ...current, [key]: next };
};

export const resetRunStateRecord = (
  current: Record<string, RunUiState>,
  sessionKey: string,
) => {
  const key = sessionKey.trim();
  if (!key || !(key in current)) return current;
  const { [key]: _removedRunState, ...rest } = current;
  return rest;
};

export const remapPendingRunStateToSession = (
  current: Record<string, RunUiState>,
  pendingKey: string,
  sessionKey: string,
) => {
  const pending = pendingKey.trim();
  const real = sessionKey.trim();
  if (!pending || !real || pending === real) return current;
  const pendingRun = current[pending];
  if (!pendingRun) return current;
  const { [pending]: _removedPendingRunState, ...rest } = current;
  return {
    ...rest,
    [real]: pendingRun,
  };
};

export const remapPendingQueueToSession = <T>(
  current: Record<string, T[]>,
  pendingKey: string,
  sessionKey: string,
) => {
  const pending = pendingKey.trim();
  const real = sessionKey.trim();
  if (!pending || !real || pending === real) return current;
  const pendingQueue = current[pending] ?? [];
  if (!pendingQueue.length) return current;
  const existingRealQueue = current[real] ?? [];
  const { [pending]: _removedPendingQueue, ...rest } = current;
  return {
    ...rest,
    [real]: [...existingRealQueue, ...pendingQueue],
  };
};

export const remapQueuePausedToSession = (
  current: Record<string, boolean>,
  pendingKey: string,
  sessionKey: string,
) => {
  const pending = pendingKey.trim();
  const real = sessionKey.trim();
  if (!pending || !real || pending === real || !(pending in current)) return current;
  const pendingPaused = Boolean(current[pending]);
  const { [pending]: _removedPendingPaused, ...rest } = current;
  return {
    ...rest,
    [real]: pendingPaused || Boolean(current[real]),
  };
};

export const restoreMaterializedQueueToPending = <T>(
  current: Record<string, T[]>,
  pendingKey: string,
  sessionKey: string,
) => {
  const pending = pendingKey.trim();
  const real = sessionKey.trim();
  if (!pending || !real || pending === real) return current;
  const materializedQueue = current[real] ?? [];
  if (!materializedQueue.length) return current;
  const existingPendingQueue = current[pending] ?? [];
  const { [real]: _removedMaterializedQueue, ...rest } = current;
  return {
    ...rest,
    [pending]: [...existingPendingQueue, ...materializedQueue],
  };
};

export const restoreQueuePausedToPending = (
  current: Record<string, boolean>,
  pendingKey: string,
  sessionKey: string,
) => {
  const pending = pendingKey.trim();
  const real = sessionKey.trim();
  if (!pending || !real || pending === real || !(real in current)) return current;
  const materializedPaused = Boolean(current[real]);
  const { [real]: _removedMaterializedPaused, ...rest } = current;
  return {
    ...rest,
    [pending]: materializedPaused || Boolean(current[pending]),
  };
};

export type SendPromptAction =
  | { kind: "save-edited-queued-draft"; editingId: string }
  | { kind: "send-edited-queued-draft-now"; editingId: string }
  | { kind: "replace-transcript-message"; messageId: string }
  | { kind: "append-to-paused-queue-and-drain" }
  | { kind: "append-to-existing-queue-and-drain-if-idle" }
  | { kind: "append-to-running-queue" }
  | { kind: "send-now" }
  | { kind: "send-normal" };

export type ResolveSendPromptActionInput = {
  sendNow: boolean;
  editingQueuedDraftId: string | null;
  editingTranscriptMessageId: string | null;
  queuePaused: boolean;
  queuedDraftCount: number;
  runVisible: boolean;
};

export const resolveSendPromptAction = ({
  sendNow,
  editingQueuedDraftId,
  editingTranscriptMessageId,
  queuePaused,
  queuedDraftCount,
  runVisible,
}: ResolveSendPromptActionInput): SendPromptAction => {
  const editingId = editingQueuedDraftId?.trim() || null;
  if (editingId) {
    return sendNow
      ? { kind: "send-edited-queued-draft-now", editingId }
      : { kind: "save-edited-queued-draft", editingId };
  }

  const transcriptMessageId = editingTranscriptMessageId?.trim() || null;
  if (transcriptMessageId) {
    return { kind: "replace-transcript-message", messageId: transcriptMessageId };
  }

  if (queuePaused && !sendNow) return { kind: "append-to-paused-queue-and-drain" };
  if (queuedDraftCount > 0 && !sendNow) return { kind: "append-to-existing-queue-and-drain-if-idle" };
  if (runVisible && !sendNow) return { kind: "append-to-running-queue" };
  if (sendNow) return { kind: "send-now" };
  return { kind: "send-normal" };
};

export type QueueDrainStart<T> =
  | { kind: "skip"; reason: "empty-session-key" | "in-flight" | "paused" | "empty-queue" }
  | { kind: "send"; drainSessionKey: string; item: T };

export type ResolveQueueDrainStartInput<T> = {
  sessionKey: string;
  inFlight: boolean;
  queuePaused: boolean;
  item: T | null | undefined;
};

export const resolveQueueDrainStart = <T>({
  sessionKey,
  inFlight,
  queuePaused,
  item,
}: ResolveQueueDrainStartInput<T>): QueueDrainStart<T> => {
  const drainSessionKey = sessionKey.trim();
  if (!drainSessionKey) return { kind: "skip", reason: "empty-session-key" };
  if (inFlight) return { kind: "skip", reason: "in-flight" };
  if (queuePaused) return { kind: "skip", reason: "paused" };
  if (!item) return { kind: "skip", reason: "empty-queue" };
  return { kind: "send", drainSessionKey, item };
};

export type QueueDrainCompletionAction =
  | { kind: "remove"; sessionKey: string }
  | { kind: "mark-queued"; sessionKey: string }
  | { kind: "mark-error"; sessionKey: string };

export type ResolveQueueDrainCompletionActionInput = {
  accepted: boolean;
  currentSessionKey: string;
  drainSessionKey: string;
  drainSessionId: string | null;
  queuedDraftSessionKey: string;
};

export const shouldRestoreQueuedDraftForStalePendingDrain = ({
  currentSessionKey,
  drainSessionKey,
  drainSessionId,
}: Pick<
  ResolveQueueDrainCompletionActionInput,
  "currentSessionKey" | "drainSessionKey" | "drainSessionId"
>) => currentSessionKey !== drainSessionKey && !drainSessionId;

export const resolveQueueDrainCompletionAction = ({
  accepted,
  currentSessionKey,
  drainSessionKey,
  drainSessionId,
  queuedDraftSessionKey,
}: ResolveQueueDrainCompletionActionInput): QueueDrainCompletionAction => {
  if (accepted) return { kind: "remove", sessionKey: queuedDraftSessionKey };
  if (shouldRestoreQueuedDraftForStalePendingDrain({ currentSessionKey, drainSessionKey, drainSessionId })) {
    return { kind: "mark-queued", sessionKey: queuedDraftSessionKey };
  }
  return { kind: "mark-error", sessionKey: queuedDraftSessionKey };
};
