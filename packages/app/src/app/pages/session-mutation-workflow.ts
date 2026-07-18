import type { Agent, Session } from "@opencode-ai/sdk/v2/client";

import {
  abortSessionSafe as defaultAbortSessionSafe,
  listCommands as defaultListCommands,
  revertSession as defaultRevertSession,
  unrevertSession as defaultUnrevertSession,
} from "../lib/opencode-session";
import { unwrap as defaultUnwrap } from "../lib/opencode";
import {
  normalizeSessionSendCorrelation,
  sessionSubmitBlockedResult,
  sessionSubmitFailedResult,
  sessionSubmitQueuedResult,
  sessionSubmitSubmittedResult,
  type MaterializedSessionHandoff,
  type SessionSendOptionsBase,
  type SessionSubmitResult,
} from "../lib/session-send-contract";
import {
  validateConversationSubmitRequest,
  validateConversationSubmitTerminalResult,
  validateSendRuntimePreparationResult,
  type SendBoundaryValidationMode,
} from "../lib/send-boundary-validation";
import {
  deleteSessionComposerDraft as defaultDeleteSessionComposerDraft,
} from "./session-composer-drafts";
import { withoutSessionStatus as defaultWithoutSessionStatus } from "../lib/scoped-session-status";
import {
  isVisibleTextPart,
  normalizeDirectoryPath,
  normalizeTodoItems as defaultNormalizeTodoItems,
} from "../utils";
import type {
  VesloConversationSubmitRequest,
  VesloConversationSubmitResult,
  VesloServerClient,
} from "../lib/veslo-server";
import type { ConversationSendPreflightContext } from "../context/conversation-service";
import type { SendTargetWorkspaceScope } from "../context/workspace-session-selection";
import type {
  Client,
  ComposerDraft,
  MessageWithParts,
  ModelRef,
  PendingSidebarSessionMetadata,
  TodoItem,
  WorkspaceDisplay,
} from "../types";

export type SessionMutationSendOptions = SessionSendOptionsBase & {
  targetSessionId?: string | null;
  onMaterializedSessionId?: (handoff: MaterializedSessionHandoff) => void;
  pendingSession?: PendingSidebarSessionMetadata | null;
};

export type SessionMutationReplaceOptions = SessionSendOptionsBase & {
  targetSessionId?: string | null;
};

export type SessionMutationCommandListScope = {
  workspaceId?: string | null;
  directory?: string | null;
};

export type SessionMutationCommand = {
  id: string;
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";
};

type SendPreflightContextLike = ConversationSendPreflightContext<VesloServerClient> & {
  targetWorkspace: SendTargetWorkspaceScope | null;
  enginePrepared?: boolean;
  effectiveSandbox?: unknown | null;
  managedAiReady?: boolean;
  runtimeHealthOk?: boolean;
};

type SessionMutationBrowseScope = {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
};

type SessionMutationClient = Client;

