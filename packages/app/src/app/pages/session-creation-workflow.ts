import {
  resolveCreatedSessionWorkspaceId,
  shouldRouteCreatedSessionAfterSelect,
  type CreatedSession,
} from "../controllers/session-creation-flow";
import {
  resolveCreateSessionManagedAiPreflightDecision,
  resolveCreateSessionRuntimeHealthPreflightDecision,
} from "../controllers/send-orchestration-controller";
import type { ConversationSendPreflightContext } from "../context/conversation-service";
import type { SessionFlowProgressEvent } from "../context/session-flow-progress-presenter";
import {
  shouldRecoverLocalRuntimeFromHealthError,
  type SendRuntimePreflightContext,
  type SendRuntimePreflightTargetWorkspace,
} from "../context/send-runtime-readiness";
import type { SendTargetWorkspaceScope } from "../context/workspace-session-selection";
import {
  createMaterializedSessionHandoff,
  type MaterializedSessionHandoff,
} from "../lib/session-send-contract";
import type {
  VesloConversationSubmitRequest,
  VesloConversationSubmitResult,
  VesloServerClient,
} from "../lib/veslo-server";
import type { PendingSidebarSessionMetadata, View } from "../types";

export type SessionCreationPreflightContext =
  SendRuntimePreflightContext &
  ConversationSendPreflightContext<VesloServerClient>;

export type SessionCreationWorkflowCreateOptions = {
  blockAppDuringCreate?: boolean;
  pendingSession?: PendingSidebarSessionMetadata | null;
  sendTraceId?: string | null;
  clientMessageId?: string | null;
  submitDraft?: VesloConversationSubmitRequest["draft"];
  submitOptions?: VesloConversationSubmitRequest["options"];
  submitOrigin?: string | null;
  submitSource?: string | null;
  onSubmitResult?: (result: VesloConversationSubmitResult) => void;
  onMaterializedSessionId?: (handoff: MaterializedSessionHandoff) => void;
  preflight?: SessionCreationPreflightContext;
};

type SessionCreationWorkspaceAccess = {
  activeWorkspaceDisplay: () => { workspaceType?: string | null };
  activeWorkspaceId: () => string;
  activeWorkspaceRoot: () => string;
  connectingWorkspaceId: () => string | null | undefined;
};

export type SessionCreationWorkspaceScope = {
  workspaceId: string;
  workspaceRoot: string;
  directory: string;
  targetWorkspaceId: string | null;
  targetWorkspaceRoot: string | null;
};

export type SessionCreationTransitionRecommendation = {
  shouldRouteAfterSelect: boolean;
  sessionId: string;
};

export type SessionCreationResult = {
  session: CreatedSession;
  sessionId: string;
  initialTitle: string;
  pendingSession: PendingSidebarSessionMetadata | null;
  handoff: MaterializedSessionHandoff | null;
  workspaceScope: SessionCreationWorkspaceScope;
  transition: SessionCreationTransitionRecommendation;
};

export type SessionCreationWorkflowOptions = {
  activeSendTraceId: () => string | null | undefined;
  addOpencodeCacheHint: (message: string) => string;
  baseUrl: () => string;
  currentView: () => View;
  developerMode: () => boolean;
  createSendPreflightContext: (sendTraceId?: string | null) => SessionCreationPreflightContext;
  ensureLocalRuntimeReachableForSend: (
    reason: "createSessionAndOpen",
    preflight: SendRuntimePreflightContext,
  ) => Promise<boolean>;
  ensureManagedAiBootstrapReady: (preflight: SendRuntimePreflightContext) => Promise<boolean>;
  isWorkspaceClientStaleError: (error: unknown) => error is {
    entryWorkspaceId?: string | null;
    currentWorkspaceId?: string | null;
  };
  managedAiBootstrapBusy: () => boolean;
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
  emitFlowProgress: (event: SessionFlowProgressEvent) => void;
  applyCreatedSessionState: (
    result: SessionCreationResult,
    options: SessionCreationWorkflowCreateOptions,
  ) => void;
  applyCreatedSessionTransition: (result: SessionCreationResult) => Promise<void>;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  reloadBusy: () => boolean;
  resolveRuntimeSandboxStateForTarget: (
    targetWorkspace?: SendRuntimePreflightTargetWorkspace | null,
  ) => unknown;
  resolveSendTargetWorkspaceScope: (
    scope: null,
  ) => SendTargetWorkspaceScope | null;
  resolveWorkspaceRootForConversationScope: (workspaceId: string, directory: string) => string;
  routedClient: (workspaceId?: string | null) => unknown;
  routedClientForSendTarget: (targetWorkspace?: SendRuntimePreflightTargetWorkspace | null) => unknown;
  safeStringify: (value: unknown) => string;
  sendTraceStep: <T>(
    event: string,
    run: () => Promise<T>,
    payload?: Record<string, unknown>,
  ) => Promise<T>;
  setError: (message: string | null) => void;
  unknownErrorMessage: () => string;
  workspace: SessionCreationWorkspaceAccess;
  abortRefreshes: () => void;
  createConversationFromVesloWriteApi: (
    workspaceId: string,
    directory: string,
    title?: string,
    preflight?: SessionCreationPreflightContext,
  ) => Promise<CreatedSession | null | undefined>;
  submitConversationFromVesloWriteApi?: (
    workspaceId: string,
    directory: string,
    input: VesloConversationSubmitRequest,
    preflight?: SessionCreationPreflightContext,
  ) => Promise<VesloConversationSubmitResult | null | undefined>;
  warn?: (message: string, payload?: Record<string, unknown>) => void;
};

