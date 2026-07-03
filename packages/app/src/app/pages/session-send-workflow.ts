import { resolveCodexReasoningEffort } from "../lib/model-variant";
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
  SendRuntimePreflightContext,
  SendRuntimePreflightTargetWorkspace,
} from "../context/send-runtime-readiness";
import type {
  ConversationAbortTarget,
  ConversationSendPreflightContext,
} from "../context/conversation-service";
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

export type SessionSendPreflightContext =
  SendRuntimePreflightContext &
  ConversationSendPreflightContext<VesloServerClient>;

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
  buildCommandFileParts: (draft: ComposerDraft) => unknown[];
  buildPromptParts: (draft: ComposerDraft) => unknown[];
  busy: () => boolean;
  busyLabel: () => string | null | undefined;
  captureDisplayedConversationGuard: (sessionId: string) => DisplayedConversationGuard;
  clearActivePendingDraftState: () => void;
  clearConsumedPendingDraftId: (draftId: string) => void;
  compactCurrentSession: (sessionId?: string) => Promise<unknown>;
  composerDraft: () => ComposerDraft;
  createSendPreflightContext: (traceId?: string | null) => SessionSendPreflightContext;
  createSessionAndOpen: (
    initialTitle?: string,
    options?: {
      blockAppDuringCreate?: boolean;
      managedAiRuntimeAlreadyPrepared?: boolean;
      pendingSession?: PendingSidebarSessionMetadata | null;
      sendTraceId?: string | null;
      clientMessageId?: string | null;
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
  markPendingDraftConsumed: (draftId: string) => void;
  messageFromUnknownError: (error: unknown) => string;
  messages: () => Array<{ parts: unknown[] }>;
  modelForSession: (sessionId: string | null | undefined) => ModelRef;
  modelVariant: () => string | null | undefined;
  pendingSessionDraftsDelete: (draftId: string) => Promise<boolean>;
  perfNow: () => number;
  prepareSendRuntimeForSend: (event: "sendPrompt", preflight: SessionSendPreflightContext) => Promise<boolean>;
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
  routedClient: (workspaceId?: string | null) => Client | null;
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
  selectedSessionId: () => string | null | undefined;
  sendTraceStep: <T>(
    event: string,
    run: () => Promise<T>,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
  sessionDirectoryOverrideById: () => Record<string, string | undefined>;
  sessionStoreAppendSessionErrorTurn: (sessionId: string, message: string) => void;
  sessionStoreClearCommandDisplay: (messageId: string) => void;
  sessionStoreSetCommandDisplay: (messageId: string, command: string, args: string) => void;
  setActivePendingDraftKey: (key: string | null) => void;
  setActivePendingDraftMeta: (meta: unknown | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setComposerDraftBySessionId: (
    updater: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
  ) => void;
  setError: (message: string | null) => void;
  setLastPromptSent: (prompt: string) => void;
  setPrompt: (value: string) => void;
  setSelectedSessionId: (sessionId: string | null) => void;
  setView: (view: View) => void;
  stageAttachmentsIntoSessionDirectory: (
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

export function createSessionSendWorkflow(deps: SessionSendWorkflowOptions): SessionSendWorkflow {
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
    const startSendPromptBusy = (label: string) => {
      if (!blockAppDuringPromptSend) return;
      ownsSendPromptBusy = true;
      deps.setBusy(true);
      deps.setBusyLabel(label);
      deps.setBusyStartedAt(Date.now());
    };
    const stopSendPromptBusy = () => {
      releasePromptSendInFlight();
      if (!ownsSendPromptBusy) return;
      ownsSendPromptBusy = false;
      deps.setBusy(false);
      deps.setBusyLabel(null);
      deps.setBusyStartedAt(null);
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

    const sendRuntimeWorkspaceId = sendTargetWorkspace?.workspaceId ?? deps.workspace.activeWorkspaceId().trim();
    const sendRuntimeReady = deps.isWorkspaceRuntimeReady(sendRuntimeWorkspaceId);
    if (sendRuntimeReady) {
      sendPreflight.enginePrepared = true;
      sendPreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(sendTargetWorkspace);
    }

    if (!sendRuntimeReady) {
      startSendPromptBusy("status.connecting");
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (!(await deps.prepareSendRuntimeForSend("sendPrompt", sendPreflight))) {
      cleanupPendingSidebarSession();
      stopSendPromptBusy();
      return false;
    }
    sendPreflight.enginePrepared = true;
    sendPreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(sendTargetWorkspace);
    sendPreflight.managedAiReady = true;

    const c = deps.routedClientForSendTarget(sendTargetWorkspace);
    if (!c) {
      deps.recordSendTrace("sendPrompt:blocked-no-client", {
        traceId: sendTraceId,
      });
      cleanupPendingSidebarSession();
      stopSendPromptBusy();
      return false;
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
    if (!sessionID) {
      deps.recordSendTrace("sendPrompt:create-session-needed", {
        traceId: sendTraceId,
      });
      const createdSessionId = await deps.sendTraceStep(
        "sendPrompt:create-session-and-open",
        () => deps.createSessionAndOpen(initialSessionTitle, {
          blockAppDuringCreate: blockAppDuringPromptSend,
          managedAiRuntimeAlreadyPrepared: true,
          pendingSession: pendingSidebarSession,
          sendTraceId,
          clientMessageId: sendCorrelation.clientMessageId,
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
        cleanupPendingSidebarSession();
        const selectedAfterCreate = deps.selectedSessionId();
        sessionID = deps.isPendingSessionInstanceId(selectedAfterCreate) ? null : selectedAfterCreate;
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
    const model = deps.modelForSession(materializedSessionID);
    let promptSystem: string | undefined;
    const restorePendingDraftAfterSendFailure = () => {
      if (!sendTargetStillDisplayed()) return;
      if (pendingDraftSendState) {
        deps.setActivePendingDraftKey(pendingDraftSendState.key);
        deps.setActivePendingDraftMeta(pendingDraftSendState.meta);
        deps.setView("session");
      }
    };

    try {
      const stagedAttachments = await deps.sendTraceStep(
        "sendPrompt:stage-attachments",
        () => deps.stageAttachmentsIntoSessionDirectory(resolvedDraft, materializedSessionID, sendPreflight),
        {
          traceId: sendTraceId,
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
          traceId: sendTraceId,
          sessionID,
          message: routedDraft.error,
        });
        restorePendingDraftAfterSendFailure();
        if (sendTargetStillDisplayed()) {
          deps.setError(routedDraft.error);
        }
        stopSendPromptBusy();
        return false;
      }
      resolvedDraft = routedDraft.draft;
      promptSystem = routedDraft.system;
    } catch (error) {
      deps.recordSendTrace("sendPrompt:stage-attachments-error", {
        traceId: sendTraceId,
        sessionID,
        message: deps.messageFromUnknownError(error),
      });
      restorePendingDraftAfterSendFailure();
      if (sendTargetStillDisplayed()) {
        deps.setError(error instanceof Error ? error.message : deps.safeStringify(error));
      }
      stopSendPromptBusy();
      return false;
    }

    const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!content && !resolvedDraft.attachments.length && !promptSystem) {
      deps.recordSendTrace("sendPrompt:blocked-empty-after-staging", {
        traceId: sendTraceId,
        sessionID,
      });
      stopSendPromptBusy();
      return false;
    }

    startSendPromptBusy("status.running");
    deps.setError(null);

    const perfEnabled = deps.developerMode();
    const startedAt = deps.perfNow();
    const visible = deps.messages();
    const visibleParts = visible.reduce((total, message) => total + message.parts.length, 0);
    let commandMessageIDToClear: string | null = null;
    deps.recordPerfLog(perfEnabled, "session.prompt", "start", {
      sessionID,
      mode: resolvedDraft.mode,
      command: commandName,
      charCount: content.length,
      attachmentCount: resolvedDraft.attachments.length,
      messageCount: visible.length,
      partCount: visibleParts,
    });

    try {
      if (!compactCommand) {
        deps.setLastPromptSent(content);
      }
      if (!hasExplicitDraft) {
        deps.setPrompt("");
      }

      const agent = deps.agentForSession(sessionID);
      const parts = deps.buildPromptParts(resolvedDraft);
      const selectedVariant = deps.modelVariant() ?? undefined;
      const reasoningEffort = resolveCodexReasoningEffort(model.modelID, selectedVariant ?? null);
      const requestVariant = reasoningEffort ? undefined : selectedVariant;
      const promptOverrides = {
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(promptSystem ? { system: promptSystem } : {}),
      };

      const sessionDirOverride = deps.sessionDirectoryOverrideById()[materializedSessionID] ?? undefined;
      const runConversationOrFail = async (input: VesloConversationRunInput) => {
        const scope = deps.resolveSelectedSessionBrowseScope(materializedSessionID);
        const inputWithCorrelation: VesloConversationRunInput = {
          ...input,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
        };
        try {
          const result = await deps.runConversationFromVesloWriteApi(materializedSessionID, inputWithCorrelation, {
            preflight: sendPreflight,
            targetWorkspace: sendTargetWorkspace,
          });
          if (result) return;
          deps.recordSendTrace("sendPrompt:conversation-run-unavailable", {
            traceId: sendTraceId,
            sessionID,
            kind: input.kind,
            clientMessageId: sendCorrelation.clientMessageId,
            origin: sendCorrelation.origin,
            hasConversationScope: Boolean(scope?.conversationId),
          });
          throw new Error("Conversation service is unavailable for this session.");
        } catch (error) {
          deps.recordSendTrace("sendPrompt:conversation-run-error", {
            traceId: sendTraceId,
            sessionID,
            kind: input.kind,
            clientMessageId: sendCorrelation.clientMessageId,
            origin: sendCorrelation.origin,
            hasConversationScope: Boolean(scope?.conversationId),
            message: deps.messageFromUnknownError(error),
          });
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
      } else if (resolvedDraft.command || compactCommand) {
        if (compactCommand) {
          await deps.compactCurrentSession(sessionID);
          deps.finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
            sessionID,
            mode: resolvedDraft.mode,
            command: commandName,
          });
          deps.recordSendTrace("sendPrompt:compact-success", {
            traceId: sendTraceId,
            sessionID,
          });
          return true;
        }

        const command = resolvedDraft.command;
        if (!command) {
          throw new Error("Command was not resolved.");
        }

        commandMessageIDToClear = sendCorrelation.clientMessageId;
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
          variant: requestVariant,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
          variant: requestVariant,
          ...promptOverrides,
          parts,
        });
      }
      if (pendingDraftSendState) {
        const pendingDraftStorageKey = pendingDraftSendState.key;
        const pendingDraftId = pendingDraftSendState.draftId;
        const clearDisplayedPendingDraftState = sendTargetStillDisplayed();
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
      }

      deps.finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
      });
      deps.recordSendTrace("sendPrompt:success", {
        traceId: sendTraceId,
        sessionID,
        clientMessageId: sendCorrelation.clientMessageId,
        origin: sendCorrelation.origin,
        mode: resolvedDraft.mode,
        command: commandName,
      });
      deps.holdVisibleRuntimeActivity(sessionID, "sendPrompt:success");
      return true;
    } catch (e) {
      restorePendingDraftAfterSendFailure();
      if (commandMessageIDToClear) {
        deps.sessionStoreClearCommandDisplay(commandMessageIDToClear);
      }
      if (deps.isWorkspaceClientStaleError(e)) {
        deps.recordSendTrace("sendPrompt:stale-client", {
          traceId: sendTraceId,
          sessionID,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
          entryWorkspaceId: e.entryWorkspaceId,
          currentWorkspaceId: e.currentWorkspaceId,
        });
        return false;
      }
      deps.finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
        error: e instanceof Error ? e.message : deps.safeStringify(e),
      });
      const message = e instanceof Error ? e.message : deps.safeStringify(e);
      deps.recordSendTrace("sendPrompt:error", {
        traceId: sendTraceId,
        sessionID,
        clientMessageId: sendCorrelation.clientMessageId,
        origin: sendCorrelation.origin,
        message,
      });
      reportSendErrorToDisplayedTarget(message);
      return false;
    }
    } finally {
      stopSendPromptBusy();
    }
  }

  async function abortSession(sessionID?: string, target?: ConversationAbortTarget) {
    const id = (sessionID ?? deps.selectedSessionId() ?? "").trim();
    if (!id) return;
    const scope = deps.resolveConversationAbortScope(id, target);
    deps.recordSendTrace("abortSession:start", {
      sessionID: id,
      workspaceId: scope.workspaceId || null,
      conversationId: scope.conversationId || null,
      opencodeSessionId: scope.opencodeSessionId || null,
      hasConversationScope: scope.hasConversationScope,
    });
    const abortSessionViaScopedLegacy = async (): Promise<boolean> => {
      if (!scope.workspaceId) return false;
      const opencodeSessionId = scope.opencodeSessionId?.trim() || id;
      const conversationId = scope.hasConversationScope ? scope.conversationId?.trim() : "";
      if (!opencodeSessionId || (conversationId && opencodeSessionId === conversationId)) return false;
      const scopedClient = deps.routedClient(scope.workspaceId);
      if (!scopedClient) return false;
      await deps.abortSessionTyped(scopedClient, opencodeSessionId, {
        directory: scope.directory?.trim() || undefined,
      });
      return true;
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
      if (target?.workspaceId?.trim() && await abortSessionViaScopedLegacy()) {
        deps.recordSendTrace("abortSession:scoped-legacy-fallback", { sessionID: id });
        return;
      }
      if (scope.hasConversationScope) {
        throw new Error("Conversation service is unavailable for this scoped conversation.");
      }
    } catch (error) {
      deps.recordSendTrace("abortSession:conversation-abort-error", {
        sessionID: id,
        hasConversationScope: scope.hasConversationScope,
        message: deps.messageFromUnknownError(error),
      });
      if (scope.hasConversationScope) {
        if (await abortSessionViaScopedLegacy()) {
          deps.recordSendTrace("abortSession:scoped-legacy-fallback", { sessionID: id });
          return;
        }
        throw error;
      }
      if (target?.workspaceId?.trim() && await abortSessionViaScopedLegacy()) {
        deps.recordSendTrace("abortSession:scoped-legacy-fallback", { sessionID: id });
        return;
      }
      console.warn("[conversation-abort] falling back to OpenCode SDK", error);
    }

    const c = deps.routedClient();
    if (!c) return;
    deps.recordSendTrace("abortSession:legacy-fallback", { sessionID: id });
    await deps.abortSessionTyped(c, id);
  }

  return {
    sendPrompt,
    abortSession,
  };
}
