import {
  GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
} from "../lib/pending-session-drafts";
import {
  normalizeSessionSendCorrelation,
  type MaterializedSessionHandoff,
  type SessionSendOptionsBase,
} from "../lib/session-send-contract";
import type {
  StagedSessionAttachment,
} from "../lib/attachment-prompt-routing";
import type {
  VesloConversationRunInput,
  VesloConversationSubmitRequest,
  VesloConversationSubmitResult,
  VesloServerClient,
} from "../lib/veslo-server";
import {
  documentRuntimeTaskBlockReason,
  type DocumentRuntimeFormat,
  type DocumentRuntimeStatusPayload,
} from "../lib/document-runtime";
import type {
  DisplayedConversationGuard,
  SendTargetWorkspaceScope,
} from "../context/workspace-session-selection";
import type {
  SendRuntimePreparationResult,
  SendRuntimePreflightContext,
  SendRuntimePreflightTargetWorkspace,
} from "../context/send-runtime-readiness";
import { shouldRecoverLocalRuntimeFromHealthError } from "../context/send-runtime-readiness";
import type { SessionFlowProgressEvent } from "../context/session-flow-progress-presenter";
import type {
  ConversationAbortTarget,
  ConversationSendPreflightContext,
} from "../context/conversation-service";
import type { LiveTranscriptReadPolicyEvent } from "../context/live-transcript-read-policy";
import type { UiScopeToken } from "../lib/ui-conversation-scope";
import { deleteSessionComposerDraft } from "./session-composer-drafts";
import type {
  Client,
  ComposerDraft,
  ComposerPart,
  ModelRef,
  PendingSidebarSessionMetadata,
  ProviderListItem,
  View,
  WorkspaceDisplay,
} from "../types";

export type SessionSendWorkflowSendOptions = SessionSendOptionsBase & {
  targetSessionId?: string | null;
  onMaterializedSessionId?: (handoff: MaterializedSessionHandoff) => void;
  pendingSession?: PendingSidebarSessionMetadata | null;
};

export type SessionSendWorkflowCommand = {
  id?: string;
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";
};

type ConversationSubmitDraftInput = VesloConversationSubmitRequest["draft"];
type ConversationSubmitOptionsInput = NonNullable<VesloConversationSubmitRequest["options"]>;

function conversationSubmitDraftFromComposerDraft(
  draft: ComposerDraft,
  stagedAttachments: StagedSessionAttachment[] = [],
): ConversationSubmitDraftInput {
  return {
    mode: draft.mode,
    text: draft.text,
    resolvedText: draft.resolvedText ?? null,
    parts: draft.parts,
    command: draft.command ?? null,
    attachments: draft.attachments.map((attachment, index) => ({
      name: attachment.name,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      dataUrl: attachment.dataUrl,
      fileSessionPath: stagedAttachments[index]?.relativePath ?? null,
    })),
  };
}

function conversationSubmitModelForAttachments(
  model: ModelRef,
  providers: ProviderListItem[],
  includeCapabilities: boolean,
): ConversationSubmitOptionsInput["model"] {
  if (!includeCapabilities) return model;
  const modelInfo = providers.find((provider) => provider.id === model.providerID)?.models?.[model.modelID];
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    ...(typeof modelInfo?.attachment === "boolean" ? { attachment: modelInfo.attachment } : {}),
    ...(modelInfo?.modalities ? { modalities: modelInfo.modalities } : {}),
  };
}

const DOCUMENT_RUNTIME_FORMAT_BY_SKILL_NAME = {
  "veslo-docx": "docx",
  "veslo-xlsx": "xlsx",
  "veslo-pdf": "pdf",
  "veslo-pptx": "pptx",
} satisfies Record<string, DocumentRuntimeFormat>;

export function documentRuntimeFormatForSkillCommand(skillName: string): DocumentRuntimeFormat | null {
  const key = skillName.trim();
  return Object.prototype.hasOwnProperty.call(DOCUMENT_RUNTIME_FORMAT_BY_SKILL_NAME, key)
    ? DOCUMENT_RUNTIME_FORMAT_BY_SKILL_NAME[key as keyof typeof DOCUMENT_RUNTIME_FORMAT_BY_SKILL_NAME]
    : null;
}

export function documentRuntimeBlockReasonForSkillCommand(
  status: DocumentRuntimeStatusPayload | null | undefined,
  skillName: string,
): string | null {
  const format = documentRuntimeFormatForSkillCommand(skillName);
  return format ? documentRuntimeTaskBlockReason(status, format) : null;
}

type SkillCommandResolutionResult = {
  draft: ComposerDraft;
  blockedReason?: string | null;
};

export type SessionSendWorkflowWorkspace = {
  activeWorkspaceDisplay: () => WorkspaceDisplay | { workspaceType?: string | null };
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  workspaces: () => WorkspaceDisplay[];
};

type NormalizedSessionSendCorrelation = ReturnType<typeof normalizeSessionSendCorrelation>;

type StartSendPromptBusy = (
  event: Extract<SessionFlowProgressEvent, { type: "runtime.connecting" | "conversation.running" }>,
) => void;

export type SessionSendPreflightContext =
  SendRuntimePreflightContext &
  ConversationSendPreflightContext<VesloServerClient>;

export type LegacyConversationRunFallbackPrepareInput = {
  cleanupPendingSidebarSession: () => void;
  sendPreflight: SessionSendPreflightContext;
  sendTargetWorkspace?: SendTargetWorkspaceScope | null;
  startSendPromptBusy: StartSendPromptBusy;
  stopSendPromptBusy: () => void;
  traceId: string;
};

export type LegacyConversationRunFallbackSubmitInput = {
  commandName: string | null;
  compactCommand: boolean;
  consumePendingDraftAfterAcceptedSend: (clearDisplayedPendingDraftState: boolean) => Promise<void>;
  draft: ComposerDraft;
  hasExplicitDraft: boolean;
  reportSendErrorToDisplayedTarget: (message: string) => void;
  restorePendingDraftAfterSendFailure: () => void;
  sendCorrelation: NormalizedSessionSendCorrelation;
  sendPreflight: SessionSendPreflightContext;
  sendTargetStillDisplayed: () => boolean;
  sendTargetWorkspace?: SendTargetWorkspaceScope | null;
  sessionID: string;
  startSendPromptBusy: StartSendPromptBusy;
  stopSendPromptBusy: () => void;
  traceId: string;
};

export type LegacyConversationRunFallback = {
  prepare: (input: LegacyConversationRunFallbackPrepareInput) => Promise<boolean>;
  submit: (input: LegacyConversationRunFallbackSubmitInput) => Promise<boolean>;
};