export type SessionMutationWorkflowDeps = {
  lastPromptSent: () => string;
  lastPromptSentModelOverride?: () => ModelRef | null;
  sendPrompt: (draft: ComposerDraft, options: SessionMutationSendOptions) => Promise<SessionSubmitResult>;
  createClientMessageId: () => string;
  selectedSessionId: () => string | null | undefined;
  selectedSession: () => Session | null | undefined;
  messages: () => MessageWithParts[];
  setPrompt: (value: string) => void;
  ensureSelectedSessionWorkspaceActiveForSend: (
    sessionId: string,
    sendTraceId?: string,
    resolvedTarget?: SendTargetWorkspaceScope | null,
  ) => Promise<boolean>;
  routedClient: (workspaceId?: string | null) => SessionMutationClient | null;
  abortSessionSafe?: (client: SessionMutationClient, sessionId: string) => Promise<unknown>;
  revertSession?: (client: SessionMutationClient, sessionId: string, messageId: string) => Promise<Session>;
  unrevertSession?: (client: SessionMutationClient, sessionId: string) => Promise<Session>;
  upsertLocalSession: (session: Session | null | undefined) => void;
  normalizeSendCorrelation?: typeof normalizeSessionSendCorrelation;
  createSendPreflightContext: (sendTraceId?: string | null) => SendPreflightContextLike;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  sendBoundaryValidationMode?: () => SendBoundaryValidationMode;
  sendTraceStep: (
    event: string,
    run: () => Promise<boolean>,
    payload?: Record<string, unknown>,
  ) => Promise<boolean>;
  resolveSendTargetWorkspaceScope: (sessionId?: string | null) => SendTargetWorkspaceScope | null;
  prepareSendRuntimeForSend: (event: string, preflight: SendPreflightContextLike) => Promise<{ ok: boolean }>;
  resolveRuntimeSandboxStateForTarget: (target: SendTargetWorkspaceScope | null) => unknown | null;
  routedClientForSendTarget: (target: SendTargetWorkspaceScope | null) => SessionMutationClient | null;
  engineReady: () => boolean;
  client: () => unknown;
  reportError: (error: unknown, context: string) => void;
  selectedSessionModel: () => ModelRef;
  developerMode: () => boolean;
  modelVariant: () => string | null | undefined;
  finishPerf: (
    enabled: boolean,
    scope: string,
    event: string,
    startedAt: number,
    payload?: Record<string, unknown>,
  ) => void;
  recordPerfLog: (
    enabled: boolean,
    scope: string,
    event: string,
    payload?: Record<string, unknown>,
  ) => void;
  perfNow: () => number;
  sessionDirectoryOverrideById: () => Record<string, string | undefined>;
  workspaceProjectDir: () => string;
  resolveSelectedSessionBrowseScope: (sessionId: string) => SessionMutationBrowseScope | null;
  submitConversationFromVesloWriteApi?: (
    workspaceId: string,
    directory: string,
    input: VesloConversationSubmitRequest,
    preflight?: SendPreflightContextLike,
  ) => Promise<VesloConversationSubmitResult | null | undefined>;
  messageFromUnknownError: (error: unknown) => string;
  safeStringify: (value: unknown) => string;
  renameSession: (sessionId: string, title: string, workspaceId?: string) => Promise<unknown>;
  refreshSidebarWorkspaceSessions: (workspaceId: string) => Promise<unknown>;
  activeWorkspaceId: () => string;
  workspaces: () => WorkspaceDisplay[];
  activeWorkspaceRoot: () => string;
  sessionDirectoryOverride: () => Record<string, string | undefined>;
  persistSessionDirectoryOverride: (sessionId: string, directory: string | null) => void;
  sessions: () => Session[];
  setSessions: (next: Session[]) => void;
  deleteSessionComposerDraft?: typeof defaultDeleteSessionComposerDraft;
  setComposerDraftBySessionId: (
    updater: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
  ) => void;
  removeSessionFromWorkspaceSidebar: (workspaceId: string, sessionId: string) => void;
  pathname: () => string;
  navigate: (to: string, options?: { replace?: boolean }) => void;
  setSelectedSessionId: (sessionId: string | null) => void;
  clearWorkspaceLastSessionIfSelected: (workspaceId: string, sessionId: string) => void;
  sessionStatusById: () => Record<string, string>;
  setSessionStatusById: (next: Record<string, string>) => void;
  withoutSessionStatus?: typeof defaultWithoutSessionStatus;
  unwrap?: typeof defaultUnwrap;
  listCommands?: typeof defaultListCommands;
  compactCommandDescription: () => string;
  workspaceRootForId: (workspaceId: string, fallbackDirectory?: string | null) => string;
  downloadSessionExport?: (payload: unknown, fileName: string) => string;
  normalizeTodoItems?: typeof defaultNormalizeTodoItems;
};

type TerminalReplacementSubmitResult = Extract<
  VesloConversationSubmitResult,
  { status: "submitted" | "queued" | "blocked" | "failed" }
>;

type SendBoundaryValidationRuntimeDeps = {
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  sendBoundaryValidationMode?: () => SendBoundaryValidationMode;
};

type SendBoundaryValidationRuntimeOptions = {
  context?: Record<string, unknown>;
  event: string;
  traceId?: string | null;
};

function sendBoundaryValidationOptions(
  deps: SendBoundaryValidationRuntimeDeps,
  options: SendBoundaryValidationRuntimeOptions,
) {
  return {
    ...options,
    mode: deps.sendBoundaryValidationMode?.(),
    recordSendTrace: deps.recordSendTrace,
  };
}

