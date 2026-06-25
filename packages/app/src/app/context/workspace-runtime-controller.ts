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

const DEFAULT_CONNECT_HEALTH_TIMEOUT_MS = 12_000;
const CONNECT_LOAD_SESSIONS_TIMEOUT_MS = 20_000;

const messageFromUnknownError = (error: unknown, safeStringify: (value: unknown) => string) =>
  error instanceof Error ? error.message : safeStringify(error);

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
  syncWorkspaceSkillMaterializationBeforeRuntime: (
    workspace: WorkspaceInfo,
    options: { reason: string },
  ) => Promise<boolean>;
  createClient: (baseUrl: string, directory: string, auth?: OpencodeAuth) => Client;
  waitForHealthy: (
    client: Client,
    options: { timeoutMs: number },
  ) => Promise<{ version?: string | null }>;
  safeStringify: (value: unknown) => string;
  wsLog: (event: string, detail?: unknown) => void;
  dispatchLifecycle?: (event: WorkspaceLifecycleEvent) => void;
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
    const entry = workspaceId
      ? await deps.routing.ensure(workspaceId, baseUrl, {
          directory,
          auth,
          context: {
            workspaceType: context?.workspaceType,
            targetRoot: context?.targetRoot ?? directory,
            reason: context?.reason,
          },
        })
      : null;
    if (workspaceId && !entry) {
      const detail = deps.routing.lastEnsureError(workspaceId);
      setErrorForActiveWorkspace(
        workspaceId,
        detail ? `Failed to ensure workspace client: ${detail}` : "Failed to ensure workspace client",
      );
      recordSendWorkflowTrace("workspace-runtime", "connect-quiet:routing-error", {
        workspaceId,
        baseUrl,
        directory,
        reason: context?.reason ?? null,
        error: detail ?? null,
      });
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

  async function ensureEngineForWorkspace(workspaceId?: string | null): Promise<boolean> {
    const id = workspaceId?.trim() || deps.activeWorkspaceId().trim();
    const workspace = deps.workspaces().find((w) => w.id === id);
    if (!workspace?.path) return false;

    return await ensureEngineForWorkspaceSingleFlight(workspace.id || workspace.path, async () => {
      const runtime = deps.resolveEngineRuntime();
      deps.dispatchLifecycle?.({
        type: "runtime-starting",
        workspaceId: id,
        runtime,
        reason: "ensure-engine-for-workspace",
      });
      deps.wsLog("[workspace:ensureEngine] starting engine for browsing mode", { id, path: workspace.path });
      recordSendWorkflowTrace("workspace-runtime", "ensure-engine:start", {
        workspaceId: id,
        workspacePath: workspace.path,
        workspaceType: workspace.workspaceType,
        runtime,
        workspacesHydrated: deps.workspacesHydrated(),
      });

      if (!deps.workspacesHydrated()) {
        const start = Date.now();
        while (!deps.workspacesHydrated() && Date.now() - start < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:hydration-wait", {
          workspaceId: id,
          hydrated: deps.workspacesHydrated(),
          durationMs: Date.now() - start,
        });
      }

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

        const skillsReady = await deps.syncWorkspaceSkillMaterializationBeforeRuntime(workspace, {
          reason: "browse-attach",
        });
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:skills-ready", {
          workspaceId: id,
          skillsReady,
        });
        if (!skillsReady) {
          deps.dispatchLifecycle?.({
            type: "failed",
            workspaceId: id,
            message: "Workspace skills were not ready before runtime start",
          });
          return false;
        }

        let ok = false;
        const reattachOrchestratorAfterColdStart = async (reason: string, error?: unknown) => {
          const message = error === undefined ? "" : messageFromUnknownError(error, deps.safeStringify);
          deps.wsLog("[workspace:ensureEngine] startHost did not attach, trying orchestrator reattach...", {
            id,
            ...(message ? { error: message } : {}),
          });
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:start-host:not-started", {
            workspaceId: id,
            ...(message ? { error: message } : {}),
          });
          const reattachStartedAt = Date.now();
          const reattached = await deps.localRuntimeLifecycle.reattachOrchestratorWorkspace({
            workspacePath: workspace.path,
            workspaceId: workspace.id,
            workspaceName: workspace.displayName?.trim() || workspace.name?.trim() || null,
            reason,
            connectMode: "quiet",
            navigate: false,
          });
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:reattach:done", {
            workspaceId: id,
            ok: reattached,
            durationMs: Date.now() - reattachStartedAt,
          });
          return reattached;
        };
        try {
          const startedAt = Date.now();
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:restart-runtime:start", {
            workspaceId: id,
            workspacePath: workspace.path,
            runtime,
          });
          ok = await deps.localRuntimeLifecycle.restartWorkspaceRuntime({
            workspacePath: workspace.path,
            workspaceId: workspace.id,
            workspaceName: workspace.displayName?.trim() || workspace.name?.trim() || null,
            reason: runtime === "veslo-orchestrator" ? "browse-attach-orchestrator" : "browse-attach-direct",
            connectMode: "quiet",
          });
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:restart-runtime:done", {
            workspaceId: id,
            ok,
            durationMs: Date.now() - startedAt,
            runtime,
          });
        } catch (restartError) {
          deps.wsLog("[workspace:ensureEngine] restartWorkspaceRuntime failed, trying startHost...", {
            id,
            error: messageFromUnknownError(restartError, deps.safeStringify),
          });
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:restart-runtime:error", {
            workspaceId: id,
            error: messageFromUnknownError(restartError, deps.safeStringify),
          });
          try {
            const startHostStartedAt = Date.now();
            recordSendWorkflowTrace("workspace-runtime", "ensure-engine:start-host:start", {
              workspaceId: id,
              workspacePath: workspace.path,
            });
            ok = await deps.localRuntimeLifecycle.startHost({
              workspacePath: workspace.path,
              workspaceId: workspace.id,
              reason: "browse-cold-start",
              connectMode: "quiet",
              navigate: false,
            });
            recordSendWorkflowTrace("workspace-runtime", "ensure-engine:start-host:done", {
              workspaceId: id,
              ok,
              durationMs: Date.now() - startHostStartedAt,
            });
            if (!ok && runtime === "veslo-orchestrator") {
              ok = await reattachOrchestratorAfterColdStart("browse-cold-start-reattach");
            }
          } catch (startHostError) {
            if (
              deps.resolveEngineRuntime() !== "veslo-orchestrator" ||
              !messageFromUnknownError(startHostError, deps.safeStringify).includes("Request timed out")
            ) {
              throw startHostError;
            }
            deps.wsLog("[workspace:ensureEngine] startHost timed out, trying orchestrator reattach...", {
              id,
              error: messageFromUnknownError(startHostError, deps.safeStringify),
            });
            recordSendWorkflowTrace("workspace-runtime", "ensure-engine:start-host:error", {
              workspaceId: id,
              error: messageFromUnknownError(startHostError, deps.safeStringify),
            });
            ok = await reattachOrchestratorAfterColdStart("browse-cold-start-reattach", startHostError);
          }
        }
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
        const isActiveWorkspace = workspace.id === deps.activeWorkspaceId().trim();
        if (isActiveWorkspace) {
          deps.setEngineReady?.(true);
          deps.onEngineStable?.();
        }
        deps.updateWorkspaceConnectionState(id, { status: "connected", message: null });
        deps.dispatchLifecycle?.({
          type: "connected",
          workspaceId: id,
          runtime,
          reason: "ensure-engine-for-workspace",
        });
        deps.wsLog("[workspace:ensureEngine] engine started successfully", { id });
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:success", {
          workspaceId: id,
          activeWorkspace: isActiveWorkspace,
        });
        return true;
      } catch (e) {
        const message = messageFromUnknownError(e, deps.safeStringify);
        deps.wsLog("[workspace:ensureEngine] engine start failed", { id, error: message });
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:error", {
          workspaceId: id,
          error: message,
        });
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
