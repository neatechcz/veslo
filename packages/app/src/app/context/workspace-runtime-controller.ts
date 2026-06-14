import type { Accessor } from "solid-js";

import type { OpencodeAuth } from "../lib/opencode";
import type { EngineInfo, WorkspaceInfo } from "../lib/tauri";
import type { Client, WorkspaceConnectionState } from "../types";
import { createSingleFlight } from "../utils";
import type { createLocalRuntimeLifecycle } from "../utils/local-runtime-lifecycle";
import { withTimeoutOrThrow } from "../utils/promise-timeout";
import type { ConnectToServer } from "./workspace-types";

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
  ): Promise<boolean> {
    const nextClient = deps.createClient(baseUrl, directory, auth);
    const health = await deps.waitForHealthy(nextClient, { timeoutMs: DEFAULT_CONNECT_HEALTH_TIMEOUT_MS });
    deps.setClient(nextClient);
    deps.setConnectedVersion(health.version ?? null);
    deps.setBaseUrl(baseUrl);
    deps.setClientDirectory(directory);
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

      if (!deps.workspacesHydrated()) {
        const start = Date.now();
        while (!deps.workspacesHydrated() && Date.now() - start < 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      if (deps.resolveEngineRuntime() !== "veslo-orchestrator") {
        deps.clearWorkspaceBusyAllExcept(workspace.id);
      }

      try {
        const skillsReady = await deps.syncWorkspaceSkillMaterializationBeforeRuntime(workspace, {
          reason: "browse-attach",
        });
        if (!skillsReady) return false;

        let ok = false;
        try {
          const runtime = deps.resolveEngineRuntime();
          ok = await deps.localRuntimeLifecycle.restartWorkspaceRuntime({
            workspacePath: workspace.path,
            workspaceId: workspace.id,
            workspaceName: workspace.displayName?.trim() || workspace.name?.trim() || null,
            reason: runtime === "veslo-orchestrator" ? "browse-attach-orchestrator" : "browse-attach-direct",
            connectMode: "quiet",
          });
        } catch (restartError) {
          deps.wsLog("[workspace:ensureEngine] restartWorkspaceRuntime failed, trying startHost...", {
            id,
            error: messageFromUnknownError(restartError, deps.safeStringify),
          });
          try {
            ok = await deps.localRuntimeLifecycle.startHost({
              workspacePath: workspace.path,
              workspaceId: workspace.id,
              reason: "browse-cold-start",
              connectMode: "quiet",
              navigate: false,
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
            ok = await deps.localRuntimeLifecycle.reattachOrchestratorWorkspace({
              workspacePath: workspace.path,
              workspaceId: workspace.id,
              workspaceName: workspace.displayName?.trim() || workspace.name?.trim() || null,
              reason: "browse-cold-start-reattach",
              connectMode: "quiet",
              navigate: false,
            });
          }
        }
        if (!ok) return false;

        try {
          await withTimeoutOrThrow(deps.loadSessions(workspace.path), {
            timeoutMs: CONNECT_LOAD_SESSIONS_TIMEOUT_MS,
            label: "loadSessions",
          });
        } catch (loadSessionsError) {
          deps.wsLog("[workspace:ensureEngine] loadSessions failed; continuing first prompt", {
            id,
            error: messageFromUnknownError(loadSessionsError, deps.safeStringify),
          });
        }
        deps.setEngineReady?.(true);
        deps.updateWorkspaceConnectionState(id, { status: "connected", message: null });
        deps.onEngineStable?.();
        deps.wsLog("[workspace:ensureEngine] engine started successfully", { id });
        return true;
      } catch (e) {
        const message = messageFromUnknownError(e, deps.safeStringify);
        deps.wsLog("[workspace:ensureEngine] engine start failed", { id, error: message });
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
