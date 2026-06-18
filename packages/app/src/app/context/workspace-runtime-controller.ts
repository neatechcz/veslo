import type { Accessor } from "solid-js";

import type { OpencodeAuth } from "../lib/opencode";
import type { EngineInfo, WorkspaceInfo } from "../lib/tauri";
import type { Client, WorkspaceConnectionState } from "../types";
import { createSingleFlight } from "../utils";
import type { createLocalRuntimeLifecycle } from "../utils/local-runtime-lifecycle";
import { withTimeoutOrThrow } from "../utils/promise-timeout";
import type { ConnectToServer } from "./workspace-types";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";

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
};

export function createWorkspaceRuntimeController(deps: WorkspaceRuntimeControllerDeps) {
  const ensureEngineForWorkspaceSingleFlight = createSingleFlight<boolean>();

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
      deps.setError(detail ? `Failed to ensure workspace client: ${detail}` : "Failed to ensure workspace client");
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
    const id = workspaceId?.trim() || deps.activeWorkspaceId();
    const workspace = deps.workspaces().find((w) => w.id === id);
    if (!workspace?.path) return false;

    return await ensureEngineForWorkspaceSingleFlight(workspace.id || workspace.path, async () => {
      deps.wsLog("[workspace:ensureEngine] starting engine for browsing mode", { id, path: workspace.path });
      recordSendWorkflowTrace("workspace-runtime", "ensure-engine:start", {
        workspaceId: id,
        workspacePath: workspace.path,
        workspaceType: workspace.workspaceType,
        runtime: deps.resolveEngineRuntime(),
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

      if (deps.resolveEngineRuntime() !== "veslo-orchestrator") {
        deps.clearWorkspaceBusyAllExcept(workspace.id);
      }

      try {
        const skillsReady = await deps.syncWorkspaceSkillMaterializationBeforeRuntime(workspace, {
          reason: "browse-attach",
        });
        recordSendWorkflowTrace("workspace-runtime", "ensure-engine:skills-ready", {
          workspaceId: id,
          skillsReady,
        });
        if (!skillsReady) return false;

        let ok = false;
        try {
          const runtime = deps.resolveEngineRuntime();
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
            const reattachStartedAt = Date.now();
            ok = await deps.localRuntimeLifecycle.reattachOrchestratorWorkspace({
              workspacePath: workspace.path,
              workspaceId: workspace.id,
              workspaceName: workspace.displayName?.trim() || workspace.name?.trim() || null,
              reason: "browse-cold-start-reattach",
              connectMode: "quiet",
              navigate: false,
            });
            recordSendWorkflowTrace("workspace-runtime", "ensure-engine:reattach:done", {
              workspaceId: id,
              ok,
              durationMs: Date.now() - reattachStartedAt,
            });
          }
        }
        if (!ok) {
          recordSendWorkflowTrace("workspace-runtime", "ensure-engine:not-started", {
            workspaceId: id,
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
        deps.setError(message);
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