function sessionSubmitResultFromReplacementSubmit(
  result: TerminalReplacementSubmitResult,
): SessionSubmitResult {
  if (result.status === "submitted") {
    return sessionSubmitSubmittedResult({
      workspaceId: result.workspaceId,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
      runId: result.runId,
      clientMessageId: result.clientMessageId,
      draftDisposition: result.draftDisposition,
    });
  }
  if (result.status === "queued") {
    return sessionSubmitQueuedResult({
      workspaceId: result.workspaceId,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
      queueItemId: result.queueItemId,
      reservedRunId: result.reservedRunId,
      queuePosition: result.queuePosition,
      clientMessageId: result.clientMessageId,
      draftDisposition: result.draftDisposition,
    });
  }
  if (result.status === "blocked") {
    return sessionSubmitBlockedResult({
      code: result.code,
      message: result.message,
      workspaceId: result.workspaceId,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
      clientMessageId: result.clientMessageId,
      draftDisposition: result.draftDisposition,
    });
  }
  return sessionSubmitFailedResult({
    code: result.code,
    message: result.message,
    workspaceId: result.workspaceId,
    conversationId: result.conversationId,
    opencodeSessionId: result.opencodeSessionId,
    clientMessageId: result.clientMessageId,
    draftDisposition: result.draftDisposition,
  });
}

export type SessionMutationWorkflow = ReturnType<typeof createSessionMutationWorkflow>;

function messageIdFromInfo(message: MessageWithParts) {
  const id = (message.info as { id?: string | number }).id;
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return "";
}

function restorePromptFromUserMessage(message: MessageWithParts, setPrompt: (value: string) => void) {
  const text = message.parts
    .filter(isVisibleTextPart)
    .map((part) => String((part as { text?: string }).text ?? ""))
    .join("");
  setPrompt(text);
}

function conversationSubmitDraftFromComposerDraft(draft: ComposerDraft): VesloConversationSubmitRequest["draft"] {
  return {
    mode: draft.mode,
    text: draft.text,
    resolvedText: draft.resolvedText ?? null,
    parts: draft.parts,
    command: draft.command ?? null,
    attachments: draft.attachments.map((attachment) => ({
      name: attachment.name,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      dataUrl: attachment.dataUrl,
    })),
  };
}

function downloadSessionExport(payload: unknown, fileName: string) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return fileName;
}