export type LegacyConversationRunFallbackOptions = {
  agentForSession: (sessionId: string | null | undefined) => string | null | undefined;
  buildCommandFileParts: (draft: ComposerDraft) => unknown[];
  buildPromptParts: (draft: ComposerDraft) => unknown[];
  compactCurrentSession: (sessionId?: string) => Promise<unknown>;
  developerMode: () => boolean;
  emitLiveTranscriptPolicyEvent: (event: LiveTranscriptReadPolicyEvent) => void;
  finishPerf: (
    enabled: boolean,
    scope: string,
    event: string,
    startedAt: number,
    payload?: Record<string, unknown>,
  ) => void;
  holdVisibleRuntimeActivity: (sessionId: string | null | undefined, reason: string) => void;
  isWorkspaceClientStaleError: (error: unknown) => error is {
    entryWorkspaceId?: string | null;
    currentWorkspaceId?: string | null;
  };
  isWorkspaceRuntimeReady: (workspaceId?: string | null) => boolean;
  messageFromUnknownError: (error: unknown) => string;
  messages: () => Array<{ parts: unknown[] }>;
  modelForSession: (sessionId: string | null | undefined) => ModelRef;
  modelVariant: () => string | null | undefined;
  perfNow: () => number;
  prepareSendRuntimeForSend: (event: "sendPrompt", preflight: SessionSendPreflightContext) => Promise<SendRuntimePreparationResult>;
  providers: () => ProviderListItem[];
  recordPerfLog: (
    enabled: boolean,
    scope: string,
    event: string,
    payload?: Record<string, unknown>,
  ) => void;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  resolveRuntimeSandboxStateForTarget: (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ) => unknown;
  resolveSelectedSessionBrowseScope: (sessionId: string) => {
    workspaceId?: string | null;
    workspaceRoot?: string | null;
    directory?: string | null;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
  } | null;
  routeStagedAttachmentsForModel: (input: {
    draft: ComposerDraft;
    stagedAttachments: StagedSessionAttachment[];
    model: ModelRef;
    providers: ProviderListItem[];
  }) => {
    draft: ComposerDraft;
    system?: string;
    error?: string;
  };
  routedClientForSendTarget: (targetWorkspace?: SendTargetWorkspaceScope | null) => Client | null;
  runConversationFromVesloWriteApi: (
    sessionId: string,
    input: VesloConversationRunInput,
    options?: {
      preflight?: SessionSendPreflightContext;
      targetWorkspace?: SendTargetWorkspaceScope | null;
    },
  ) => Promise<unknown>;
  safeStringify: (value: unknown) => string;
  sendTraceStep: <T>(
    event: string,
    run: () => Promise<T>,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
  sessionDirectoryOverrideById: () => Record<string, string | undefined>;
  sessionStoreClearCommandDisplay: (messageId: string) => void;
  sessionStoreSetCommandDisplay: (messageId: string, command: string, args: string) => void;
  setError: (message: string | null) => void;
  setLastPromptSent: (prompt: string) => void;
  setPrompt: (value: string) => void;
  stageAttachmentsIntoSessionDirectory: (
    draft: ComposerDraft,
    sessionId: string,
    preflight?: SessionSendPreflightContext,
  ) => Promise<StagedSessionAttachment[]>;
  workspace: SessionSendWorkflowWorkspace;
};

export type SessionSendWorkflowOptions = {
  abortConversationFromVesloWriteApi: (
    sessionId: string,
    target?: ConversationAbortTarget,
  ) => Promise<{
    workspaceId: string;
    conversationId: string;
    opencodeSessionId: string;
    runId?: string | null;
  } | null | undefined>;
  abortSessionTyped: (
    client: Client,
    sessionId: string,
    options?: { directory?: string },
  ) => Promise<unknown>;
  activePendingDraftKey: () => string | null | undefined;
  activePendingDraftMeta: () => { id?: string | null } | null | undefined;
  activeUiScopeToken: () => UiScopeToken;
  addOpencodeCacheHint: (message: string) => string;
  agentForSession: (sessionId: string | null | undefined) => string | null | undefined;
  busy: () => boolean;
  busyLabel: () => string | null | undefined;
  captureDisplayedConversationGuard: (sessionId: string) => DisplayedConversationGuard;
  clearActivePendingDraftState: () => void;
  clearConsumedPendingDraftId: (draftId: string) => void;
  composerDraft: () => ComposerDraft;
  createSendPreflightContext: (traceId?: string | null) => SessionSendPreflightContext;
  createSessionAndOpen: (
    initialTitle?: string,
    options?: {
      blockAppDuringCreate?: boolean;
      pendingSession?: PendingSidebarSessionMetadata | null;
      sendTraceId?: string | null;
      clientMessageId?: string | null;
      submitDraft?: ConversationSubmitDraftInput;
      submitOptions?: ConversationSubmitOptionsInput;
      submitOrigin?: string | null;
      submitSource?: string | null;
      onSubmitResult?: (result: VesloConversationSubmitResult) => void;
      onMaterializedSessionId?: (handoff: MaterializedSessionHandoff) => void;
      preflight?: SessionSendPreflightContext;
    },
  ) => Promise<string | undefined>;
  developerMode: () => boolean;
  documentRuntimeStatus?: () => DocumentRuntimeStatusPayload | null;
  displayedConversationStillMatches: (guard: DisplayedConversationGuard) => boolean;
  engineReady: () => boolean;
  ensureSelectedSessionWorkspaceActiveForSend: (
    sessionId: string,
    sendTraceId?: string | null,
  ) => Promise<boolean>;
  emitFlowProgress: (event: SessionFlowProgressEvent) => void;
  finishPerf: (
    enabled: boolean,
    scope: string,
    event: string,
    startedAt: number,
    payload?: Record<string, unknown>,
  ) => void;
  holdVisibleRuntimeActivity: (sessionId: string | null | undefined, reason: string) => void;
  isPendingSessionInstanceId: (sessionId: string | null | undefined) => boolean;
  isTauriRuntime: () => boolean;
  isUiScopeTokenCurrent: (token: UiScopeToken) => boolean;
  isWorkspaceClientStaleError: (error: unknown) => error is {
    entryWorkspaceId?: string | null;
    currentWorkspaceId?: string | null;
  };
  isWorkspaceRuntimeReady: (workspaceId?: string | null) => boolean;
  listCommands: (scope?: { workspaceId?: string | null; directory?: string | null }) => Promise<SessionSendWorkflowCommand[]>;
  emitLiveTranscriptPolicyEvent: (event: LiveTranscriptReadPolicyEvent) => void;
  markPendingDraftConsumed: (draftId: string) => void;
  messageFromUnknownError: (error: unknown) => string;
  messages: () => Array<{ parts: unknown[] }>;
  modelForSession: (sessionId: string | null | undefined) => ModelRef;
  modelVariant: () => string | null | undefined;
  pendingSessionDraftsDelete: (draftId: string) => Promise<boolean>;
  perfNow: () => number;
  providers: () => ProviderListItem[];
  recordPerfLog: (
    enabled: boolean,
    scope: string,
    event: string,
    payload?: Record<string, unknown>,
  ) => void;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  refreshPendingDraftSummaries: () => void;
  registerPendingSidebarSession: (pendingSession: PendingSidebarSessionMetadata) => void;
  releaseSendPromptInFlight?: () => void;
  removeSessionFromWorkspaceSidebar: (workspaceId: string, sessionId: string) => void;
  reportError: (error: unknown, context: string) => void;
  resolveConversationAbortScope: (
    sessionId: string,
    target?: ConversationAbortTarget,
  ) => {
    sessionId: string;
    workspaceId: string;
    workspaceRoot: string;
    directory?: string | null;
    hasConversationScope: boolean;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
  };
  resolveRuntimeSandboxStateForTarget: (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ) => unknown;
  resolveSelectedSessionBrowseScope: (sessionId: string) => {
    workspaceId?: string | null;
    workspaceRoot?: string | null;
    directory?: string | null;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
  } | null;
  resolveSendPromptBusyOwnership: (input: { sessionId: string | null | undefined }) => { ownsBusy: boolean };
  resolveSendTargetWorkspaceScope: (sessionId?: string | null) => SendTargetWorkspaceScope | null;
  resolvedDevtoolsWorkspaceId: () => string;
  routedClient: (workspaceId?: string | null) => Client | null;
  legacyConversationRunFallback: LegacyConversationRunFallback;
  submitConversationFromVesloWriteApi?: (
    workspaceId: string,
    directory: string,
    input: VesloConversationSubmitRequest,
    preflight?: SessionSendPreflightContext,
  ) => Promise<VesloConversationSubmitResult | null | undefined>;
  safeStringify: (value: unknown) => string;
  selectedSessionId: () => string | null | undefined;
  sendTraceStep: <T>(
    event: string,
    run: () => Promise<T>,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
  sessionStoreAppendSessionErrorTurn: (sessionId: string, message: string) => void;
  sessionStoreClearCommandDisplay: (messageId: string) => void;
  sessionStoreSetCommandDisplay: (messageId: string, command: string, args: string) => void;
  setActivePendingDraftKey: (key: string | null) => void;
  setActivePendingDraftMeta: (meta: unknown | null) => void;
  setComposerDraftBySessionId: (
    updater: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
  ) => void;
  setError: (message: string | null) => void;
  setLastPromptSent: (prompt: string) => void;
  setPrompt: (value: string) => void;
  setSelectedSessionId: (sessionId: string | null) => void;
  setView: (view: View) => void;
  stageServerSubmitAttachments: (
    draft: ComposerDraft,
    sessionId: string,
    preflight?: SessionSendPreflightContext,
  ) => Promise<StagedSessionAttachment[]>;
  startSendPromptInFlight?: () => (() => void) | null | undefined;
  vesloServerClient: () => ({ resolveSkill?: unknown } | null);
  vesloServerStatus: () => string;
  workspace: SessionSendWorkflowWorkspace;
};

export type SessionSendWorkflow = {
  sendPrompt: (draft: ComposerDraft, options: SessionSendWorkflowSendOptions) => Promise<boolean>;
  abortSession: (sessionId?: string, target?: ConversationAbortTarget) => Promise<void>;
};

export function createLegacyConversationRunFallback(
  deps: LegacyConversationRunFallbackOptions,
): LegacyConversationRunFallback {
  const prepare = async (input: LegacyConversationRunFallbackPrepareInput): Promise<boolean> => {
    const sendRuntimeWorkspaceId = input.sendTargetWorkspace?.workspaceId ?? deps.workspace.activeWorkspaceId().trim();
    const sendRuntimeReady = deps.isWorkspaceRuntimeReady(sendRuntimeWorkspaceId);
    if (!sendRuntimeReady) {
      input.startSendPromptBusy({ type: "runtime.connecting" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const sendRuntimePreparation = await deps.prepareSendRuntimeForSend("sendPrompt", input.sendPreflight);
    if (!sendRuntimePreparation.ok) {
      input.cleanupPendingSidebarSession();
      input.stopSendPromptBusy();
      return false;
    }
    input.sendPreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(input.sendTargetWorkspace);

    const c = deps.routedClientForSendTarget(input.sendTargetWorkspace);
    if (!c) {
      deps.recordSendTrace("sendPrompt:blocked-no-client", {
        traceId: input.traceId,
      });
      input.cleanupPendingSidebarSession();
      input.stopSendPromptBusy();
      return false;
    }
    return true;
  };

  const submit = async (input: LegacyConversationRunFallbackSubmitInput): Promise<boolean> => {
    let resolvedDraft = input.draft;
    const sessionID = input.sessionID;
    const materializedSessionID = input.sessionID;
    const model = deps.modelForSession(materializedSessionID);
    let promptSystem: string | undefined;

    try {
      const stagedAttachments = await deps.sendTraceStep(
        "sendPrompt:stage-attachments",
        () => deps.stageAttachmentsIntoSessionDirectory(resolvedDraft, materializedSessionID, input.sendPreflight),
        {
          traceId: input.traceId,
          sessionID,
          attachmentCount: resolvedDraft.attachments.length,
        },
      );
      const routedDraft = deps.routeStagedAttachmentsForModel({
        draft: resolvedDraft,
        stagedAttachments,
        model,
        providers: deps.providers(),
      });
      if (routedDraft.error) {
        deps.recordSendTrace("sendPrompt:staged-attachment-routing-error", {
          traceId: input.traceId,
          sessionID,
          message: routedDraft.error,
        });
        input.restorePendingDraftAfterSendFailure();
        if (input.sendTargetStillDisplayed()) {
          deps.setError(routedDraft.error);
        }
        input.stopSendPromptBusy();
        return false;
      }
      resolvedDraft = routedDraft.draft;
      promptSystem = routedDraft.system;
    } catch (error) {
      deps.recordSendTrace("sendPrompt:stage-attachments-error", {
        traceId: input.traceId,
        sessionID,
        message: deps.messageFromUnknownError(error),
      });
      input.restorePendingDraftAfterSendFailure();
      if (input.sendTargetStillDisplayed()) {
        deps.setError(error instanceof Error ? error.message : deps.safeStringify(error));
      }
      input.stopSendPromptBusy();
      return false;
    }

    const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!content && !resolvedDraft.attachments.length && !promptSystem) {
      deps.recordSendTrace("sendPrompt:blocked-empty-after-staging", {
        traceId: input.traceId,
        sessionID,
      });
      input.stopSendPromptBusy();
      return false;
    }

    input.startSendPromptBusy({ type: "conversation.running" });
    deps.setError(null);

    const perfEnabled = deps.developerMode();
    const startedAt = deps.perfNow();
    const visible = deps.messages();
    const visibleParts = visible.reduce((total, message) => total + message.parts.length, 0);
    let commandMessageIDToClear: string | null = null;
    deps.recordPerfLog(perfEnabled, "session.prompt", "start", {
      sessionID,
      mode: resolvedDraft.mode,
      command: input.commandName,
      charCount: content.length,
      attachmentCount: resolvedDraft.attachments.length,
      messageCount: visible.length,
      partCount: visibleParts,
    });

    try {
      if (!input.compactCommand) {
        deps.setLastPromptSent(content);
      }
      if (!input.hasExplicitDraft) {
        deps.setPrompt("");
      }

      const agent = deps.agentForSession(sessionID);
      const parts = deps.buildPromptParts(resolvedDraft);
      const selectedVariant = deps.modelVariant() ?? undefined;
      const promptOverrides = {
        ...(promptSystem ? { system: promptSystem } : {}),
      };

      const sessionDirOverride = deps.sessionDirectoryOverrideById()[materializedSessionID] ?? undefined;
      let localRuntimeRetryUsed = false;
      const runConversationOrFail = async (runInput: VesloConversationRunInput) => {
        const scope = deps.resolveSelectedSessionBrowseScope(materializedSessionID);
        const inputWithCorrelation: VesloConversationRunInput = {
          ...runInput,
          clientMessageId: input.sendCorrelation.clientMessageId,
          origin: input.sendCorrelation.origin,
        };
        const submitConversationRun = async () => deps.runConversationFromVesloWriteApi(
          materializedSessionID,
          inputWithCorrelation,
          {
            preflight: input.sendPreflight,
            targetWorkspace: input.sendTargetWorkspace,
          },
        );
        try {
          const result = await submitConversationRun();
          if (result) return;
          deps.recordSendTrace("sendPrompt:conversation-run-unavailable", {
            traceId: input.traceId,
            sessionID,
            kind: runInput.kind,
            clientMessageId: input.sendCorrelation.clientMessageId,
            origin: input.sendCorrelation.origin,
            hasConversationScope: Boolean(scope?.conversationId),
          });
          throw new Error("Conversation service is unavailable for this session.");
        } catch (error) {
          const recoverable = shouldRecoverLocalRuntimeFromHealthError(error, deps.safeStringify);
          deps.recordSendTrace("sendPrompt:conversation-run-error", {
            traceId: input.traceId,
            sessionID,
            kind: runInput.kind,
            clientMessageId: input.sendCorrelation.clientMessageId,
            origin: input.sendCorrelation.origin,
            hasConversationScope: Boolean(scope?.conversationId),
            message: deps.messageFromUnknownError(error),
            recoverable,
            retryUsed: localRuntimeRetryUsed,
          });
          if (recoverable && !localRuntimeRetryUsed && input.sendTargetStillDisplayed()) {
            localRuntimeRetryUsed = true;
            input.sendPreflight.forceRecovery = true;
            input.sendPreflight.runtimeHealthOk = false;
            input.sendPreflight.enginePrepared = false;
            deps.recordSendTrace("sendPrompt:conversation-run-runtime-recovery-start", {
              traceId: input.traceId,
              sessionID,
              kind: runInput.kind,
              clientMessageId: input.sendCorrelation.clientMessageId,
              origin: input.sendCorrelation.origin,
            });
            const recovery = await deps.prepareSendRuntimeForSend("sendPrompt", input.sendPreflight);
            deps.recordSendTrace("sendPrompt:conversation-run-runtime-recovery-result", {
              traceId: input.traceId,
              sessionID,
              kind: runInput.kind,
              ok: recovery.ok,
              reason: recovery.reason,
              recoveryAttempted: recovery.recoveryAttempted,
              clientMessageId: input.sendCorrelation.clientMessageId,
              origin: input.sendCorrelation.origin,
            });
            if (recovery.ok && input.sendTargetStillDisplayed()) {
              const retryResult = await submitConversationRun();
              if (retryResult) return;
            }
          }
          throw error;
        }
      };

      if (resolvedDraft.mode === "shell") {
        await runConversationOrFail({
          kind: "shell",
          directory: sessionDirOverride,
          command: content,
          model,
          agent: agent ?? undefined,
        });
      } else if (resolvedDraft.command || input.compactCommand) {
        if (input.compactCommand) {
          await deps.compactCurrentSession(sessionID);
          deps.finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
            sessionID,
            mode: resolvedDraft.mode,
            command: input.commandName,
          });
          deps.recordSendTrace("sendPrompt:compact-success", {
            traceId: input.traceId,
            sessionID,
          });
          deps.emitLiveTranscriptPolicyEvent({
            type: "conversation-compact.succeeded",
            reason: "sendPrompt:compact-success",
            workspaceId: input.sendTargetWorkspace?.workspaceId ?? deps.workspace.activeWorkspaceId().trim(),
            sessionId: sessionID,
            traceId: input.traceId,
          });
          return true;
        }

        const command = resolvedDraft.command;
        if (!command) {
          throw new Error("Command was not resolved.");
        }

        commandMessageIDToClear = input.sendCorrelation.clientMessageId;
        const commandMessageID = commandMessageIDToClear;
        deps.sessionStoreSetCommandDisplay(commandMessageID, command.name, command.arguments);
        const modelString = `${model.providerID}/${model.modelID}`;
        const files = deps.buildCommandFileParts(resolvedDraft);

        await runConversationOrFail({
          kind: "command",
          sessionID,
          messageID: commandMessageID,
          command: command.name,
          arguments: command.arguments,
          agent: agent ?? undefined,
          model: modelString,
          variant: selectedVariant,
          parts: files.length ? files : undefined,
          directory: sessionDirOverride,
        });
        commandMessageIDToClear = null;
      } else {
        await runConversationOrFail({
          kind: "prompt_async",
          directory: sessionDirOverride,
          model,
          agent: agent ?? undefined,
          variant: selectedVariant,
          ...promptOverrides,
          parts,
        });
      }
      await input.consumePendingDraftAfterAcceptedSend(input.sendTargetStillDisplayed());

      deps.finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: input.commandName,
      });
      deps.recordSendTrace("sendPrompt:success", {
        traceId: input.traceId,
        sessionID,
        clientMessageId: input.sendCorrelation.clientMessageId,
        origin: input.sendCorrelation.origin,
        mode: resolvedDraft.mode,
        command: input.commandName,
      });
      deps.emitLiveTranscriptPolicyEvent({
        type: "conversation-run.succeeded",
        reason: "sendPrompt:success",
        workspaceId: input.sendTargetWorkspace?.workspaceId ?? deps.workspace.activeWorkspaceId().trim(),
        sessionId: sessionID,
        traceId: input.traceId,
      });
      deps.holdVisibleRuntimeActivity(sessionID, "sendPrompt:success");
      return true;
    } catch (e) {
      input.restorePendingDraftAfterSendFailure();
      if (commandMessageIDToClear) {
        deps.sessionStoreClearCommandDisplay(commandMessageIDToClear);
      }
      if (deps.isWorkspaceClientStaleError(e)) {
        deps.recordSendTrace("sendPrompt:stale-client", {
          traceId: input.traceId,
          sessionID,
          clientMessageId: input.sendCorrelation.clientMessageId,
          origin: input.sendCorrelation.origin,
          entryWorkspaceId: e.entryWorkspaceId,
          currentWorkspaceId: e.currentWorkspaceId,
        });
        return false;
      }
      deps.finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: input.commandName,
        error: e instanceof Error ? e.message : deps.safeStringify(e),
      });
      const message = e instanceof Error ? e.message : deps.safeStringify(e);
      deps.recordSendTrace("sendPrompt:error", {
        traceId: input.traceId,
        sessionID,
        clientMessageId: input.sendCorrelation.clientMessageId,
        origin: input.sendCorrelation.origin,
        message,
      });
      input.reportSendErrorToDisplayedTarget(message);
      return false;
    } finally {
      input.stopSendPromptBusy();
    }
  };

  return { prepare, submit };
}

