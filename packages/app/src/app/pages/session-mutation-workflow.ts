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
  type MaterializedSessionHandoff,
  type SessionSendOptionsBase,
} from "../lib/session-send-contract";
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

type SendPreflightContextLike = {
  traceId: string;
  targetWorkspace: unknown | null;
  enginePrepared?: boolean;
  effectiveSandbox?: unknown | null;
  managedAiReady?: boolean;
  runtimeHealthOk?: boolean;
};

type SessionMutationClient = Client;

export type SessionMutationWorkflowDeps = {
  lastPromptSent: () => string;
  sendPrompt: (draft: ComposerDraft, options: SessionMutationSendOptions) => Promise<boolean>;
  createClientMessageId: () => string;
  selectedSessionId: () => string | null | undefined;
  selectedSession: () => Session | null | undefined;
  messages: () => MessageWithParts[];
  setPrompt: (value: string) => void;
  ensureSelectedSessionWorkspaceActiveForSend: (sessionId: string, sendTraceId?: string) => Promise<boolean>;
  routedClient: (workspaceId?: string | null) => SessionMutationClient | null;
  abortSessionSafe?: (client: SessionMutationClient, sessionId: string) => Promise<unknown>;
  revertSession?: (client: SessionMutationClient, sessionId: string, messageId: string) => Promise<Session>;
  unrevertSession?: (client: SessionMutationClient, sessionId: string) => Promise<Session>;
  upsertLocalSession: (session: Session | null | undefined) => void;
  normalizeSendCorrelation?: typeof normalizeSessionSendCorrelation;
  createSendPreflightContext: (sendTraceId?: string | null) => SendPreflightContextLike;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  sendTraceStep: (
    event: string,
    run: () => Promise<boolean>,
    payload?: Record<string, unknown>,
  ) => Promise<boolean>;
  resolveSendTargetWorkspaceScope: (sessionId?: string | null) => unknown | null;
  prepareSendRuntimeForSend: (event: string, preflight: SendPreflightContextLike) => Promise<{ ok: boolean }>;
  resolveRuntimeSandboxStateForTarget: (target: unknown | null) => unknown | null;
  routedClientForSendTarget: (target: unknown | null) => SessionMutationClient | null;
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
  resolveSelectedSessionBrowseScope: (sessionId: string) => { workspaceId?: string | null; conversationId?: string | null } | null;
  runConversationFromVesloWriteApi: (
    sessionId: string,
    input: {
      kind: "summarize";
      directory?: string;
      providerID: string;
      modelID: string;
    },
  ) => Promise<unknown>;
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
    void deps.sendPrompt({
      mode: "prompt",
      text,
      parts: [{ type: "text", text }],
      attachments: [],
    }, {
      clientMessageId: deps.createClientMessageId(),
      origin: "app:retry-last-prompt",
    });
  }

  async function compactCurrentSession(sessionIdOverride?: string) {
    const sessionID = (sessionIdOverride ?? deps.selectedSessionId() ?? "").trim();
    if (!sessionID) {
      throw new Error("Select a session before compacting.");
    }
    if (!(await deps.ensureSelectedSessionWorkspaceActiveForSend(sessionID))) {
      return;
    }
    const c = deps.routedClient();
    if (!c) {
      throw new Error("Not connected to a server");
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
      const directory = deps.sessionDirectoryOverrideById()[sessionID] ?? (deps.workspaceProjectDir().trim() || undefined);
      const scope = deps.resolveSelectedSessionBrowseScope(sessionID);
      try {
        const result = await deps.runConversationFromVesloWriteApi(sessionID, {
          kind: "summarize",
          directory,
          providerID: model.providerID,
          modelID: model.modelID,
        });
        if (result) {
          deps.finishPerf(deps.developerMode(), "session.compact", "done", startedAt, {
            sessionID,
            messageCount: visible.length,
            model: modelLabel,
          });
          return;
        }
        deps.recordSendTrace("compactSession:conversation-run-unavailable", {
          sessionID,
          hasConversationScope: Boolean(scope?.conversationId),
        });
        throw new Error("Conversation service is unavailable for this session.");
      } catch (error) {
        deps.recordSendTrace("compactSession:conversation-run-error", {
          sessionID,
          hasConversationScope: Boolean(scope?.conversationId),
          message: deps.messageFromUnknownError(error),
        });
        throw error;
      }
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
  ): Promise<boolean> {
    const sendCorrelation = normalizeSendCorrelation(options);
    if (!sendCorrelation.clientMessageId) {
      deps.recordSendTrace("replaceUserMessage:blocked-missing-client-message-id", {
        origin: sendCorrelation.origin,
      });
      return false;
    }
    const replacePreflight = deps.createSendPreflightContext(options.sendTraceId);
    const sendTraceId = replacePreflight.traceId;
    const sessionID = (options.targetSessionId?.trim() || deps.selectedSessionId() || "").trim();
    if (!sessionID || !messageID.trim()) return false;

    deps.recordSendTrace("replaceUserMessage:start", {
      traceId: sendTraceId,
      sessionID,
      messageID,
      clientMessageId: sendCorrelation.clientMessageId,
      origin: sendCorrelation.origin,
      engineReady: deps.engineReady(),
      hasClient: Boolean(deps.client()),
    });
    if (!(await deps.ensureSelectedSessionWorkspaceActiveForSend(sessionID))) {
      deps.recordSendTrace("replaceUserMessage:blocked-scoped-workspace", { sessionID });
      return false;
    }

    if (
      !(await deps.sendTraceStep(
        "replaceUserMessage:ensure-scoped-workspace-active",
        () => deps.ensureSelectedSessionWorkspaceActiveForSend(sessionID, sendTraceId),
        { traceId: sendTraceId, sessionID },
      ))
    ) {
      deps.recordSendTrace("replaceUserMessage:blocked-scoped-workspace", { traceId: sendTraceId, sessionID });
      return false;
    }
    const sendTargetWorkspace = deps.resolveSendTargetWorkspaceScope(sessionID);
    replacePreflight.targetWorkspace = sendTargetWorkspace;
    const replaceRuntimePreparation = await deps.prepareSendRuntimeForSend("replaceUserMessage", replacePreflight);
    if (!replaceRuntimePreparation.ok) return false;
    replacePreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(sendTargetWorkspace);
    const c = deps.routedClientForSendTarget(sendTargetWorkspace);
    if (!c) {
      deps.recordSendTrace("replaceUserMessage:blocked-no-client", {
        traceId: sendTraceId,
        sessionID,
        workspaceId: (sendTargetWorkspace as { workspaceId?: string | null } | null)?.workspaceId ?? null,
      });
      return false;
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
    if (!accepted) {
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
    if (!(await deps.ensureSelectedSessionWorkspaceActiveForSend(sessionID))) {
      return;
    }
    const c = deps.routedClient();
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
    if (!(await deps.ensureSelectedSessionWorkspaceActiveForSend(sessionID))) {
      return;
    }
    const c = deps.routedClient();
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
    const targetWorkspaceId =
      deps.resolveSelectedSessionBrowseScope(sessionID)?.workspaceId?.trim() ||
      deps.activeWorkspaceId().trim();

    await deps.renameSession(sessionID, trimmed, targetWorkspaceId || undefined);
    await deps.refreshSidebarWorkspaceSessions(targetWorkspaceId || deps.activeWorkspaceId())
      .catch(e => deps.reportError(e, "sidebar.refreshSessions"));
  }

  async function deleteSessionById(sessionID: string, workspaceID?: string) {
    const trimmed = sessionID.trim();
    if (!trimmed) return;
    const workspaceId =
      (workspaceID ?? "").trim() ||
      deps.resolveSelectedSessionBrowseScope(trimmed)?.workspaceId?.trim() ||
      deps.activeWorkspaceId().trim();
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
      : deps.activeWorkspaceRoot().trim();

    const overrideDir = deps.sessionDirectoryOverride()[trimmed] ?? "";
    const root = normalizeDirectoryPath(overrideDir) || workspaceRoot;

    const params = root ? { sessionID: trimmed, directory: root } : { sessionID: trimmed };
    unwrap(await c.session.delete(params));

    deps.persistSessionDirectoryOverride(trimmed, null);
    deps.setSessions(deps.sessions().filter((s) => s.id !== trimmed));
    deps.setComposerDraftBySessionId((current) => deleteSessionComposerDraft(current, trimmed));
    const sidebarWorkspaceId = workspace?.id ?? workspaceId ?? deps.activeWorkspaceId();
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
      const activeWorkspace = deps.activeWorkspaceId().trim();
      if (activeWorkspace) {
        deps.clearWorkspaceLastSessionIfSelected(activeWorkspace, trimmed);
      }
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
    const c = deps.routedClient();
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
    compactCurrentSession,
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