export type SessionCreationWorkflow = {
  createSession: (
    initialTitle?: string,
    options?: SessionCreationWorkflowCreateOptions,
  ) => Promise<SessionCreationResult | undefined>;
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

  const createdSessionFromSubmitResult = (
    result: VesloConversationSubmitResult | null | undefined,
  ): CreatedSession | null => {
    if (!result) return null;
    if (
      result.status !== "materialized" &&
      result.status !== "submitted" &&
      result.status !== "queued" &&
      result.status !== "blocked" &&
      result.status !== "failed"
    ) {
      throw new Error(`Conversation submit returned ${result.status} before session materialization was complete.`);
    }
    const materialized = result.materializedSession;
    if (!materialized || typeof materialized !== "object" || Array.isArray(materialized)) {
      if (result.status === "blocked" || result.status === "failed") {
        throw new Error(result.message);
      }
      throw new Error("Conversation submit did not return a materialized session.");
    }
    const session = materialized as CreatedSession;
    const sessionId = typeof session.id === "string" ? session.id.trim() : "";
    if (!sessionId) {
      throw new Error("Conversation submit returned a materialized session without an id.");
    }
    return {
      ...session,
      id: sessionId,
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
    };
  };

  const runCreateSessionFlow = async (
    initialTitle = "",
    options: SessionCreationWorkflowCreateOptions = {},
    applyEffects: boolean,
  ): Promise<SessionCreationResult | undefined> => {
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
    const clientMessageId = options.clientMessageId?.trim() ?? "";
    const serverSubmitOwnsFirstMessageAdmission = Boolean(
      options.submitDraft &&
      clientMessageId &&
      deps.submitConversationFromVesloWriteApi,
    );
    const serverSubmitOwnsManagedAiAdmission = serverSubmitOwnsFirstMessageAdmission;
    deps.recordSendTrace("createSessionAndOpen:start", {
      ...(tracePayload ?? {}),
      connectingWorkspaceId: deps.workspace.connectingWorkspaceId(),
      activeWorkspaceId: deps.workspace.activeWorkspaceId(),
      activeWorkspaceRoot: deps.workspace.activeWorkspaceRoot().trim(),
      targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
      targetWorkspaceRoot: targetWorkspace?.workspaceRoot ?? null,
      targetDirectory: targetWorkspace?.directory ?? null,
      hasClient: Boolean(deps.routedClient()),
      serverSubmitOwnsRuntimeAdmission: false,
      serverSubmitOwnsFirstMessageAdmission,
      serverSubmitOwnsManagedAiAdmission,
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

    const createPreflight = preflight ?? deps.createSendPreflightContext(sendTraceId);
    createPreflight.targetWorkspace = createPreflight.targetWorkspace ?? targetWorkspace;
    if (!(createPreflight.conversationWorkspaceByDirectory instanceof Map)) {
      createPreflight.conversationWorkspaceByDirectory = new Map();
    }
    createPreflight.effectiveSandbox = deps.resolveRuntimeSandboxStateForTarget(targetWorkspace);
    let createRuntimeReady = true;
    const runtimeHealthPreflightDecision = resolveCreateSessionRuntimeHealthPreflightDecision({
      preflightEnginePrepared: Boolean(createPreflight.enginePrepared),
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
    });
    if (serverSubmitOwnsManagedAiAdmission) {
      deps.recordSendTrace("createSessionAndOpen:server-submit-managed-ai-admission-skip", {
        ...(tracePayload ?? {}),
        targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
      });
    } else if (managedAiPreflightDecision.type === "skip") {
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
    const requiresRoutedRuntimeClient =
      !serverSubmitOwnsFirstMessageAdmission || Boolean(createPreflight.runtimeHealthOk);
    if (requiresRoutedRuntimeClient) {
      const client = deps.routedClientForSendTarget(targetWorkspace);
      if (!client) {
        deps.recordSendTrace("createSessionAndOpen:blocked-no-client", tracePayload);
        deps.setError("Local runtime is not ready yet.");
        return undefined;
      }
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
      deps.emitFlowProgress({ type: "session.creating", owner: "create" });
    }

    try {
      const initialSessionTitle = initialTitle.trim();
      mark("session:create:start");
      const traceCreateFailure = (
        event: "createSessionAndOpen:create-error" | "createSessionAndOpen:create-retry-error",
        error: unknown,
        extra?: Record<string, unknown>,
      ) => {
        deps.recordSendTrace(event, {
          ...(tracePayload ?? {}),
          message: error instanceof Error ? error.message : deps.safeStringify(error),
          ...(extra ?? {}),
        });
      };

      const activeWorkspaceId = targetWorkspace?.workspaceId || deps.workspace.activeWorkspaceId().trim();
      if (!activeWorkspaceId) {
        const missingWorkspaceError = new Error("Workspace id is required for session creation.");
        traceCreateFailure("createSessionAndOpen:create-error", missingWorkspaceError);
        mark("session:create:error", { error: missingWorkspaceError.message });
        throw missingWorkspaceError;
      }

      const submitDraft = options.submitDraft;
      const submitConversation = deps.submitConversationFromVesloWriteApi;
      const createViaVeslo = async (retry: boolean): Promise<CreatedSession> => {
        const retryPayload = retry ? { retry: true } : {};
        const vesloCreated = submitDraft && clientMessageId && submitConversation
          ? await (async () => {
            const submitResult = await deps.sendTraceStep(
              "createSessionAndOpen:veslo-conversation-submit-materialize",
              () => submitConversation(
                activeWorkspaceId,
                sessionDirectory,
                {
                  clientMessageId,
                  origin: options.submitOrigin?.trim() || "session:normal",
                  source: options.submitSource?.trim() || null,
                  target: {
                    directory: sessionDirectory,
                    pendingClientSessionId: pendingSidebarSession?.id ?? null,
                  },
                  draft: submitDraft,
                  options: options.submitOptions,
                },
                createPreflight,
              ),
              {
                ...(tracePayload ?? {}),
                workspaceId: activeWorkspaceId,
                sessionDirectory,
                clientMessageId,
                ...retryPayload,
              },
            );
            if (submitResult) options.onSubmitResult?.(submitResult);
            return createdSessionFromSubmitResult(submitResult);
          })()
          : await deps.sendTraceStep(
            "createSessionAndOpen:veslo-conversation-create",
            () => deps.createConversationFromVesloWriteApi(
              activeWorkspaceId,
              sessionDirectory,
              initialSessionTitle || undefined,
              createPreflight,
            ),
            {
              ...(tracePayload ?? {}),
              workspaceId: activeWorkspaceId,
              sessionDirectory,
              ...retryPayload,
            },
          );
        if (!vesloCreated) {
          deps.recordSendTrace("createSessionAndOpen:conversation-create-unavailable", {
            ...(tracePayload ?? {}),
            workspaceId: activeWorkspaceId,
            sessionDirectory,
            ...retryPayload,
          });
          throw new Error("Conversation service is unavailable for session creation.");
        }
        return vesloCreated;
      };

      const recoverRuntimeBeforeCreateRetry = async (firstError: unknown): Promise<boolean> => {
        const recoverable = shouldRecoverLocalRuntimeFromHealthError(firstError, deps.safeStringify);
        traceCreateFailure("createSessionAndOpen:create-error", firstError, { recoverable });
        mark("session:create:error", {
          error: firstError instanceof Error ? firstError.message : deps.safeStringify(firstError),
          recoverable,
        });
        if (!recoverable || createPreflight.forceRecovery) {
          return false;
        }

        // First create can race a stale local token; rebuild once so cold start keeps moving.
        createPreflight.forceRecovery = true;
        createPreflight.runtimeHealthOk = false;
        createPreflight.enginePrepared = false;
        deps.recordSendTrace("createSessionAndOpen:create-runtime-recovery-start", tracePayload);
        const recovered = await deps.ensureLocalRuntimeReachableForSend("createSessionAndOpen", createPreflight);
        deps.recordSendTrace("createSessionAndOpen:create-runtime-recovery-result", {
          ...(tracePayload ?? {}),
          recovered,
        });
        return recovered;
      };

      const createWithOneRuntimeRecovery = async (): Promise<{
        session: CreatedSession;
        retried: boolean;
      }> => {
        try {
          return { session: await createViaVeslo(false), retried: false };
        } catch (firstError) {
          const recovered = await recoverRuntimeBeforeCreateRetry(firstError);
          if (!recovered) {
            throw firstError;
          }

          try {
            mark("session:create:retry");
            return { session: await createViaVeslo(true), retried: true };
          } catch (retryError) {
            traceCreateFailure("createSessionAndOpen:create-retry-error", retryError);
            throw retryError;
          }
        }
      };

      const { session: createdSession, retried: createRetried } = await createWithOneRuntimeRecovery();
      deps.recordSendTrace("createSessionAndOpen:create-ok", {
        ...(tracePayload ?? {}),
        sessionDirectory,
        conversationId: createdSession.conversationId ?? null,
        opencodeSessionId: createdSession.opencodeSessionId ?? createdSession.id,
        ...(createRetried ? { retry: true } : {}),
      });
      mark("session:create:ok", createRetried ? { retry: true } : undefined);

      const createdWorkspaceId = resolveCreatedSessionWorkspaceId({
        pendingSidebarSession,
        targetWorkspaceId: targetWorkspace?.workspaceId,
        connectingWorkspaceId: deps.workspace.connectingWorkspaceId(),
        activeWorkspaceId: deps.workspace.activeWorkspaceId(),
      });
      const createdWorkspaceRoot = createdWorkspaceId
        ? deps.resolveWorkspaceRootForConversationScope(createdWorkspaceId, sessionDirectory)
        : sessionDirectory;
      const handoff: MaterializedSessionHandoff | null = clientMessageId
        ? createMaterializedSessionHandoff({
            workspaceId: createdWorkspaceId || targetWorkspace?.workspaceId || deps.workspace.activeWorkspaceId().trim(),
            workspaceRoot: createdWorkspaceRoot,
            directory: sessionDirectory,
            pendingSessionKey: pendingSidebarSession?.id ?? null,
            sessionId: createdSession.id,
            clientMessageId,
            sendTraceId: sendTraceId || null,
            conversationId: createdSession.conversationId ?? null,
            opencodeSessionId: createdSession.opencodeSessionId ?? createdSession.id,
          })
        : null;
      const creationResult: SessionCreationResult = {
        session: createdSession,
        sessionId: createdSession.id,
        initialTitle: initialSessionTitle,
        pendingSession: pendingSidebarSession,
        handoff,
        workspaceScope: {
          workspaceId: createdWorkspaceId,
          workspaceRoot: createdWorkspaceRoot,
          directory: sessionDirectory,
          targetWorkspaceId: targetWorkspace?.workspaceId ?? null,
          targetWorkspaceRoot: targetWorkspace?.workspaceRoot ?? null,
        },
        transition: {
          shouldRouteAfterSelect: shouldRouteCreatedSessionAfterSelect({
            blockAppDuringCreate,
            currentView: deps.currentView(),
          }),
          sessionId: createdSession.id,
        },
      };

      if (blockAppDuringCreate) {
        deps.emitFlowProgress({ type: "session.loading", owner: "create" });
      }
      if (applyEffects) {
        deps.applyCreatedSessionState(creationResult, options);

        mark("session:select:start", { sessionID: createdSession.id });
        await deps.sendTraceStep(
          "createSessionAndOpen:select-session",
          () => deps.applyCreatedSessionTransition(creationResult),
          {
            ...(tracePayload ?? {}),
            sessionID: createdSession.id,
          },
        );
        mark("session:select:ok", { sessionID: createdSession.id });
      }

      deps.finishPerf(perfEnabled, "session.create", "done", startedAt, {
        runId,
        sessionID: createdSession.id,
      });
      deps.recordSendTrace("createSessionAndOpen:success", {
        ...(tracePayload ?? {}),
        sessionID: createdSession.id,
      });
      return creationResult;
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
        deps.emitFlowProgress({ type: "flow.idle", owner: "create" });
      }
    }
  };

  const createSession = (
    initialTitle = "",
    options: SessionCreationWorkflowCreateOptions = {},
  ) => runCreateSessionFlow(initialTitle, options, false);

  const createSessionAndOpen = async (
    initialTitle = "",
    options: SessionCreationWorkflowCreateOptions = {},
  ): Promise<string | undefined> => {
    const result = await runCreateSessionFlow(initialTitle, options, true);
    return result?.sessionId;
  };

  return {
    createSession,
    createSessionAndOpen,
  };
}
