import type { Session } from "@opencode-ai/sdk/v2/client";

import {
  buildCreatedSidebarSessionItem,
  resolveCreatedSessionWorkspaceId,
  shouldRouteCreatedSessionAfterSelect,
  type CreatedSession,
} from "../controllers/session-creation-flow";
import {
  resolveCreateSessionManagedAiPreflightDecision,
  resolveCreateSessionRuntimeHealthPreflightDecision,
} from "../controllers/send-orchestration-controller";
import type { SendRuntimePreflightContext, SendRuntimePreflightTargetWorkspace } from "../context/send-runtime-readiness";
import type { MaterializedSessionHandoff } from "../lib/session-send-contract";
import type { PendingSidebarSessionMetadata, SidebarSessionItem, View } from "../types";

export type SessionCreationWorkflowCreateOptions = {
  blockAppDuringCreate?: boolean;
  managedAiRuntimeAlreadyPrepared?: boolean;
  pendingSession?: PendingSidebarSessionMetadata | null;
  sendTraceId?: string | null;
  clientMessageId?: string | null;
  onMaterializedSessionId?: (handoff: MaterializedSessionHandoff) => void;
  preflight?: SendRuntimePreflightContext;
};

type SessionCreationWorkspaceAccess = {
  activeWorkspaceDisplay: () => { workspaceType?: string | null };
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  connectingWorkspaceId: () => string | null | undefined;
};

type SessionRouteSyncAccess = {
  markOwnNavigationSession: (sessionId: string) => void;
  clearOwnNavigationSessionIf: (sessionId: string) => void;
};

export type SessionCreationWorkflowOptions = {
  activeSendTraceId: () => string | null | undefined;
  addOpencodeCacheHint: (message: string) => string;
  applyPendingInitialSessionTitle: (session: CreatedSession) => Session;
  baseUrl: () => string;
  currentView: () => View;
  developerMode: () => boolean;
  ensureLocalRuntimeReachableForSend: (
    reason: "createSessionAndOpen",
    preflight: SendRuntimePreflightContext,
  ) => Promise<boolean>;
  ensureManagedAiBootstrapReady: (preflight: SendRuntimePreflightContext) => Promise<boolean>;
  goToSession: (sessionId: string) => void;
  isWorkspaceClientStaleError: (error: unknown) => error is {
    entryWorkspaceId?: string | null;
    currentWorkspaceId?: string | null;
  };
  managedAiBootstrapBusy: () => boolean;
  materializePendingSessionInWorkspaceSidebar: (input: {
    workspaceId: string;
    pendingSessionInstanceId: string | null;
    item: SidebarSessionItem;
  }) => void;
  perfNow: () => number;
  recordPerfLog: (
    enabled: boolean,
    category: string,
    event: string,
    payload?: Record<string, unknown>,
  ) => void;
  finishPerf: (
    enabled: boolean,
    category: string,
    event: string,
    startedAt: number,
    payload?: Record<string, unknown>,
  ) => void;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  registerPendingInitialSessionTitle: (sessionId: string, title: string) => void;
  reloadBusy: () => boolean;
  rememberConversationScope: (input: {
    sessionId: string;
    workspaceId: string;
    workspaceRoot: string;
    directory: string;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
  }) => void;
  resolveRuntimeSandboxStateForTarget: (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ) => unknown;
  resolveSendTargetWorkspaceScope: (
    scope: null,
  ) => SendRuntimePreflightTargetWorkspace | null;
  resolveWorkspaceRootForConversationScope: (workspaceId: string, directory: string) => string;
  routedClient: (workspaceId?: string | null) => unknown;
  routedClientForSendTarget: (targetWorkspace?: SendRuntimePreflightTargetWorkspace | null) => unknown;
  safeStringify: (value: unknown) => string;
  selectSession: (sessionId: string) => Promise<void>;
  sendTraceStep: <T>(
    event: string,
    run: () => Promise<T>,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
  sessionRouteSync: SessionRouteSyncAccess;
  sessions: () => Session[];
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string) => void;
  setBusyStartedAt: (value: number) => void;
  setCreatingSession: (value: boolean) => void;
  setError: (message: string | null) => void;
  setSessions: (sessions: Session[]) => void;
  unknownErrorMessage: () => string;
  workspace: SessionCreationWorkspaceAccess;
  wsDebug: (event: string, payload?: Record<string, unknown>) => void;
  abortRefreshes: () => void;
  createConversationFromVesloWriteApi: (
    workspaceId: string,
    directory: string,
    title?: string,
    preflight?: SendRuntimePreflightContext,
  ) => Promise<CreatedSession | null | undefined>;
  onMaterializedSessionId?: (handoff: MaterializedSessionHandoff) => void;
  warn?: (message: string, payload?: Record<string, unknown>) => void;
};