export function createSessionSendWorkflow(deps: SessionSendWorkflowOptions): SessionSendWorkflow {
  const legacyConversationRunFallback = deps.legacyConversationRunFallback;

  async function maybeResolveSkillCommand(
    draft: ComposerDraft,
    traceId?: string | null,
    targetWorkspace?: SendTargetWorkspaceScope | null,
  ): Promise<SkillCommandResolutionResult> {
    const tracePayload = traceId ? { traceId } : undefined;
    if (draft.mode !== "prompt" || draft.command) {
      deps.recordSendTrace("maybeResolveSkillCommand:skipped-mode-or-command", {
        ...(tracePayload ?? {}),
        mode: draft.mode,
        hasCommand: Boolean(draft.command),
      });
      return { draft };
    }

    const text = (draft.resolvedText ?? draft.text).trim();
    if (!text || text.startsWith("/")) {
      deps.recordSendTrace("maybeResolveSkillCommand:skipped-empty-or-slash", {
        ...(tracePayload ?? {}),
        hasText: Boolean(text),
        startsWithSlash: text.startsWith("/"),
      });
      return { draft };
    }

    const vesloClient = deps.vesloServerClient();
    const targetWorkspaceId = targetWorkspace?.workspaceId?.trim() || "";
    const workspaceId = targetWorkspaceId || deps.resolvedDevtoolsWorkspaceId();
    if (
      deps.vesloServerStatus() !== "connected" ||
      !vesloClient ||
      !workspaceId ||
      typeof vesloClient.resolveSkill !== "function"
    ) {
      deps.recordSendTrace("maybeResolveSkillCommand:skipped-veslo-server-unavailable", {
        ...(tracePayload ?? {}),
        vesloServerStatus: deps.vesloServerStatus(),
        hasClient: Boolean(vesloClient),
        hasWorkspaceId: Boolean(workspaceId),
        targetWorkspaceId: targetWorkspaceId || null,
      });
      return { draft };
    }

    try {
      const targetWorkspaceType = targetWorkspaceId
        ? (
            deps.workspace.workspaces().find((workspace) => workspace.id === targetWorkspaceId)?.workspaceType ??
            (deps.workspace.activeWorkspaceId().trim() === targetWorkspaceId
              ? deps.workspace.activeWorkspaceDisplay().workspaceType
              : undefined)
          )
        : deps.workspace.activeWorkspaceDisplay().workspaceType;
      const includeGlobal = targetWorkspaceType === "local";
      const resolution = await deps.sendTraceStep(
        "maybeResolveSkillCommand:resolve-skill",
        () => (vesloClient as {
          resolveSkill: (
            workspaceId: string,
            payload: { text: string; includeGlobal?: boolean },
          ) => Promise<{ match?: { name?: string | null } | null }>;
        }).resolveSkill(workspaceId, {
          text,
          includeGlobal,
        }),
        {
          ...(tracePayload ?? {}),
          workspaceId,
          targetWorkspaceId: targetWorkspaceId || null,
          workspaceType: targetWorkspaceType ?? null,
          includeGlobal,
          textLength: text.length,
        },
      );

      const matchedName = resolution?.match?.name?.trim();
      if (!matchedName) {
        deps.recordSendTrace("maybeResolveSkillCommand:no-match", tracePayload);
        return { draft };
      }

      const commandDirectory =
        targetWorkspace?.directory?.trim() ||
        targetWorkspace?.workspaceRoot?.trim() ||
        "";
      const commands = await deps.sendTraceStep(
        "maybeResolveSkillCommand:list-commands",
        () =>
          deps.listCommands(
            targetWorkspaceId
              ? {
                  workspaceId: targetWorkspaceId,
                  directory: commandDirectory,
                }
              : undefined,
          ),
        {
          ...(tracePayload ?? {}),
          matchedName,
          targetWorkspaceId: targetWorkspaceId || null,
          commandDirectory: commandDirectory || null,
        },
      );
      const matchedCommand = commands.find(
        (entry) => entry.name === matchedName && entry.source === "skill",
      );
      if (!matchedCommand) {
        deps.recordSendTrace("maybeResolveSkillCommand:matched-skill-command-missing", {
          ...(tracePayload ?? {}),
          matchedName,
          commandCount: commands.length,
        });
        return { draft };
      }

      const documentRuntimeBlockedReason = deps.documentRuntimeStatus
        ? documentRuntimeBlockReasonForSkillCommand(deps.documentRuntimeStatus(), matchedName)
        : null;
      if (documentRuntimeBlockedReason) {
        deps.recordSendTrace("maybeResolveSkillCommand:blocked-document-runtime", {
          ...(tracePayload ?? {}),
          matchedName,
          reason: documentRuntimeBlockedReason,
        });
        return { draft, blockedReason: documentRuntimeBlockedReason };
      }

      deps.recordSendTrace("maybeResolveSkillCommand:matched", {
        ...(tracePayload ?? {}),
        matchedName,
      });
      return {
        draft: {
          ...draft,
          command: {
            name: matchedName,
            arguments: text,
          },
        },
      };
    } catch (error) {
      deps.recordSendTrace("maybeResolveSkillCommand:error", {
        ...(tracePayload ?? {}),
        message: deps.messageFromUnknownError(error),
      });
      return { draft };
    }
  }

  async function sendPrompt(
    draft: ComposerDraft,
    options: SessionSendWorkflowSendOptions,
  ): Promise<boolean> {
    const sendCorrelation = normalizeSessionSendCorrelation(options);
    if (!sendCorrelation.clientMessageId) {
      deps.recordSendTrace("sendPrompt:blocked-missing-client-message-id", {
        origin: sendCorrelation.origin,
      });
      return false;
    }
    const sendPreflight = deps.createSendPreflightContext(options.sendTraceId);
    const sendTraceId = sendPreflight.traceId;
    const pendingSidebarSession = options.pendingSession ?? null;
    const sendStartUiScopeToken = deps.activeUiScopeToken();
    const selectedSessionCandidate = deps.selectedSessionId();
    const selectedSessionScopeForSend = selectedSessionCandidate
      ? deps.resolveSelectedSessionBrowseScope(selectedSessionCandidate)
      : null;
    const selectedSessionScopeWorkspaceId = selectedSessionScopeForSend?.workspaceId?.trim() ?? "";
    const activeWorkspaceIdForSend = deps.workspace.activeWorkspaceId().trim();
    const selectedSessionBelongsToActiveWorkspace =
      !selectedSessionScopeWorkspaceId ||
      !activeWorkspaceIdForSend ||
      selectedSessionScopeWorkspaceId === activeWorkspaceIdForSend;
    const selectedRealSessionId =
      deps.isPendingSessionInstanceId(selectedSessionCandidate) || !selectedSessionBelongsToActiveWorkspace
        ? null
        : selectedSessionCandidate;
    const explicitTargetSessionId = deps.isPendingSessionInstanceId(options.targetSessionId)
      ? ""
      : options.targetSessionId?.trim() ?? "";
    let sessionID = explicitTargetSessionId || selectedRealSessionId;
    const pendingSidebarTargetWorkspace = pendingSidebarSession?.workspaceId?.trim()
      ? {
          workspaceId: pendingSidebarSession.workspaceId.trim(),
          workspaceRoot: pendingSidebarSession.workspaceRoot.trim(),
          directory: pendingSidebarSession.workspaceRoot.trim(),
        }
      : null;
    deps.recordSendTrace("sendPrompt:start", {
      traceId: sendTraceId,
      uiSendTraceId: options.sendTraceId ?? null,
      clientMessageId: sendCorrelation.clientMessageId,
      origin: sendCorrelation.origin,
      engineReady: deps.engineReady(),
      selectedSessionId: selectedSessionCandidate,
      selectedSessionScopeWorkspaceId: selectedSessionScopeWorkspaceId || null,
      activeWorkspaceId: activeWorkspaceIdForSend || null,
      selectedSessionIgnoredForForeignWorkspace: Boolean(
        selectedSessionCandidate && !selectedSessionBelongsToActiveWorkspace && !explicitTargetSessionId,
      ),
      uiScopeKey: sendStartUiScopeToken.key,
      uiScopeWorkspaceId: sendStartUiScopeToken.workspaceId || null,
      uiScopeGeneration: sendStartUiScopeToken.generation,
      targetSessionId: options.targetSessionId ?? null,
      hasClient: Boolean(deps.routedClient()),
      busy: deps.busy(),
      busyLabel: deps.busyLabel(),
    });
    let sendTargetWorkspace = pendingSidebarTargetWorkspace ?? deps.resolveSendTargetWorkspaceScope(sessionID);
    sendPreflight.targetWorkspace = sendTargetWorkspace;
    sendPreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(sendTargetWorkspace);
    deps.recordSendTrace("sendPrompt:target-workspace-snapshot", {
      traceId: sendTraceId,
      sessionID: sessionID ?? null,
      workspaceId: sendTargetWorkspace?.workspaceId ?? null,
      workspaceRoot: sendTargetWorkspace?.workspaceRoot ?? null,
      directory: sendTargetWorkspace?.directory ?? null,
      clientMessageId: sendCorrelation.clientMessageId,
      origin: sendCorrelation.origin,
    });
    const sendPromptBusyOwnership = deps.resolveSendPromptBusyOwnership({ sessionId: sessionID });
    const blockAppDuringPromptSend = sendPromptBusyOwnership.ownsBusy;
    let ownsSendPromptBusy = false;
    let releaseSendPromptInFlight: (() => void) | null =
      deps.startSendPromptInFlight?.() ?? null;
    let sendPromptInFlightReleased = false;
    const releasePromptSendInFlight = () => {
      if (sendPromptInFlightReleased) return;
      sendPromptInFlightReleased = true;
      releaseSendPromptInFlight?.();
      deps.releaseSendPromptInFlight?.();
      releaseSendPromptInFlight = null;
    };
    const startSendPromptBusy = (
      event: Extract<SessionFlowProgressEvent, { type: "runtime.connecting" | "conversation.running" }>,
    ) => {
      if (!blockAppDuringPromptSend) return;
      ownsSendPromptBusy = true;
      deps.emitFlowProgress({ ...event, owner: "send" });
    };
    const stopSendPromptBusy = () => {
      releasePromptSendInFlight();
      if (!ownsSendPromptBusy) return;
      ownsSendPromptBusy = false;
      deps.emitFlowProgress({ type: "flow.idle", owner: "send" });
    };
    try {
    let pendingSidebarRowRegistered = false;
    const cleanupPendingSidebarSession = () => {
      if (!pendingSidebarRowRegistered || !pendingSidebarSession) return;
      pendingSidebarRowRegistered = false;
      deps.removeSessionFromWorkspaceSidebar(pendingSidebarSession.workspaceId, pendingSidebarSession.id);
      if (deps.selectedSessionId() === pendingSidebarSession.id) {
        deps.setSelectedSessionId(null);
      }
    };
    const hasExplicitDraft = Boolean(draft);
    const fallbackDraft = deps.composerDraft();
    const fallbackText = fallbackDraft.text.trim();
    const fallbackResolvedText = (fallbackDraft.resolvedText ?? fallbackDraft.text).trim();
    let resolvedDraft: ComposerDraft = draft ?? {
      mode: fallbackDraft.mode,
      parts: fallbackDraft.parts.length ? fallbackDraft.parts : (fallbackText ? [{ type: "text", text: fallbackText } as ComposerPart] : []),
      attachments: fallbackDraft.attachments,
      text: fallbackText,
      resolvedText: fallbackResolvedText || undefined,
      command: fallbackDraft.command,
    };

    const preflightContent = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!preflightContent && !resolvedDraft.attachments.length) {
      deps.recordSendTrace("sendPrompt:blocked-empty", {
        traceId: sendTraceId,
        phase: "initial-preflight",
      });
      return false;
    }

    const scopedSessionID = sessionID?.trim() || "";
    if (
      scopedSessionID &&
      !(await deps.sendTraceStep(
        "sendPrompt:ensure-scoped-workspace-active",
        () => deps.ensureSelectedSessionWorkspaceActiveForSend(scopedSessionID, sendTraceId),
        {
          traceId: sendTraceId,
          sessionID: scopedSessionID,
        },
      ))
    ) {
      deps.recordSendTrace("sendPrompt:blocked-scoped-workspace", {
        traceId: sendTraceId,
        sessionID: scopedSessionID,
      });
      stopSendPromptBusy();
      return false;
    }
    if (scopedSessionID) {
      sendTargetWorkspace = deps.resolveSendTargetWorkspaceScope(scopedSessionID) ?? sendTargetWorkspace;
      sendPreflight.targetWorkspace = sendTargetWorkspace;
      sendPreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(sendTargetWorkspace);
    }

    const shouldUseServerSubmitBeforeFrontendSkillResolution = Boolean(
      deps.submitConversationFromVesloWriteApi,
    );
    if (shouldUseServerSubmitBeforeFrontendSkillResolution) {
      deps.recordSendTrace("sendPrompt:maybe-resolve-skill-command:server-owned-skip", {
        traceId: sendTraceId,
        mode: resolvedDraft.mode,
        targetWorkspaceId: sendTargetWorkspace?.workspaceId ?? null,
      });
    } else {
      const skillResolution = await deps.sendTraceStep(
        "sendPrompt:maybe-resolve-skill-command",
        () => maybeResolveSkillCommand(resolvedDraft, sendTraceId, sendTargetWorkspace),
        {
          traceId: sendTraceId,
          mode: resolvedDraft.mode,
          targetWorkspaceId: sendTargetWorkspace?.workspaceId ?? null,
        },
      );
      if (skillResolution.blockedReason) {
        deps.setError(skillResolution.blockedReason);
        deps.recordSendTrace("sendPrompt:blocked-document-runtime", {
          traceId: sendTraceId,
          reason: skillResolution.blockedReason,
        });
        return false;
      }
      resolvedDraft = skillResolution.draft;
    }

    const initialSessionTitle = resolvedDraft.text.trim();
    const initialContent = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!initialContent && !resolvedDraft.attachments.length) {
      deps.recordSendTrace("sendPrompt:blocked-empty", {
        traceId: sendTraceId,
        phase: "after-skill-resolution",
      });
      return false;
    }
    if (!sessionID && pendingSidebarSession) {
      deps.registerPendingSidebarSession(pendingSidebarSession);
      pendingSidebarRowRegistered = true;
    }

    const compactShortcut = /^\/compact(?:\s+.*)?$/i.test(initialContent);
    const compactCommand = resolvedDraft.command?.name === "compact" || compactShortcut;
    const commandName = compactCommand ? "compact" : (resolvedDraft.command?.name ?? null);
    if (compactCommand && !sessionID) {
      deps.recordSendTrace("sendPrompt:blocked-compact-no-session", {
        traceId: sendTraceId,
      });
      deps.setError("Select a session with messages before running /compact.");
      cleanupPendingSidebarSession();
      return false;
    }

    const hadExistingSessionBeforeMaterialization = Boolean(sessionID?.trim());
    const submitExistingSessionWithServer = async (): Promise<boolean | null> => {
      const submitConversation = deps.submitConversationFromVesloWriteApi;
      const existingSessionId = sessionID?.trim() || "";
      if (!submitConversation || !existingSessionId || !hadExistingSessionBeforeMaterialization) return null;

      const displayedConversationGuard = deps.captureDisplayedConversationGuard(existingSessionId);
      const displayedUiScopeToken = deps.activeUiScopeToken();
      const sendTargetStillDisplayed = () =>
        deps.displayedConversationStillMatches(displayedConversationGuard) &&
        deps.isUiScopeTokenCurrent(displayedUiScopeToken);
      const reportServerSubmitError = (message: string) => {
        if (!sendTargetStillDisplayed()) return;
        const hintedMessage = deps.addOpencodeCacheHint(message);
        deps.setError(hintedMessage);
        deps.sessionStoreAppendSessionErrorTurn(existingSessionId, hintedMessage);
      };
      const workspaceId = sendTargetWorkspace?.workspaceId?.trim() || deps.workspace.activeWorkspaceId().trim();
      const directory =
        sendTargetWorkspace?.directory?.trim() ||
        sendTargetWorkspace?.workspaceRoot?.trim() ||
        deps.workspace.activeWorkspaceRoot().trim();
      if (!workspaceId || !directory) {
        const message = "Server-owned conversation submit is missing a workspace or directory for this local session.";
        deps.recordSendTrace("sendPrompt:server-submit-existing-missing-target", {
          traceId: sendTraceId,
          sessionID: existingSessionId,
          workspaceId: workspaceId || null,
          directory: directory || null,
        });
        reportServerSubmitError(message);
        return false;
      }

      const scope = deps.resolveSelectedSessionBrowseScope(existingSessionId);
      const conversationId = scope?.conversationId?.trim() || null;
      const opencodeSessionId = scope?.opencodeSessionId?.trim() || existingSessionId;
      const model = deps.modelForSession(existingSessionId);
      const agent = deps.agentForSession(existingSessionId);
      const selectedVariant = deps.modelVariant() ?? undefined;
      const command = compactCommand ? null : resolvedDraft.command;
      let commandMessageIDToClear: string | null = null;
      if (command) {
        commandMessageIDToClear = sendCorrelation.clientMessageId;
        deps.sessionStoreSetCommandDisplay(commandMessageIDToClear, command.name, command.arguments);
      }

      const perfEnabled = deps.developerMode();
      const startedAt = deps.perfNow();
      const visible = deps.messages();
      if (compactCommand && !visible.length) {
        deps.recordSendTrace("sendPrompt:blocked-compact-empty", {
          traceId: sendTraceId,
          sessionID: existingSessionId,
        });
        deps.setError("Nothing to compact yet.");
        return false;
      }
      const visibleParts = visible.reduce((total, message) => total + message.parts.length, 0);
      startSendPromptBusy({ type: "conversation.running" });
      deps.setError(null);
      let stagedAttachments: StagedSessionAttachment[] = [];
      if (resolvedDraft.attachments.length > 0) {
        try {
          deps.recordSendTrace("sendPrompt:server-submit-existing-stage-attachments", {
            traceId: sendTraceId,
            sessionID: existingSessionId,
            clientMessageId: sendCorrelation.clientMessageId,
            origin: sendCorrelation.origin,
            attachmentCount: resolvedDraft.attachments.length,
          });
          stagedAttachments = await deps.sendTraceStep(
            "sendPrompt:server-submit-existing-stage-attachments",
            () => deps.stageServerSubmitAttachments(resolvedDraft, existingSessionId, sendPreflight),
            {
              traceId: sendTraceId,
              sessionID: existingSessionId,
              attachmentCount: resolvedDraft.attachments.length,
            },
          );
          deps.recordSendTrace("sendPrompt:server-submit-existing-stage-attachments-done", {
            traceId: sendTraceId,
            sessionID: existingSessionId,
            clientMessageId: sendCorrelation.clientMessageId,
            origin: sendCorrelation.origin,
            attachmentCount: stagedAttachments.length,
          });
        } catch (error) {
          if (commandMessageIDToClear) deps.sessionStoreClearCommandDisplay(commandMessageIDToClear);
          const message = deps.messageFromUnknownError(error);
          deps.finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
            sessionID: existingSessionId,
            mode: resolvedDraft.mode,
            command: commandName,
            error: message,
            serverSubmit: true,
            phase: "stage-attachments",
          });
          deps.recordSendTrace("sendPrompt:server-submit-existing-stage-attachments-error", {
            traceId: sendTraceId,
            sessionID: existingSessionId,
            clientMessageId: sendCorrelation.clientMessageId,
            origin: sendCorrelation.origin,
            message,
          });
          reportServerSubmitError(message);
          return false;
        }
      }
      const submitModel = conversationSubmitModelForAttachments(
        model,
        deps.providers(),
        resolvedDraft.attachments.length > 0,
      );
      deps.recordPerfLog(perfEnabled, "session.prompt", "start", {
        sessionID: existingSessionId,
        mode: resolvedDraft.mode,
        command: commandName,
        charCount: initialContent.length,
        attachmentCount: resolvedDraft.attachments.length,
        messageCount: visible.length,
        partCount: visibleParts,
        serverSubmit: true,
      });
      deps.recordSendTrace("sendPrompt:server-submit-existing:start", {
        traceId: sendTraceId,
        sessionID: existingSessionId,
        workspaceId,
        directory,
        conversationId,
        opencodeSessionId,
        clientMessageId: sendCorrelation.clientMessageId,
        origin: sendCorrelation.origin,
        mode: resolvedDraft.mode,
        command: commandName,
        attachmentCount: resolvedDraft.attachments.length,
      });

      let result: VesloConversationSubmitResult | null | undefined;
      try {
        result = await deps.sendTraceStep(
          "sendPrompt:server-submit-existing",
          () => submitConversation(
            workspaceId,
            directory,
            {
              clientMessageId: sendCorrelation.clientMessageId,
              origin: sendCorrelation.origin,
              source: sendCorrelation.source ?? null,
              target: {
                directory,
                conversationId,
                opencodeSessionId,
              },
              draft: conversationSubmitDraftFromComposerDraft(resolvedDraft, stagedAttachments),
              options: {
                model: submitModel,
                agent: agent ?? null,
                variant: selectedVariant ?? null,
                submitQueuePolicy: sendCorrelation.origin === "session:send-now"
                  ? "send-now"
                  : sendCorrelation.origin === "session:queue-drain"
                    ? "server-queue-only"
                    : "normal",
              },
            },
            sendPreflight,
          ),
          {
            traceId: sendTraceId,
            sessionID: existingSessionId,
            workspaceId,
            directory,
            clientMessageId: sendCorrelation.clientMessageId,
            origin: sendCorrelation.origin,
          },
        );
      } catch (error) {
        if (commandMessageIDToClear) deps.sessionStoreClearCommandDisplay(commandMessageIDToClear);
        const message = deps.messageFromUnknownError(error);
        deps.finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
          sessionID: existingSessionId,
          mode: resolvedDraft.mode,
          command: commandName,
          error: message,
          serverSubmit: true,
        });
        deps.recordSendTrace("sendPrompt:server-submit-existing:error", {
          traceId: sendTraceId,
          sessionID: existingSessionId,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
          message,
        });
        reportServerSubmitError(message);
        return false;
      }

      if (!result) {
        if (commandMessageIDToClear) deps.sessionStoreClearCommandDisplay(commandMessageIDToClear);
        const message = "Server-owned conversation submit is unavailable for this local session.";
        deps.finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
          sessionID: existingSessionId,
          mode: resolvedDraft.mode,
          command: commandName,
          error: message,
          serverSubmit: true,
          phase: "submit-unavailable",
        });
        deps.recordSendTrace("sendPrompt:server-submit-existing-unavailable", {
          traceId: sendTraceId,
          sessionID: existingSessionId,
          workspaceId,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
        });
        reportServerSubmitError(message);
        return false;
      }

      if (result.status === "blocked" || result.status === "failed") {
        if (commandMessageIDToClear) deps.sessionStoreClearCommandDisplay(commandMessageIDToClear);
        deps.finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
          sessionID: existingSessionId,
          mode: resolvedDraft.mode,
          command: commandName,
          error: result.message,
          serverSubmit: true,
          status: result.status,
          code: result.code,
        });
        deps.recordSendTrace(`sendPrompt:server-submit-existing-${result.status}`, {
          traceId: sendTraceId,
          sessionID: existingSessionId,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
          code: result.code,
          draftDisposition: result.draftDisposition,
          message: result.message,
        });
        if (result.status === "failed") {
          reportServerSubmitError(result.message);
        } else if (sendTargetStillDisplayed()) {
          deps.setError(result.message);
        }
        return false;
      }

      if (result.status !== "submitted" && result.status !== "queued") {
        if (commandMessageIDToClear) deps.sessionStoreClearCommandDisplay(commandMessageIDToClear);
        const message = `Conversation submit returned ${result.status} for an existing session.`;
        deps.finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
          sessionID: existingSessionId,
          mode: resolvedDraft.mode,
          command: commandName,
          error: message,
          serverSubmit: true,
        });
        deps.recordSendTrace("sendPrompt:server-submit-existing-unexpected-result", {
          traceId: sendTraceId,
          sessionID: existingSessionId,
          status: result.status,
        });
        reportServerSubmitError(message);
        return false;
      }

      if (result.draftDisposition === "clear") {
        if (!compactCommand) {
          deps.setLastPromptSent(initialContent);
        }
        if (!hasExplicitDraft) {
          deps.setPrompt("");
        }
      }
      deps.finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
        sessionID: existingSessionId,
        mode: resolvedDraft.mode,
        command: commandName,
        serverSubmit: true,
        status: result.status,
      });
      deps.recordSendTrace("sendPrompt:server-submit-existing-success", {
        traceId: sendTraceId,
        sessionID: existingSessionId,
        clientMessageId: sendCorrelation.clientMessageId,
        origin: sendCorrelation.origin,
        status: result.status,
        runId: result.status === "submitted" ? result.runId : result.reservedRunId,
        queueItemId: result.status === "queued" ? result.queueItemId : null,
        draftDisposition: result.draftDisposition,
      });
      if (compactCommand) {
        deps.recordSendTrace("sendPrompt:compact-success", {
          traceId: sendTraceId,
          sessionID: existingSessionId,
          serverSubmit: true,
        });
      }
      if (compactCommand) {
        deps.emitLiveTranscriptPolicyEvent({
          type: "conversation-compact.succeeded",
          reason: "sendPrompt:compact-success",
          workspaceId,
          sessionId: existingSessionId,
          traceId: sendTraceId,
        });
      } else {
        deps.emitLiveTranscriptPolicyEvent({
          type: "conversation-run.succeeded",
          reason: "sendPrompt:success",
          workspaceId,
          sessionId: existingSessionId,
          traceId: sendTraceId,
        });
      }
      deps.holdVisibleRuntimeActivity(
        existingSessionId,
        compactCommand ? "sendPrompt:server-submit-existing-compact-success" : "sendPrompt:server-submit-existing-success",
      );
      return true;
    };
    const serverSubmitExistingSessionResult = await submitExistingSessionWithServer();
    if (serverSubmitExistingSessionResult !== null) {
      return serverSubmitExistingSessionResult;
    }

    const shouldUseServerSubmitForFirstSession = Boolean(
      !sessionID &&
      deps.submitConversationFromVesloWriteApi,
    );
    if (shouldUseServerSubmitForFirstSession) {
      deps.recordSendTrace("sendPrompt:runtime-preflight:server-submit-first-skip", {
        traceId: sendTraceId,
        targetWorkspaceId: sendTargetWorkspace?.workspaceId ?? null,
      });
    } else {
      if (!(await legacyConversationRunFallback.prepare({
        cleanupPendingSidebarSession,
        sendPreflight,
        sendTargetWorkspace,
        startSendPromptBusy,
        stopSendPromptBusy,
        traceId: sendTraceId,
      }))) {
        return false;
      }
    }

    const pendingDraftSendState = (() => {
      const pendingDraftKey = (deps.activePendingDraftKey() ?? "").trim();
      if (sessionID) return null;
      if (!pendingDraftKey) return null;
      const pendingDraftMeta = deps.activePendingDraftMeta();
      return {
        key: pendingDraftKey,
        meta: pendingDraftMeta,
        draftId: pendingDraftMeta?.id?.trim() || GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
      };
    })();
    const consumePendingDraftAfterAcceptedSend = async (clearDisplayedPendingDraftState: boolean) => {
      if (!pendingDraftSendState) return;
      const pendingDraftStorageKey = pendingDraftSendState.key;
      const pendingDraftId = pendingDraftSendState.draftId;
      if (pendingDraftId && deps.isTauriRuntime()) {
        try {
          const deleted = await deps.pendingSessionDraftsDelete(pendingDraftId);
          if (!deleted) {
            deps.markPendingDraftConsumed(pendingDraftId);
            console.warn("[pendingDrafts.consume] failed to delete pending draft", { pendingDraftId });
          } else {
            deps.clearConsumedPendingDraftId(pendingDraftId);
          }
        } catch (error) {
          deps.markPendingDraftConsumed(pendingDraftId);
          deps.reportError(error, "pendingDrafts.consume");
        }
      }
      if (clearDisplayedPendingDraftState) {
        deps.clearActivePendingDraftState();
      }
      deps.setComposerDraftBySessionId((current) => deleteSessionComposerDraft(current, {
        storageKey: pendingDraftStorageKey,
      }));
      deps.refreshPendingDraftSummaries();
    };
    const serverSubmitMaterializationDraft = (() => {
      if (!deps.submitConversationFromVesloWriteApi) return undefined;
      return conversationSubmitDraftFromComposerDraft(resolvedDraft);
    })();
    const serverSubmitMaterializationOptions = serverSubmitMaterializationDraft
      ? {
          model: conversationSubmitModelForAttachments(
            deps.modelForSession(sessionID),
            deps.providers(),
            resolvedDraft.attachments.length > 0,
          ),
          agent: sessionID ? (deps.agentForSession(sessionID) ?? null) : null,
          variant: deps.modelVariant() ?? null,
        } satisfies ConversationSubmitOptionsInput
      : undefined;
    const serverFirstSubmitResultHolder: {
      current: Extract<VesloConversationSubmitResult, { status: "submitted" | "queued" }> | null;
    } = { current: null };
    if (!sessionID) {
      deps.recordSendTrace("sendPrompt:create-session-needed", {
        traceId: sendTraceId,
      });
      const createdSessionId = await deps.sendTraceStep(
        "sendPrompt:create-session-and-open",
        () => deps.createSessionAndOpen(initialSessionTitle, {
          blockAppDuringCreate: blockAppDuringPromptSend,
          pendingSession: pendingSidebarSession,
          sendTraceId,
          clientMessageId: sendCorrelation.clientMessageId,
          submitDraft: serverSubmitMaterializationDraft,
          submitOptions: serverSubmitMaterializationOptions,
          submitOrigin: sendCorrelation.origin,
          submitSource: sendCorrelation.source,
          onSubmitResult: (result) => {
            if (result.status === "submitted" || result.status === "queued") {
              serverFirstSubmitResultHolder.current = result;
            }
          },
          onMaterializedSessionId: options.onMaterializedSessionId,
          preflight: sendPreflight,
        }),
        {
          traceId: sendTraceId,
          blockAppDuringCreate: blockAppDuringPromptSend,
          targetWorkspaceId: sendTargetWorkspace?.workspaceId ?? null,
          targetWorkspaceRoot: sendTargetWorkspace?.workspaceRoot ?? null,
        },
      );
      const materializedSessionId = createdSessionId?.trim();
      if (materializedSessionId) {
        sessionID = materializedSessionId;
        pendingSidebarRowRegistered = false;
      } else {
        deps.recordSendTrace("sendPrompt:create-session-missing-result", {
          traceId: sendTraceId,
        });
        cleanupPendingSidebarSession();
        sessionID = null;
      }
    }
    if (!sessionID) {
      deps.recordSendTrace("sendPrompt:blocked-no-session", {
        traceId: sendTraceId,
      });
      cleanupPendingSidebarSession();
      stopSendPromptBusy();
      return false;
    }

    const serverFirstSubmitResult = serverFirstSubmitResultHolder.current;
    if (serverFirstSubmitResult) {
      if (serverFirstSubmitResult.draftDisposition === "clear") {
        deps.setLastPromptSent(initialContent);
        if (!hasExplicitDraft) {
          deps.setPrompt("");
        }
      }
      deps.recordSendTrace("sendPrompt:server-submit-first-success", {
        traceId: sendTraceId,
        sessionID,
        clientMessageId: sendCorrelation.clientMessageId,
        origin: sendCorrelation.origin,
        status: serverFirstSubmitResult.status,
        runId: serverFirstSubmitResult.status === "submitted"
          ? serverFirstSubmitResult.runId
          : serverFirstSubmitResult.reservedRunId,
        queueItemId: serverFirstSubmitResult.status === "queued" ? serverFirstSubmitResult.queueItemId : null,
        draftDisposition: serverFirstSubmitResult.draftDisposition,
      });
      deps.emitLiveTranscriptPolicyEvent({
        type: "conversation-run.succeeded",
        reason: "sendPrompt:success",
        workspaceId: serverFirstSubmitResult.workspaceId,
        sessionId: sessionID,
        traceId: sendTraceId,
      });
      await consumePendingDraftAfterAcceptedSend(true);
      deps.holdVisibleRuntimeActivity(sessionID, "sendPrompt:server-submit-first-success");
      return true;
    }

    if (shouldUseServerSubmitForFirstSession) {
      const message = "Server-owned conversation submit did not return a queued or submitted result.";
      deps.recordSendTrace("sendPrompt:server-submit-first-missing-result", {
        traceId: sendTraceId,
        sessionID,
        clientMessageId: sendCorrelation.clientMessageId,
        origin: sendCorrelation.origin,
      });
      deps.setError(message);
      stopSendPromptBusy();
      return false;
    }

    const materializedSessionID: string = sessionID;

    const displayedConversationGuard = deps.captureDisplayedConversationGuard(materializedSessionID);
    const displayedUiScopeToken = deps.activeUiScopeToken();
    const sendTargetStillDisplayed = () =>
      deps.displayedConversationStillMatches(displayedConversationGuard) && deps.isUiScopeTokenCurrent(displayedUiScopeToken);
    const reportSendErrorToDisplayedTarget = (message: string) => {
      if (!sendTargetStillDisplayed()) {
        deps.recordSendTrace("sendPrompt:error-skipped-stale-display", {
          traceId: sendTraceId,
          sessionID: materializedSessionID,
          message,
        });
        return;
      }
      const hintedMessage = deps.addOpencodeCacheHint(message);
      deps.setError(hintedMessage);
      deps.sessionStoreAppendSessionErrorTurn(materializedSessionID, hintedMessage);
    };
    const restorePendingDraftAfterSendFailure = () => {
      if (!sendTargetStillDisplayed()) return;
      if (pendingDraftSendState) {
        deps.setActivePendingDraftKey(pendingDraftSendState.key);
        deps.setActivePendingDraftMeta(pendingDraftSendState.meta);
        deps.setView("session");
      }
    };

    return await legacyConversationRunFallback.submit({
      commandName,
      compactCommand,
      consumePendingDraftAfterAcceptedSend,
      draft: resolvedDraft,
      hasExplicitDraft,
      reportSendErrorToDisplayedTarget,
      restorePendingDraftAfterSendFailure,
      sendCorrelation,
      sendPreflight,
      sendTargetStillDisplayed,
      sendTargetWorkspace,
      sessionID: materializedSessionID,
      startSendPromptBusy,
      stopSendPromptBusy,
      traceId: sendTraceId,
    });
    } finally {
      stopSendPromptBusy();
    }
  }

  async function abortSession(sessionID?: string, target?: ConversationAbortTarget) {
    const id = (sessionID ?? deps.selectedSessionId() ?? "").trim();
    if (!id) return;
    const scope = deps.resolveConversationAbortScope(id, target);
    const explicitAbortWorkspaceId =
      target?.workspaceId?.trim() ||
      deps.resolveSelectedSessionBrowseScope(id)?.workspaceId?.trim() ||
      "";
    const activeAbortWorkspaceId = deps.workspace.activeWorkspaceId().trim();
    deps.recordSendTrace("abortSession:start", {
      sessionID: id,
      workspaceId: scope.workspaceId || null,
      conversationId: scope.conversationId || null,
      opencodeSessionId: scope.opencodeSessionId || null,
      hasConversationScope: scope.hasConversationScope,
      explicitWorkspaceId: explicitAbortWorkspaceId || null,
    });
    const blockAbortWithoutSafeServerScope = (): boolean => {
      if (!explicitAbortWorkspaceId) {
        deps.recordSendTrace("abortSession:abort-blocked-missing-workspace-scope", { sessionID: id });
        deps.setError("Cannot stop this run because its workspace scope is missing. Re-select the session and try again.");
        return true;
      }
      if (!activeAbortWorkspaceId || explicitAbortWorkspaceId !== activeAbortWorkspaceId) {
        deps.recordSendTrace("abortSession:abort-blocked-foreign-workspace", {
          sessionID: id,
          workspaceId: explicitAbortWorkspaceId,
          activeWorkspaceId: activeAbortWorkspaceId || null,
        });
        deps.setError("Cannot stop this run through the active workspace because it belongs to another workspace.");
        return true;
      }
      return false;
    };
    const reportAbortUnavailable = (message: string) => {
      if (blockAbortWithoutSafeServerScope()) return;
      deps.recordSendTrace("abortSession:conversation-abort-blocked-unavailable", {
        sessionID: id,
        workspaceId: scope.workspaceId || null,
        conversationId: scope.conversationId || null,
        opencodeSessionId: scope.opencodeSessionId || null,
        hasConversationScope: scope.hasConversationScope,
      });
      deps.setError(message);
    };
    try {
      const result = await deps.abortConversationFromVesloWriteApi(id, target);
      if (result) {
        deps.recordSendTrace("abortSession:conversation-abort-success", {
          sessionID: id,
          workspaceId: result.workspaceId,
          conversationId: result.conversationId,
          opencodeSessionId: result.opencodeSessionId,
          runId: result.runId,
        });
        return;
      }
      deps.recordSendTrace("abortSession:conversation-abort-unavailable", {
        sessionID: id,
        hasConversationScope: scope.hasConversationScope,
      });
      reportAbortUnavailable(
        scope.hasConversationScope
          ? "Conversation service is unavailable for this scoped conversation."
          : "Cannot stop this run because the Veslo conversation service is unavailable for this session.",
      );
      return;
    } catch (error) {
      const message = deps.messageFromUnknownError(error);
      deps.recordSendTrace("abortSession:conversation-abort-error", {
        sessionID: id,
        hasConversationScope: scope.hasConversationScope,
        message,
      });
      reportAbortUnavailable(message);
      return;
    }
  }

  return {
    sendPrompt,
    abortSession,
  };
}