export function createSessionMutationWorkflow(deps: SessionMutationWorkflowDeps) {
  const abortSessionSafe = deps.abortSessionSafe ?? defaultAbortSessionSafe;
  const revertSession = deps.revertSession ?? defaultRevertSession;
  const unrevertSession = deps.unrevertSession ?? defaultUnrevertSession;
  const normalizeSendCorrelation = deps.normalizeSendCorrelation ?? normalizeSessionSendCorrelation;
  const deleteSessionComposerDraft = deps.deleteSessionComposerDraft ?? defaultDeleteSessionComposerDraft;
  const withoutSessionStatus = deps.withoutSessionStatus ?? defaultWithoutSessionStatus;
  const unwrap = deps.unwrap ?? defaultUnwrap;
  const listCommandsTyped = deps.listCommands ?? defaultListCommands;
  const normalizeTodoItems = deps.normalizeTodoItems ?? defaultNormalizeTodoItems;
  const saveSessionDownload = deps.downloadSessionExport ?? downloadSessionExport;

  function retryLastPrompt() {
    const text = deps.lastPromptSent().trim();
    if (!text) return;
    const modelOverride = deps.lastPromptSentModelOverride?.() ?? null;
    void deps.sendPrompt({
      mode: "prompt",
      text,
      parts: [{ type: "text", text }],
      attachments: [],
    }, {
      clientMessageId: deps.createClientMessageId(),
      origin: "app:retry-last-prompt",
      ...(modelOverride ? { modelOverride } : {}),
    });
  }

  async function submitCurrentSessionCompaction(sessionIdOverride?: string) {
    const sessionID = (sessionIdOverride ?? deps.selectedSessionId() ?? "").trim();
    if (!sessionID) {
      throw new Error("Select a session before compacting.");
    }
    const sendTargetWorkspace = deps.resolveSendTargetWorkspaceScope(sessionID);
    if (!(await deps.ensureSelectedSessionWorkspaceActiveForSend(sessionID, undefined, sendTargetWorkspace))) {
      return;
    }

    const visible = deps.messages();
    if (!visible.length) {
      throw new Error("Nothing to compact yet.");
    }

    const model = deps.selectedSessionModel();
    const startedAt = deps.perfNow();
    const modelLabel = `${model.providerID}/${model.modelID}`;
    deps.recordPerfLog(deps.developerMode(), "session.compact", "start", {
      sessionID,
      messageCount: visible.length,
      model: modelLabel,
      variant: deps.modelVariant() ?? null,
    });

    try {
      const scope = deps.resolveSelectedSessionBrowseScope(sessionID);
      const workspaceId = sendTargetWorkspace?.workspaceId?.trim() || "";
      const workspaceType = deps.workspaces().find((workspace) => workspace.id === workspaceId)?.workspaceType ?? null;
      const submitConversation = deps.submitConversationFromVesloWriteApi;
      const submitDirectory =
        sendTargetWorkspace?.directory?.trim() ||
        sendTargetWorkspace?.workspaceRoot?.trim() ||
        "";
      if (!submitConversation || !workspaceId || workspaceType !== "local" || !submitDirectory) {
        deps.recordSendTrace("compactSession:server-submit-unavailable", {
          sessionID,
          workspaceId,
          workspaceType,
          hasSubmitConversation: Boolean(submitConversation),
          hasDirectory: Boolean(submitDirectory),
        });
        throw new Error("Server-owned compact is unavailable for this session.");
      }
      const preflight = deps.createSendPreflightContext();
      preflight.targetWorkspace = {
        workspaceId,
        workspaceRoot: sendTargetWorkspace?.workspaceRoot?.trim() || submitDirectory,
        directory: submitDirectory,
      };
      const clientMessageId = deps.createClientMessageId();
      deps.recordSendTrace("compactSession:server-submit-start", {
        traceId: preflight.traceId,
        sessionID,
        workspaceId,
        directory: submitDirectory,
        conversationId: scope?.conversationId ?? null,
        opencodeSessionId: scope?.opencodeSessionId ?? sessionID,
        clientMessageId,
      });
      const submitRequest: VesloConversationSubmitRequest = {
        clientMessageId,
        origin: "app:compact-session",
        target: {
          directory: submitDirectory,
          conversationId: scope?.conversationId ?? null,
          opencodeSessionId: scope?.opencodeSessionId ?? sessionID,
        },
        draft: {
          mode: "prompt",
          text: "/compact",
          resolvedText: "/compact",
          parts: [{ type: "text", text: "/compact" }],
          command: { name: "compact", arguments: "" },
          attachments: [],
        },
        options: {
          variant: deps.modelVariant() ?? null,
          submitQueuePolicy: "normal",
        },
      };
      const submitRequestValidation = validateConversationSubmitRequest(submitRequest, sendBoundaryValidationOptions(deps, {
        event: "compactSession:server-submit-request:validation-failed",
        traceId: preflight.traceId,
        context: {
          phase: "compact-server-submit",
          sessionID,
          workspaceId,
          directory: submitDirectory,
          clientMessageId,
        },
      }));
      if (!submitRequestValidation.ok) {
        throw new Error(submitRequestValidation.message);
      }
      let result = await submitConversation(
        workspaceId,
        submitDirectory,
        submitRequestValidation.value,
        preflight,
      );
      if (
        result?.status === "submitted" ||
        result?.status === "queued" ||
        result?.status === "blocked" ||
        result?.status === "failed"
      ) {
        const resultValidation = validateConversationSubmitTerminalResult(result, sendBoundaryValidationOptions(deps, {
          event: "compactSession:server-submit-result:validation-failed",
          traceId: preflight.traceId,
          context: {
            phase: "compact-server-submit",
            sessionID,
            workspaceId,
            clientMessageId,
          },
        }));
        if (!resultValidation.ok) {
          throw new Error(resultValidation.message);
        }
        result = resultValidation.value;
      }
      if (result?.status === "submitted" || result?.status === "queued") {
        deps.recordSendTrace("compactSession:server-submit-success", {
          traceId: preflight.traceId,
          sessionID,
          workspaceId,
          status: result.status,
          runId: result.status === "submitted" ? result.runId : result.reservedRunId,
          queueItemId: result.status === "queued" ? result.queueItemId : null,
          draftDisposition: result.draftDisposition,
        });
        deps.finishPerf(deps.developerMode(), "session.compact", "done", startedAt, {
          sessionID,
          messageCount: visible.length,
          model: modelLabel,
          serverSubmit: true,
          status: result.status,
        });
        return;
      }
      if (result?.status === "blocked" || result?.status === "failed") {
        deps.recordSendTrace(`compactSession:server-submit-${result.status}`, {
          traceId: preflight.traceId,
          sessionID,
          workspaceId,
          code: result.code,
          message: result.message,
          draftDisposition: result.draftDisposition,
        });
        throw new Error(result.message);
      }
      if (result) {
        deps.recordSendTrace("compactSession:server-submit-unexpected-result", {
          traceId: preflight.traceId,
          sessionID,
          workspaceId,
          status: result.status,
        });
        throw new Error(`Conversation submit returned ${result.status} for compact.`);
      }
      deps.recordSendTrace("compactSession:server-submit-unavailable", {
        traceId: preflight.traceId,
        sessionID,
        workspaceId,
      });
      throw new Error("Server-owned compact is unavailable for this session.");
    } catch (error) {
      deps.finishPerf(deps.developerMode(), "session.compact", "error", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
        error: error instanceof Error ? error.message : deps.safeStringify(error),
      });
      throw error;
    }
  }

  async function replaceUserMessage(
    messageID: string,
    draft: ComposerDraft,
    options: SessionMutationReplaceOptions,
  ): Promise<SessionSubmitResult> {
    const sendCorrelation = normalizeSendCorrelation(options);
    if (!sendCorrelation.clientMessageId) {
      deps.recordSendTrace("replaceUserMessage:blocked-missing-client-message-id", {
        origin: sendCorrelation.origin,
      });
      return sessionSubmitBlockedResult({
        code: "missing_client_message_id",
        message: "Cannot replace this message because its client message id is missing.",
      });
    }
    const replacePreflight = deps.createSendPreflightContext(options.sendTraceId);
    const sendTraceId = replacePreflight.traceId;
    const sessionID = (options.targetSessionId?.trim() || deps.selectedSessionId() || "").trim();
    if (!sessionID || !messageID.trim()) {
      return sessionSubmitBlockedResult({
        code: "replacement_missing_target",
        message: "Cannot replace this message because the target session or message is missing.",
      });
    }

    deps.recordSendTrace("replaceUserMessage:start", {
      traceId: sendTraceId,
      sessionID,
      messageID,
      clientMessageId: sendCorrelation.clientMessageId,
      origin: sendCorrelation.origin,
      engineReady: deps.engineReady(),
      hasClient: Boolean(deps.client()),
    });
    const sendTargetWorkspace = deps.resolveSendTargetWorkspaceScope(sessionID);
    if (
      !(await deps.sendTraceStep(
        "replaceUserMessage:ensure-scoped-workspace-active",
        () => deps.ensureSelectedSessionWorkspaceActiveForSend(sessionID, sendTraceId, sendTargetWorkspace),
        { traceId: sendTraceId, sessionID },
      ))
    ) {
      deps.recordSendTrace("replaceUserMessage:blocked-scoped-workspace", { traceId: sendTraceId, sessionID });
      return sessionSubmitBlockedResult({
        code: "workspace_scope_unavailable",
        message: "The selected session workspace is not ready for replacement.",
      });
    }
    replacePreflight.targetWorkspace = sendTargetWorkspace;
    const submitConversation = deps.submitConversationFromVesloWriteApi;
    const scope = deps.resolveSelectedSessionBrowseScope(sessionID);
    const workspaceId = sendTargetWorkspace?.workspaceId?.trim() || "";
    const submitDirectory =
      sendTargetWorkspace?.directory?.trim() ||
      sendTargetWorkspace?.workspaceRoot?.trim() ||
      "";
    if (submitConversation && workspaceId && submitDirectory) {
      replacePreflight.targetWorkspace = {
        workspaceId,
        workspaceRoot: sendTargetWorkspace?.workspaceRoot?.trim() || submitDirectory,
        directory: submitDirectory,
      };
      replacePreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(replacePreflight.targetWorkspace);
      deps.recordSendTrace("replaceUserMessage:server-submit-start", {
        traceId: sendTraceId,
        sessionID,
        workspaceId,
        directory: submitDirectory,
        conversationId: scope?.conversationId ?? null,
        opencodeSessionId: scope?.opencodeSessionId ?? sessionID,
        replaceMessageId: messageID,
        clientMessageId: sendCorrelation.clientMessageId,
        origin: sendCorrelation.origin,
      });
      const submitRequest: VesloConversationSubmitRequest = {
        clientMessageId: sendCorrelation.clientMessageId,
        origin: sendCorrelation.origin,
        source: sendCorrelation.source ?? null,
        target: {
          directory: submitDirectory,
          conversationId: scope?.conversationId ?? null,
          opencodeSessionId: scope?.opencodeSessionId ?? sessionID,
        },
        draft: conversationSubmitDraftFromComposerDraft(draft),
        options: {
          replaceMessageId: messageID,
          variant: deps.modelVariant() ?? null,
          submitQueuePolicy: "normal",
        },
      };
      const submitRequestValidation = validateConversationSubmitRequest(submitRequest, sendBoundaryValidationOptions(deps, {
        event: "replaceUserMessage:server-submit-request:validation-failed",
        traceId: sendTraceId,
        context: {
          phase: "replace-server-submit",
          sessionID,
          workspaceId,
          replaceMessageId: messageID,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
        },
      }));
      if (!submitRequestValidation.ok) {
        return sessionSubmitFailedResult({
          code: "replacement_submit_invalid_request",
          message: submitRequestValidation.message,
        });
      }
      let result = await submitConversation(
        workspaceId,
        submitDirectory,
        submitRequestValidation.value,
        replacePreflight,
      );
      if (
        result?.status === "submitted" ||
        result?.status === "queued" ||
        result?.status === "blocked" ||
        result?.status === "failed"
      ) {
        const resultValidation = validateConversationSubmitTerminalResult(result, sendBoundaryValidationOptions(deps, {
          event: "replaceUserMessage:server-submit-result:validation-failed",
          traceId: sendTraceId,
          context: {
            phase: "replace-server-submit",
            sessionID,
            workspaceId,
            replaceMessageId: messageID,
            clientMessageId: sendCorrelation.clientMessageId,
            origin: sendCorrelation.origin,
          },
        }));
        if (!resultValidation.ok) {
          return sessionSubmitFailedResult({
            code: "replacement_submit_invalid_result",
            message: resultValidation.message,
          });
        }
        result = resultValidation.value;
      }
      if (result?.status === "submitted" || result?.status === "queued") {
        deps.recordSendTrace("replaceUserMessage:server-submit-success", {
          traceId: sendTraceId,
          sessionID,
          workspaceId,
          status: result.status,
          runId: result.status === "submitted" ? result.runId : result.reservedRunId,
          queueItemId: result.status === "queued" ? result.queueItemId : null,
          replaceMessageId: messageID,
          clientMessageId: sendCorrelation.clientMessageId,
        });
        return sessionSubmitResultFromReplacementSubmit(result);
      }
      deps.recordSendTrace(
        result
          ? `replaceUserMessage:server-submit-${result.status}`
          : "replaceUserMessage:server-submit-unavailable",
        {
          traceId: sendTraceId,
          sessionID,
          workspaceId,
          replaceMessageId: messageID,
          clientMessageId: sendCorrelation.clientMessageId,
          ...(result && "code" in result ? { code: result.code, message: result.message } : {}),
        },
      );
      if (result?.status === "blocked" || result?.status === "failed") {
        return sessionSubmitResultFromReplacementSubmit(result);
      }
      return sessionSubmitFailedResult({
        code: "replacement_submit_unavailable",
        message: "Server-owned replacement submit is unavailable for this session.",
      });
    }
    deps.recordSendTrace("replaceUserMessage:server-submit-unavailable", {
      traceId: sendTraceId,
      sessionID,
      workspaceId: workspaceId || null,
      hasSubmitConversation: Boolean(submitConversation),
      hasDirectory: Boolean(submitDirectory),
    });
    const replaceRuntimePreparation = await deps.prepareSendRuntimeForSend("replaceUserMessage", replacePreflight);
    const replaceRuntimePreparationValidation = validateSendRuntimePreparationResult(
      replaceRuntimePreparation,
      sendBoundaryValidationOptions(deps, {
        event: "replaceUserMessage:runtime-preflight:validation-failed",
        traceId: sendTraceId,
        context: {
          phase: "replace-runtime-preflight",
          sessionID,
          workspaceId: workspaceId || null,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
        },
      }),
    );
    if (!replaceRuntimePreparationValidation.ok) {
      return sessionSubmitBlockedResult({
        code: "replacement_runtime_invalid_contract",
        message: replaceRuntimePreparationValidation.message,
      });
    }
    if (!replaceRuntimePreparation.ok) {
      return sessionSubmitBlockedResult({
        code: "replacement_runtime_unavailable",
        message: "The runtime is not ready for replacement.",
      });
    }
    replacePreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(sendTargetWorkspace);
    const c = deps.routedClientForSendTarget(sendTargetWorkspace);
    if (!c) {
      deps.recordSendTrace("replaceUserMessage:blocked-no-client", {
        traceId: sendTraceId,
        sessionID,
        workspaceId: (sendTargetWorkspace as { workspaceId?: string | null } | null)?.workspaceId ?? null,
      });
      return sessionSubmitBlockedResult({
        code: "replacement_no_client",
        message: "No runtime client is available for replacement.",
      });
    }

    await abortSessionSafe(c, sessionID);

    const previousRevertMessageID = deps.selectedSession()?.revert?.messageID ?? null;
    const next = await revertSession(c, sessionID, messageID);
    deps.upsertLocalSession(next);

    const accepted = await deps.sendPrompt(draft, {
      targetSessionId: sessionID,
      sendTraceId: options.sendTraceId,
      clientMessageId: sendCorrelation.clientMessageId,
      origin: sendCorrelation.origin,
    });
    if (!accepted.accepted) {
      try {
        const restored = previousRevertMessageID
          ? await revertSession(c, sessionID, previousRevertMessageID)
          : await unrevertSession(c, sessionID);
        deps.upsertLocalSession(restored);
      } catch (error) {
        deps.reportError(error, "session.replaceUserMessage.restore");
      }
    }
    return accepted;
  }

  async function undoLastUserMessage() {
    const sessionID = (deps.selectedSessionId() ?? "").trim();
    if (!sessionID) return;
    const sendTargetWorkspace = deps.resolveSendTargetWorkspaceScope(sessionID);
    if (!(await deps.ensureSelectedSessionWorkspaceActiveForSend(sessionID, undefined, sendTargetWorkspace))) {
      return;
    }
    const c = deps.routedClientForSendTarget(sendTargetWorkspace);
    if (!c) return;

    await abortSessionSafe(c, sessionID);

    const revertMessageID = deps.selectedSession()?.revert?.messageID ?? null;
    const users = deps.messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });

    let target: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = messageIdFromInfo(candidate);
      if (!id) continue;
      if (!revertMessageID || id < revertMessageID) {
        target = candidate;
        break;
      }
    }

    if (!target) return;
    const messageID = messageIdFromInfo(target);
    if (!messageID) return;

    const next = await revertSession(c, sessionID, messageID);
    deps.upsertLocalSession(next);
    restorePromptFromUserMessage(target, deps.setPrompt);
  }

  async function redoLastUserMessage() {
    const sessionID = (deps.selectedSessionId() ?? "").trim();
    if (!sessionID) return;
    const sendTargetWorkspace = deps.resolveSendTargetWorkspaceScope(sessionID);
    if (!(await deps.ensureSelectedSessionWorkspaceActiveForSend(sessionID, undefined, sendTargetWorkspace))) {
      return;
    }
    const c = deps.routedClientForSendTarget(sendTargetWorkspace);
    if (!c) return;

    await abortSessionSafe(c, sessionID);

    const revertMessageID = deps.selectedSession()?.revert?.messageID ?? null;
    if (!revertMessageID) return;

    const users = deps.messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });

    const next = users.find((message) => {
      const id = messageIdFromInfo(message);
      return Boolean(id) && id > revertMessageID;
    });

    if (!next) {
      const session = await unrevertSession(c, sessionID);
      deps.upsertLocalSession(session);
      deps.setPrompt("");
      return;
    }

    const messageID = messageIdFromInfo(next);
    if (!messageID) return;

    const nextSession = await revertSession(c, sessionID, messageID);
    deps.upsertLocalSession(nextSession);

    let prior: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = messageIdFromInfo(candidate);
      if (id && id < messageID) {
        prior = candidate;
        break;
      }
    }

    if (prior) {
      restorePromptFromUserMessage(prior, deps.setPrompt);
      return;
    }

    deps.setPrompt("");
  }

  async function renameSessionTitle(sessionID: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }
    const targetWorkspaceId = deps.resolveSendTargetWorkspaceScope(sessionID)?.workspaceId?.trim() || "";
    if (!targetWorkspaceId) {
      throw new Error("Session workspace is unavailable for rename.");
    }

    await deps.renameSession(sessionID, trimmed, targetWorkspaceId);
    await deps.refreshSidebarWorkspaceSessions(targetWorkspaceId)
      .catch(e => deps.reportError(e, "sidebar.refreshSessions"));
  }

  async function deleteSessionById(sessionID: string, workspaceID?: string) {
    const trimmed = sessionID.trim();
    if (!trimmed) return;
    const sendTargetWorkspace = deps.resolveSendTargetWorkspaceScope(trimmed);
    const workspaceId =
      (workspaceID ?? "").trim() ||
      sendTargetWorkspace?.workspaceId?.trim() ||
      "";
    if (!workspaceId) {
      throw new Error("Session workspace is unavailable for deletion.");
    }
    const c = deps.routedClient(workspaceId);
    if (!c) {
      throw new Error("Target workspace is not connected to a server");
    }

    const workspace = workspaceId
      ? deps.workspaces().find((item) => item.id === workspaceId)
      : null;
    const workspaceRoot = workspace
      ? workspace.workspaceType === "local"
        ? workspace.path?.trim() ?? ""
        : workspace.directory?.trim() ?? ""
      : deps.workspaceRootForId(workspaceId, "").trim();
    const targetWorkspaceRoot = sendTargetWorkspace?.workspaceId?.trim() === workspaceId
      ? sendTargetWorkspace.directory?.trim() || sendTargetWorkspace.workspaceRoot?.trim() || ""
      : "";

    const overrideDir = deps.sessionDirectoryOverride()[trimmed] ?? "";
    const root = normalizeDirectoryPath(overrideDir) || targetWorkspaceRoot || workspaceRoot;

    const params = root ? { sessionID: trimmed, directory: root } : { sessionID: trimmed };
    unwrap(await c.session.delete(params));

    deps.persistSessionDirectoryOverride(trimmed, null);
    deps.setSessions(deps.sessions().filter((s) => s.id !== trimmed));
    deps.setComposerDraftBySessionId((current) => deleteSessionComposerDraft(current, trimmed));
    const sidebarWorkspaceId = workspace?.id ?? workspaceId;
    deps.removeSessionFromWorkspaceSidebar(sidebarWorkspaceId, trimmed);

    try {
      const path = deps.pathname().toLowerCase();
      if (path === `/session/${trimmed.toLowerCase()}`) {
        deps.navigate("/session", { replace: true });
      }
    } catch {
      // ignore
    }

    if (deps.selectedSessionId() === trimmed) {
      deps.setSelectedSessionId(null);
      deps.clearWorkspaceLastSessionIfSelected(sidebarWorkspaceId, trimmed);
    }

    const nextStatus = withoutSessionStatus(deps.sessionStatusById(), sidebarWorkspaceId, trimmed);
    if (nextStatus !== deps.sessionStatusById()) {
      deps.setSessionStatusById(nextStatus);
    }
  }

  async function listAgents(): Promise<Agent[]> {
    const c = deps.routedClient();
    if (!c) return [];
    const list = unwrap(await c.app.agents()) as Agent[];
    return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  }

  async function listCommands(
    scope: SessionMutationCommandListScope = {},
  ): Promise<SessionMutationCommand[]> {
    const scopedWorkspaceId = scope.workspaceId?.trim() ?? "";
    const c = scopedWorkspaceId ? deps.routedClient(scopedWorkspaceId) : deps.routedClient();
    if (!c) return [];
    const scopedDirectory = scope.directory?.trim() ?? "";
    const directory =
      scopedDirectory ||
      (scopedWorkspaceId
        ? deps.workspaceRootForId(scopedWorkspaceId, null)
        : deps.activeWorkspaceRoot().trim()) ||
      undefined;
    const list = await listCommandsTyped(c, directory) as SessionMutationCommand[];
    if (list.some((entry) => entry.name === "compact")) {
      return list;
    }
    return [{
      id: "builtin:compact",
      name: "compact",
      description: deps.compactCommandDescription(),
      source: "command",
    }, ...list];
  }

  async function saveSessionExport(sessionID: string) {
    const sendTargetWorkspace = deps.resolveSendTargetWorkspaceScope(sessionID);
    if (!sendTargetWorkspace?.workspaceId?.trim()) {
      throw new Error("Session workspace is unavailable for export.");
    }
    const c = deps.routedClientForSendTarget(sendTargetWorkspace);
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const session = unwrap(await c.session.get({ sessionID })) as Session;
    const messages = unwrap(await c.session.messages({ sessionID })) as MessageWithParts[];
    let todos: TodoItem[] = [];
    try {
      todos = normalizeTodoItems(unwrap(await c.session.todo({ sessionID }))) as TodoItem[];
    } catch {
      // ignore
    }

    const payload = {
      session,
      messages,
      todos,
      exportedAt: new Date().toISOString(),
      source: "veslo",
    };

    const baseName = session.title || session.slug || session.id;
    const safeName = baseName
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const fileName = `session-${safeName || session.id}.json`;
    return saveSessionDownload(payload, fileName);
  }

  return {
    retryLastPrompt,
    submitCurrentSessionCompaction,
    replaceUserMessage,
    undoLastUserMessage,
    redoLastUserMessage,
    renameSessionTitle,
    deleteSessionById,
    listAgents,
    listCommands,
    saveSessionExport,
  };
}