export type SessionCreationWorkflow = {
  createSessionAndOpen: (
    initialTitle?: string,
    options?: SessionCreationWorkflowCreateOptions,
  ) => Promise<string | undefined>;
};

export function createSessionCreationWorkflow(
  deps: SessionCreationWorkflowOptions,
): SessionCreationWorkflow {
  let createSessionRunId = 0;

  const warn = (message: string, payload?: Record<string, unknown>) => {
    if (deps.warn) {
      deps.warn(message, payload);
      return;
    }
    console.warn(message, payload);
  };

  const createSessionAndOpen = async (
    initialTitle = "",
    options: SessionCreationWorkflowCreateOptions = {},
  ): Promise<string | undefined> => {
    const blockAppDuringCreate = options.blockAppDuringCreate ?? true;
    const pendingSidebarSession = options.pendingSession ?? null;
    const preflight = options.preflight;
    const sendTraceId = options.sendTraceId?.trim() || preflight?.traceId || deps.activeSendTraceId();
    const tracePayload = sendTraceId ? { traceId: sendTraceId } : undefined;
    const pendingTargetWorkspace = pendingSidebarSession?.workspaceId?.trim()
      ? {
          workspaceId: pendingSidebarSession.workspaceId.trim(),
          workspaceRoot: pendingSidebarSession.workspaceRoot.trim(),
          directory: pendingSidebarSession.workspaceRoot.trim(),
        }
      : null;
    const targetWorkspace =
      preflight?.targetWorkspace ??
      pendingTargetWorkspace ??
      deps.resolveSendTargetWorkspaceScope(null) ??
      null;
    deps.recordSendTrace("createSessionAndOpen:start", {
      ...(tracePayload ?? {}),
      connectingWorkspaceId: deps.workspace.connectingWorkspaceId(),
      activeWorkspaceId: deps.workspace.activeWorkspaceId(),
      activeWorkspaceRoot: deps.workspace.activeWorkspaceRoot().trim(),
      targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
      targetWorkspaceRoot: targetWorkspace?.workspaceRoot ?? null,
      targetDirectory: targetWorkspace?.directory ?? null,
      hasClient: Boolean(deps.routedClient()),
    });

    const connectingWorkspaceId = deps.workspace.connectingWorkspaceId()?.trim() ?? "";
    if (connectingWorkspaceId && (!targetWorkspace || connectingWorkspaceId === targetWorkspace.workspaceId)) {
      warn("[createSessionAndOpen] Blocked: workspace switch in progress", { connectingWorkspaceId });
      deps.recordSendTrace("createSessionAndOpen:blocked-connecting", {
        ...(tracePayload ?? {}),
        connectingWorkspaceId,
        targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
      });
      deps.setError("Please wait for the workspace switch to complete.");
      return undefined;
    }
    if (connectingWorkspaceId) {
      deps.recordSendTrace("createSessionAndOpen:ignore-unrelated-connecting-workspace", {
        ...(tracePayload ?? {}),
        connectingWorkspaceId,
        targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
      });
    }

    const createPreflight: SendRuntimePreflightContext = preflight ?? {
      traceId: sendTraceId?.trim() ?? "",
      targetWorkspace,
      runtimeHealthOk: false,
    };
    createPreflight.targetWorkspace = createPreflight.targetWorkspace ?? targetWorkspace;
    createPreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(targetWorkspace);
    let createRuntimeReady = true;
    const runtimeHealthPreflightDecision = resolveCreateSessionRuntimeHealthPreflightDecision({
      preflightRuntimeHealthOk: Boolean(createPreflight.runtimeHealthOk),
    });
    if (runtimeHealthPreflightDecision.type === "skip") {
      deps.recordSendTrace("createSessionAndOpen:health-skip", {
        ...(tracePayload ?? {}),
        reason: runtimeHealthPreflightDecision.reason,
      });
      createPreflight.enginePrepared = true;
    } else {
      createRuntimeReady = await deps.sendTraceStep(
        "createSessionAndOpen:ensure-local-runtime-reachable",
        () => deps.ensureLocalRuntimeReachableForSend("createSessionAndOpen", createPreflight),
        {
          ...(tracePayload ?? {}),
          activeWorkspaceId: deps.workspace.activeWorkspaceId().trim(),
          targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
          workspaceType: deps.workspace.activeWorkspaceDisplay().workspaceType,
          hasClient: Boolean(deps.routedClient(targetWorkspace?.workspaceId)),
        },
      );
      if (createPreflight.runtimeHealthOk) {
        deps.recordSendTrace("createSessionAndOpen:health-ok", tracePayload);
      }
    }
    if (!createRuntimeReady) {
      deps.recordSendTrace("createSessionAndOpen:blocked-runtime-unreachable", tracePayload);
      deps.setError("Local runtime is not ready yet.");
      return undefined;
    }
    createPreflight.enginePrepared = true;
    createPreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(targetWorkspace);
    const managedAiPreflightDecision = resolveCreateSessionManagedAiPreflightDecision({
      preflightManagedAiReady: Boolean(createPreflight.managedAiReady),
      runtimeAlreadyPrepared: Boolean(options.managedAiRuntimeAlreadyPrepared),
    });
    if (managedAiPreflightDecision.type === "skip") {
      deps.recordSendTrace("createSessionAndOpen:managed-ai-bootstrap-skip", {
        ...(tracePayload ?? {}),
        reason: managedAiPreflightDecision.reason,
      });
      createPreflight.managedAiReady = true;
    } else {
      const managedAiReady = await deps.sendTraceStep(
        "createSessionAndOpen:ensure-managed-ai-bootstrap-ready",
        () => deps.ensureManagedAiBootstrapReady(createPreflight),
        {
          ...(tracePayload ?? {}),
          managedAiBootstrapBusy: deps.managedAiBootstrapBusy(),
          reloadBusy: deps.reloadBusy(),
          hasClient: Boolean(deps.routedClient(targetWorkspace?.workspaceId)),
        },
      );
      if (!managedAiReady) {
        deps.recordSendTrace("createSessionAndOpen:blocked-managed-ai-bootstrap", tracePayload);
        return undefined;
      }
      createPreflight.managedAiReady = true;
    }
    const client = deps.routedClientForSendTarget(targetWorkspace);
    if (!client) {
      deps.recordSendTrace("createSessionAndOpen:blocked-no-client", tracePayload);
      deps.setError("Local runtime is not ready yet.");
      return undefined;
    }

    const sessionDirectory =
      pendingSidebarSession?.workspaceRoot?.trim() ||
      targetWorkspace?.directory ||
      targetWorkspace?.workspaceRoot ||
      deps.workspace.activeWorkspaceRoot().trim();
    if (!sessionDirectory) {
      warn("[createSessionAndOpen] Blocked: activeWorkspaceRoot is empty");
      deps.recordSendTrace("createSessionAndOpen:blocked-empty-root", tracePayload);
      deps.setError("Workspace directory is not available. Please try again.");
      return undefined;
    }

    const perfEnabled = deps.developerMode();
    const startedAt = deps.perfNow();
    createSessionRunId += 1;
    const runId = createSessionRunId;
    const mark = (event: string, payload?: Record<string, unknown>) => {
      const elapsed = Math.round((deps.perfNow() - startedAt) * 100) / 100;
      deps.recordPerfLog(perfEnabled, "session.create", event, {
        runId,
        elapsedMs: elapsed,
        ...(payload ?? {}),
      });
    };

    mark("start", {
      baseUrl: deps.baseUrl(),
      workspace: sessionDirectory || null,
      workspaceId: targetWorkspace?.workspaceId || deps.workspace.activeWorkspaceId().trim() || null,
    });

    await deps.sendTraceStep(
      "createSessionAndOpen:abort-refresh-settle",
      async () => {
        deps.abortRefreshes();
      },
      tracePayload,
    );

    deps.setError(null);
    if (blockAppDuringCreate) {
      deps.setBusy(true);
      deps.setBusyLabel("status.creating_task");
      deps.setBusyStartedAt(Date.now());
      deps.setCreatingSession(true);
    }

    try {
      const initialSessionTitle = initialTitle.trim();
      let createdSession: CreatedSession;
      try {
        mark("session:create:start");
        const activeWorkspaceId = targetWorkspace?.workspaceId || deps.workspace.activeWorkspaceId().trim();
        if (!activeWorkspaceId) {
          throw new Error("Workspace id is required for session creation.");
        }
        const vesloCreated = await deps.sendTraceStep(
          "createSessionAndOpen:veslo-conversation-create",
          () => deps.createConversationFromVesloWriteApi(
            activeWorkspaceId,
            sessionDirectory,
            initialSessionTitle || undefined,
            preflight,
          ),
          {
            ...(tracePayload ?? {}),
            workspaceId: activeWorkspaceId,
            sessionDirectory,
          },
        );
        if (!vesloCreated) {
          deps.recordSendTrace("createSessionAndOpen:conversation-create-unavailable", {
            ...(tracePayload ?? {}),
            workspaceId: activeWorkspaceId,
            sessionDirectory,
          });
          throw new Error("Conversation service is unavailable for session creation.");
        }
        createdSession = vesloCreated;
        deps.recordSendTrace("createSessionAndOpen:create-ok", {
          ...(tracePayload ?? {}),
          sessionDirectory,
          conversationId: createdSession.conversationId ?? null,
          opencodeSessionId: createdSession.opencodeSessionId ?? createdSession.id,
        });
        mark("session:create:ok");
      } catch (createErr) {
        deps.recordSendTrace("createSessionAndOpen:create-error", {
          ...(tracePayload ?? {}),
          message: createErr instanceof Error ? createErr.message : deps.safeStringify(createErr),
        });
        mark("session:create:error", {
          error: createErr instanceof Error ? createErr.message : deps.safeStringify(createErr),
        });
        throw createErr;
      }

      if (initialSessionTitle) {
        deps.registerPendingInitialSessionTitle(createdSession.id, initialSessionTitle);
      }
      const createdWorkspaceId = resolveCreatedSessionWorkspaceId({
        pendingSidebarSession,
        targetWorkspaceId: targetWorkspace?.workspaceId,
        connectingWorkspaceId: deps.workspace.connectingWorkspaceId(),
        activeWorkspaceId: deps.workspace.activeWorkspaceId(),
      });
      if (createdWorkspaceId) {
        deps.rememberConversationScope({
          sessionId: createdSession.id,
          workspaceId: createdWorkspaceId,
          workspaceRoot: deps.resolveWorkspaceRootForConversationScope(createdWorkspaceId, sessionDirectory),
          directory: sessionDirectory,
          conversationId: createdSession.conversationId,
          opencodeSessionId: createdSession.opencodeSessionId ?? createdSession.id,
        });
      }
      const displaySession = deps.applyPendingInitialSessionTitle(createdSession);
      const newItem = buildCreatedSidebarSessionItem({
        session: createdSession,
        displaySession,
        pendingSidebarSession,
      });
      const wsId = createdWorkspaceId;
      const clientMessageId = options.clientMessageId?.trim() ?? "";
      if (clientMessageId) {
        const handoff = {
          workspaceId: wsId || targetWorkspace?.workspaceId || deps.workspace.activeWorkspaceId().trim(),
          pendingSessionKey: pendingSidebarSession?.id ?? null,
          sessionId: createdSession.id,
          clientMessageId,
          sendTraceId: sendTraceId || null,
          conversationId: createdSession.conversationId ?? null,
          opencodeSessionId: createdSession.opencodeSessionId ?? createdSession.id,
        };
        (options.onMaterializedSessionId ?? deps.onMaterializedSessionId)?.(handoff);
      }

      if (blockAppDuringCreate) {
        deps.setBusyLabel("status.loading_session");
      }
      const currentStoreSessions = deps.sessions();
      if (!currentStoreSessions.some((entry) => entry.id === createdSession.id)) {
        deps.setSessions([createdSession, ...currentStoreSessions]);
      }

      if (wsId) {
        deps.materializePendingSessionInWorkspaceSidebar({
          workspaceId: wsId,
          pendingSessionInstanceId: pendingSidebarSession?.id ?? null,
          item: newItem,
        });
      } else {
        deps.wsDebug("session:create:sidebar-materialize-skipped-empty-workspace", {
          sessionId: createdSession.id,
          pendingSessionInstanceId: pendingSidebarSession?.id ?? null,
          targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
          activeWorkspaceId: deps.workspace.activeWorkspaceId().trim() || null,
          connectingWorkspaceId: deps.workspace.connectingWorkspaceId()?.trim() || null,
        });
      }

      const shouldRouteCreatedSession = shouldRouteCreatedSessionAfterSelect({
        blockAppDuringCreate,
        currentView: deps.currentView(),
      });
      if (shouldRouteCreatedSession) {
        deps.sessionRouteSync.markOwnNavigationSession(createdSession.id);
      }

      mark("session:select:start", { sessionID: createdSession.id });
      try {
        await deps.sendTraceStep(
          "createSessionAndOpen:select-session",
          () => deps.selectSession(createdSession.id),
          {
            ...(tracePayload ?? {}),
            sessionID: createdSession.id,
          },
        );
      } catch (selectError) {
        deps.sessionRouteSync.clearOwnNavigationSessionIf(createdSession.id);
        throw selectError;
      }
      mark("session:select:ok", { sessionID: createdSession.id });

      if (shouldRouteCreatedSession) {
        deps.sessionRouteSync.markOwnNavigationSession(createdSession.id);
        deps.goToSession(createdSession.id);
      }

      deps.finishPerf(perfEnabled, "session.create", "done", startedAt, {
        runId,
        sessionID: createdSession.id,
      });
      deps.recordSendTrace("createSessionAndOpen:success", {
        ...(tracePayload ?? {}),
        sessionID: createdSession.id,
      });
      return createdSession.id;
    } catch (error) {
      deps.finishPerf(perfEnabled, "session.create", "error", startedAt, {
        runId,
        error: error instanceof Error ? error.message : deps.safeStringify(error),
      });
      if (deps.isWorkspaceClientStaleError(error)) {
        deps.recordSendTrace("createSessionAndOpen:stale-client", {
          ...(tracePayload ?? {}),
          entryWorkspaceId: error.entryWorkspaceId,
          currentWorkspaceId: error.currentWorkspaceId,
        });
        return undefined;
      }
      const message = error instanceof Error ? error.message : deps.unknownErrorMessage();
      deps.recordSendTrace("createSessionAndOpen:error", {
        ...(tracePayload ?? {}),
        message,
      });
      deps.setError(deps.addOpencodeCacheHint(message));
      return undefined;
    } finally {
      if (blockAppDuringCreate) {
        deps.setCreatingSession(false);
        deps.setBusy(false);
      }
    }
  };

  return {
    createSessionAndOpen,
  };
}
