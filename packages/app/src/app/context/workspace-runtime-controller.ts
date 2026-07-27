import type { Accessor } from "solid-js";

import type { OpencodeAuth } from "../lib/opencode";
import type { EngineInfo, WorkspaceInfo } from "../lib/tauri";
import type { Client, WorkspaceConnectionState } from "../types";
import { createSingleFlight } from "../utils";
import type { createLocalRuntimeLifecycle } from "../utils/local-runtime-lifecycle";
import { withTimeoutOrThrow } from "../utils/promise-timeout";
import type { ConnectToServer } from "./workspace-types";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import type { WorkspaceLifecycleEvent } from "./workspace-lifecycle-state";
import { prepareRuntimeWithSkillViewRefresh } from "./workspace-skill-materialization";

const DEFAULT_CONNECT_HEALTH_TIMEOUT_MS = 12_000;
const CONNECT_LOAD_SESSIONS_TIMEOUT_MS = 20_000;
const WORKSPACE_API_READINESS_PROBE_TIMEOUT_MS = 4_000;
const WORKSPACE_API_WAITING_MESSAGE = "Waiting for OpenCode workspace API";

const messageFromUnknownError = (error: unknown, safeStringify: (value: unknown) => string) =>
  error instanceof Error ? error.message : safeStringify(error);

export function isWorkspaceFolderAccessDeniedError(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return false;
  return /Operation not permitted|Permission denied|\bEACCES\b|\bEPERM\b|os error 1/i.test(normalized);
}

function isEngineStartingRoutingError(detail: string | null): boolean {
  const normalized = (detail ?? "").toLowerCase();
  return (
    normalized.includes("engine_starting") ||
    normalized.includes('"enginestate":"starting"') ||
    normalized.includes('"engine_state":"starting"')
  );
}

export type WorkspaceRuntimeControllerDeps = {
  activeWorkspaceId: Accessor<string>;
  workspaces: Accessor<WorkspaceInfo[]>;
  workspacesHydrated: Accessor<boolean>;
  routing: {
    release: (workspaceId: string) => void;
    ensure: (
      workspaceId: string,
      baseUrl: string,
      options?: {
        directory?: string;
        auth?: OpencodeAuth;
        context?: {
          workspaceType?: WorkspaceInfo["workspaceType"];
          targetRoot?: string;
          reason?: string;
        };
      },
    ) => Promise<{ client: Client; directory?: string | null } | null>;
    lastEnsureError: (workspaceId: string) => string | null;
  };
  resolveEngineRuntime: () => EngineInfo["runtime"];
  localRuntimeLifecycle: ReturnType<typeof createLocalRuntimeLifecycle>;
  connectToServer: ConnectToServer;
  loadSessions: (scopeRoot?: string) => Promise<void>;
  setClient: (value: Client | null) => void;
  setConnectedVersion: (value: string | null) => void;
  setBaseUrl: (value: string) => void;
  setClientDirectory: (value: string) => void;
  setEngineReady?: (value: boolean) => void;
  setError: (value: string | null) => void;
  updateWorkspaceConnectionState: (
    workspaceId: string,
    next: Partial<WorkspaceConnectionState>,
  ) => void;
  onEngineStable?: () => void;
  clearWorkspaceBusyAllExcept: (workspaceId: string) => void;
  ensureLocalRuntimeReadyForWorkspaceStart?: (workspacePath: string) => Promise<boolean>;
  syncManagedAiRuntimeConfigBeforeRuntime?: (target: {
    workspaceId: string;
    workspaceRoot: string;
    directory: string;
  }) => Promise<boolean>;
  syncWorkspaceSkillMaterializationBeforeRuntime: (
    workspace: WorkspaceInfo,
    options: { reason: string },
  ) => Promise<boolean>;
  runtimeSkillViewRevision?: (workspaceId: string) => string | null;
  probeWorkspaceApiReady?: (input: {
    workspaceId: string;
    workspacePath: string;
    reason: string;
  }) => Promise<boolean>;
  createClient: (baseUrl: string, directory: string, auth?: OpencodeAuth) => Client;
  waitForHealthy: (
    client: Client,
    options: { timeoutMs: number },
  ) => Promise<{ version?: string | null }>;
  safeStringify: (value: unknown) => string;
  wsLog: (event: string, detail?: unknown) => void;
  dispatchLifecycle?: (event: WorkspaceLifecycleEvent) => void;
  requestWorkspaceFolderAccess?: (input: {
    workspaceId: string;
    workspacePath: string;
    requestedPath: string;
    reason: string;
  }) => void;
};

export type EnsureEngineForWorkspaceOptions = {
  reason?: string;
  loadSessions?: boolean;
  forceFreshRuntime?: boolean;
};

export function createWorkspaceRuntimeController(deps: WorkspaceRuntimeControllerDeps) {
  const ensureEngineForWorkspaceSingleFlight = createSingleFlight<boolean>();

  const setErrorForActiveWorkspace = (workspaceId: string, message: string) => {
    const activeWorkspaceId = deps.activeWorkspaceId().trim();
    if (!activeWorkspaceId || activeWorkspaceId === workspaceId) {
      deps.setError(message);
      return;
    }
    recordSendWorkflowTrace("workspace-runtime", "inactive-workspace-error-suppressed", {
      workspaceId,
      activeWorkspaceId,
      error: message,
    });
  };

  async function connectToEngineQuiet(
    baseUrl: string,
    directory: string,
    auth?: OpencodeAuth,
    context?: {
      workspaceId?: string;
      workspaceType?: WorkspaceInfo["workspaceType"];
      targetRoot?: string;
      reason?: string;
    },
  ): Promise<boolean> {
    const workspaceId = context?.workspaceId?.trim() ?? "";
    const ensureOptions = {
      directory,
      auth,
      context: {
        workspaceType: context?.workspaceType,
        targetRoot: context?.targetRoot ?? directory,
        reason: context?.reason,
      },
    };
    const entry = workspaceId
      ? await deps.routing.ensure(workspaceId, baseUrl, ensureOptions)
      : null;
    if (workspaceId && !entry) {
      const detail = deps.routing.lastEnsureError(workspaceId);
      const engineStarting = isEngineStartingRoutingError(detail);
      // This is the "quiet" automated bring-up connect (lifecycle restart /
      // startHost / reattach). A failed health wait here is usually a cold-start
      // race — the engine is spawned but its OpenCode HTTP is not serving
      // /health yet within the ensure timeout — which the lifecycle/send-
      // readiness retry path recovers from while answering continues. Surfacing
      // a hard error here only flashes a misleading "Failed to ensure workspace
      // client" before recovery. Stay quiet: trace and return false. Terminal
      // failures are owned by ensureEngineForWorkspace's catch block and the
      // send-readiness gate, which surface precise, recoverable-aware errors.
      recordSendWorkflowTrace(
        "workspace-runtime",
        engineStarting ? "connect-quiet:engine-starting" : "connect-quiet:routing-error",
        {
          workspaceId,
          baseUrl,
          directory,
          reason: context?.reason ?? null,
          error: detail ?? null,
          ...(engineStarting ? { engineState: "starting" } : {}),
        },
      );
      return false;
    }

    const nextClient = entry?.client ?? deps.createClient(baseUrl, directory, auth);
    let connectedVersion: string | null = null;
    if (!entry) {
      const health = await deps.waitForHealthy(nextClient, { timeoutMs: DEFAULT_CONNECT_HEALTH_TIMEOUT_MS });
      connectedVersion = health.version ?? null;
    }
    deps.setClient(nextClient);
    deps.setConnectedVersion(connectedVersion);
    deps.setBaseUrl(baseUrl);
    deps.setClientDirectory(entry?.directory ?? directory);
    recordSendWorkflowTrace("workspace-runtime", "connect-quiet:done", {
      workspaceId: workspaceId || null,
      baseUrl,
      directory,
      routed: Boolean(entry),
      reason: context?.reason ?? null,
    });
    return true;
  }

  async function refreshActiveClient(nextBaseUrl: string): Promise<boolean> {
    const url = nextBaseUrl.trim();
    if (!url) return false;
    const id = deps.activeWorkspaceId().trim();
    if (!id) return false;
    const workspace = deps.workspaces().find((w) => w.id === id);
    deps.routing.release(id);
    return await deps.connectToServer(
      url,
      workspace?.path || undefined,
      {
        workspaceId: id,
        workspaceType: workspace?.workspaceType,
        targetRoot: workspace?.path,
        reason: "port-rotation",
      },
      undefined,
      { quiet: true, navigate: false, forceRefresh: true },
    );
  }

  function startWorkspaceApiReadinessProbe(input: {
    workspaceId: string;
    workspacePath: string;
    reason: string;
  }): void {
    if (!deps.probeWorkspaceApiReady) return;
    const workspaceId = input.workspaceId.trim();
    const workspacePath = input.workspacePath.trim();
    if (!workspaceId || !workspacePath) return;
    const stillSameWorkspace = () =>
      deps.workspaces().some((workspace) =>
        workspace.id === workspaceId && workspace.path?.trim() === workspacePath
      );
    if (!stillSameWorkspace()) return;

    // OpenCode process health only proves the HTTP server is alive. Keep this
    // probe diagnostic and asynchronous: a slow session API should explain the
    // UI state, not turn first paint or first send into a new hard gate.
    deps.updateWorkspaceConnectionState(workspaceId, {
      status: "connected",
      message: WORKSPACE_API_WAITING_MESSAGE,
    });
    recordSendWorkflowTrace("workspace-runtime", "ensure-engine:workspace-api-probe:start", {
      workspaceId,
      reason: input.reason,
    });
    void withTimeoutOrThrow(deps.probeWorkspaceApiReady({
      workspaceId,
      workspacePath,
      reason: input.reason,
    }), {
      timeoutMs: WORKSPACE_API_READINESS_PROBE_TIMEOUT_MS,
      label: "OpenCode workspace API readiness",
      })
      .then((ready) => {
        if (!stillSameWorkspace()) return;
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:workspace-api-probe:done", {
          workspaceId,
          reason: input.reason,
          ready,
        });
        deps.updateWorkspaceConnectionState(workspaceId, {
          status: "connected",
          message: ready ? null : WORKSPACE_API_WAITING_MESSAGE,
        });
      })
      .catch((error) => {
        if (!stillSameWorkspace()) return;
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:workspace-api-probe:error", {
          workspaceId,
          reason: input.reason,
          error: messageFromUnknownError(error, deps.safeStringify),
        });
        deps.updateWorkspaceConnectionState(workspaceId, {
          status: "connected",
          message: WORKSPACE_API_WAITING_MESSAGE,
        });
      });
  }

  async function ensureEngineForWorkspace(
    workspaceId?: string | null,
    options: EnsureEngineForWorkspaceOptions = {},
  ): Promise<boolean> {
    let id = workspaceId?.trim() || deps.activeWorkspaceId().trim();
    const ensureReason = options.reason?.trim() || "ensure-engine-for-workspace";
    const shouldLoadSessions = options.loadSessions !== false;
    const isBootWarmup = ensureReason === "boot-warmup";
    const isRuntimeRecovery = ensureReason.includes("runtime-recovery");
    // First sends must not share the background warmup single-flight.
    const forceFreshRuntime = options.forceFreshRuntime === true || isRuntimeRecovery;
    if (!deps.workspacesHydrated()) {
      const start = Date.now();
      while (!deps.workspacesHydrated() && Date.now() - start < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      id = workspaceId?.trim() || deps.activeWorkspaceId().trim();
      recordSendWorkflowTrace("workspace-runtime", "ensure-engine:hydration-wait", {
        workspaceId: id || null,
        hydrated: deps.workspacesHydrated(),
        durationMs: Date.now() - start,
      });
    }

    const workspace = deps.workspaces().find((w) => w.id === id);
    if (!workspace?.path) {
      recordSendWorkflowTrace("workspace-runtime", "ensure-engine:workspace-unavailable", {
        workspaceId: id || null,
        workspacesHydrated: deps.workspacesHydrated(),
      });
      return false;
    }

    const singleFlightKey = forceFreshRuntime
      ? `${workspace.id || workspace.path}::fresh-runtime`
      : workspace.id || workspace.path;

    return await ensureEngineForWorkspaceSingleFlight(singleFlightKey, async () => {
      const runtime = deps.resolveEngineRuntime();
      deps.dispatchLifecycle?.({
        type: "runtime-starting",
        workspaceId: id,
        runtime,
        reason: ensureReason,
      });
      deps.wsLog("[workspace:ensureEngine] starting engine for browsing mode", { id, path: workspace.path });
      recordSendWorkflowTrace("workspace-runtime", "ensure-engine:start", {
        workspaceId: id,
        workspacePath: workspace.path,
        workspaceType: workspace.workspaceType,
        runtime,
        reason: ensureReason,
        loadSessions: shouldLoadSessions,
        forceFreshRuntime,
        workspacesHydrated: deps.workspacesHydrated(),
      });

      if (runtime !== "veslo-orchestrator") {
        deps.clearWorkspaceBusyAllExcept(workspace.id);
      }

      try {
        const runtimeReady = workspace.workspaceType === "local"
          ? await deps.ensureLocalRuntimeReadyForWorkspaceStart?.(workspace.path)
          : true;
        if (runtimeReady === false) {
          const message = "Workspace runtime prerequisites are not ready";
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:runtime-prerequisites-not-ready", {
            workspaceId: id,
            workspacePath: workspace.path,
            runtime,
          });
          deps.updateWorkspaceConnectionState(id, { status: "error", message });
          deps.dispatchLifecycle?.({
            type: "failed",
            workspaceId: id,
            message,
          });
          return false;
        }

        if (workspace.workspaceType === "local" && deps.syncManagedAiRuntimeConfigBeforeRuntime) {
          const configStartedAt = Date.now();
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:managed-ai-config:start", {
            workspaceId: id,
            workspacePath: workspace.path,
            reason: ensureReason,
          });
          try {
            const managedAiConfigReady = await deps.syncManagedAiRuntimeConfigBeforeRuntime({
              workspaceId: id,
              workspaceRoot: workspace.path,
              directory: workspace.path,
            });
            if (!managedAiConfigReady) {
              const message = "Managed AI access was not ready before runtime start";
              recordSendWorkflowTrace("workspace-runtime", "ensure-engine:managed-ai-config:not-ready", {
                workspaceId: id,
                reason: ensureReason,
                durationMs: Date.now() - configStartedAt,
              });
              deps.updateWorkspaceConnectionState(id, { status: "error", message });
              deps.dispatchLifecycle?.({
                type: "failed",
                workspaceId: id,
                message,
              });
              return false;
            }
            recordSendWorkflowTrace("workspace-runtime", "ensure-engine:managed-ai-config:done", {
              workspaceId: id,
              reason: ensureReason,
              durationMs: Date.now() - configStartedAt,
            });
          } catch (error) {
            const message = messageFromUnknownError(error, deps.safeStringify);
            recordSendWorkflowTrace("workspace-runtime", "ensure-engine:managed-ai-config:error", {
              workspaceId: id,
              reason: ensureReason,
              durationMs: Date.now() - configStartedAt,
              error: message,
            });
            deps.updateWorkspaceConnectionState(id, { status: "error", message });
            deps.dispatchLifecycle?.({
              type: "failed",
              workspaceId: id,
              message,
            });
            return false;
          }
        }

        const skillSyncMaxAttempts = isBootWarmup || isRuntimeRecovery ? 6 : 1;
        const skillSyncReason = isBootWarmup
          ? "boot-warmup"
          : isRuntimeRecovery
            ? "runtime-recovery"
            : "browse-attach";
        let skillsReady = false;
        for (let attempt = 1; attempt <= skillSyncMaxAttempts; attempt += 1) {
          skillsReady = await deps.syncWorkspaceSkillMaterializationBeforeRuntime(workspace, {
            reason: skillSyncReason,
          });
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:skills-ready", {
            workspaceId: id,
            skillsReady,
            reason: ensureReason,
            attempt,
            maxAttempts: skillSyncMaxAttempts,
          });
          if (skillsReady) break;
          if (attempt < skillSyncMaxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (!skillsReady) {
          deps.dispatchLifecycle?.({
            type: "failed",
            workspaceId: id,
            message: "Workspace skills were not ready before runtime start",
          });
          return false;
        }

        const prepareReason = ensureReason;
        const startedAt = Date.now();
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:prepare-runtime:start", {
          workspaceId: id,
          workspacePath: workspace.path,
          runtime,
          reason: prepareReason,
          forceFreshRuntime,
          skillViewRevision: deps.runtimeSkillViewRevision?.(workspace.id) ?? null,
        });
        const prepareRuntime = async () => await deps.localRuntimeLifecycle.prepareWorkspaceRuntime({
          workspacePath: workspace.path,
          workspaceId: workspace.id,
          workspaceName: workspace.displayName?.trim() || workspace.name?.trim() || null,
          reason: prepareReason,
          connectMode: "quiet",
          forceFreshRuntime,
          skillViewRevision: deps.runtimeSkillViewRevision?.(workspace.id) ?? null,
        });
        const ok = await prepareRuntimeWithSkillViewRefresh({
          prepare: prepareRuntime,
          refresh: async ({ reason }) => await deps.syncWorkspaceSkillMaterializationBeforeRuntime(workspace, { reason }),
          onRetry: ({ conflict }) => {
            recordSendWorkflowTrace("workspace-runtime", "ensure-engine:skill-view-refresh", {
              workspaceId: id,
              reason: prepareReason,
              cause: conflict,
            });
          },
        });
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:prepare-runtime:done", {
          workspaceId: id,
          ok,
          durationMs: Date.now() - startedAt,
          runtime,
          reason: prepareReason,
          forceFreshRuntime,
        });
        if (!ok) {
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:not-started", {
            workspaceId: id,
          });
          deps.dispatchLifecycle?.({
            type: "failed",
            workspaceId: id,
            message: "Workspace runtime did not start",
          });
          return false;
        }

        if (shouldLoadSessions) {
          try {
            const loadStartedAt = Date.now();
            await withTimeoutOrThrow(deps.loadSessions(workspace.path), {
              timeoutMs: CONNECT_LOAD_SESSIONS_TIMEOUT_MS,
              label: "loadSessions",
            });
            recordSendWorkflowTrace("workspace-runtime", "ensure-engine:load-sessions:done", {
              workspaceId: id,
              durationMs: Date.now() - loadStartedAt,
            });
          } catch (loadSessionsError) {
            deps.wsLog("[workspace:ensureEngine] loadSessions failed; continuing first prompt", {
              id,
              error: messageFromUnknownError(loadSessionsError, deps.safeStringify),
            });
            recordSendWorkflowTrace("workspace-runtime", "ensure-engine:load-sessions:error", {
              workspaceId: id,
              error: messageFromUnknownError(loadSessionsError, deps.safeStringify),
            });
          }
        } else {
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:load-sessions:skipped", {
            workspaceId: id,
            reason: ensureReason,
          });
        }
        const isActiveWorkspace = workspace.id === deps.activeWorkspaceId().trim();
        if (isActiveWorkspace) {
          deps.setEngineReady?.(true);
          deps.onEngineStable?.();
        }
        deps.updateWorkspaceConnectionState(id, { status: "connected", message: null });
        startWorkspaceApiReadinessProbe({
          workspaceId: id,
          workspacePath: workspace.path,
          reason: ensureReason,
        });
        deps.dispatchLifecycle?.({
          type: "connected",
          workspaceId: id,
          runtime,
          reason: ensureReason,
        });
        deps.wsLog("[workspace:ensureEngine] engine started successfully", { id });
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:success", {
          workspaceId: id,
          activeWorkspace: isActiveWorkspace,
          reason: ensureReason,
        });
        return true;
      } catch (e) {
        const message = messageFromUnknownError(e, deps.safeStringify);
        deps.wsLog("[workspace:ensureEngine] engine start failed", { id, error: message });
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:error", {
          workspaceId: id,
          error: message,
        });
        if (
          workspace.workspaceType === "local" &&
          isWorkspaceFolderAccessDeniedError(message) &&
          deps.requestWorkspaceFolderAccess
        ) {
          deps.requestWorkspaceFolderAccess({
            workspaceId: id,
            workspacePath: workspace.path,
            requestedPath: workspace.path,
            reason: message,
          });
          deps.updateWorkspaceConnectionState(id, {
            status: "error",
            message: "Workspace folder access is required.",
          });
          deps.dispatchLifecycle?.({
            type: "failed",
            workspaceId: id,
            message,
          });
          return false;
        }
        setErrorForActiveWorkspace(id, message);
        deps.dispatchLifecycle?.({
          type: "failed",
          workspaceId: id,
          message,
        });
        return false;
      }
    });
  }

  return {
    connectToEngineQuiet,
    refreshActiveClient,
    ensureEngineForWorkspace,
  };
}
