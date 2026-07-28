import {
  VesloServerError,
  type VesloServerClient,
} from "../lib/veslo-server";
import type { RuntimeSkillBinding, WorkspaceInfo } from "../lib/tauri";
import type { WorkspaceConnectionState } from "../types";
import { isTauriRuntime, safeStringify } from "../utils";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";

const EMPTY_RUNTIME_SKILL_BINDING: RuntimeSkillBinding = {
  revision: "empty-direct-skill-view/v1",
  authorizationRevision: "empty-direct-skill-authorization/v1",
};

export type WorkspaceSkillMaterializationGateDeps = {
  workspaceBusy: () => Record<string, Record<string, { startedAt: number }>>;
  ensureLocalVesloServerRunning?: (options?: { requireRuntimeChainReady?: boolean }) => Promise<boolean>;
  vesloServerClient?: () => VesloServerClient | null;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  setError: (value: string | null) => void;
  updateWorkspaceConnectionState: (
    workspaceId: string,
    next: Partial<WorkspaceConnectionState>,
  ) => void;
  wsDebug: (label: string, payload?: unknown) => void;
};

export function createWorkspaceSkillMaterializationGate(
  deps: WorkspaceSkillMaterializationGateDeps,
) {
  const runtimePreparationFlights = new Map<string, Promise<boolean>>();
  /**
   * A binding belongs to the workspace *path* it was resolved for, not just to
   * the workspace id. Ids can be reused and a workspace can be repointed, and a
   * binding carried across either change would hand the runtime a skill view
   * that was never agreed for it.
   */
  const runtimeViewBindings = new Map<
    string,
    { binding: RuntimeSkillBinding; workspacePath: string }
  >();
  /**
   * Monotonic per workspace so a slow preparation cannot publish over the
   * result of a newer one that already finished.
   */
  const runtimeViewEpochs = new Map<string, number>();

  const beginRuntimeViewEpoch = (workspaceId: string): number => {
    const next = (runtimeViewEpochs.get(workspaceId) ?? 0) + 1;
    runtimeViewEpochs.set(workspaceId, next);
    return next;
  };

  const publishRuntimeView = (
    workspaceId: string,
    workspacePath: string,
    epoch: number,
    binding: RuntimeSkillBinding,
  ) => {
    if (runtimeViewEpochs.get(workspaceId) !== epoch) return;
    runtimeViewBindings.set(workspaceId, { binding, workspacePath });
  };

  async function prepareWorkspaceSkillRuntimeView(
    workspace: WorkspaceInfo,
    context?: { reason?: string; skipServingViewRefresh?: boolean },
  ) {
    const workspaceId = workspace.id?.trim() ?? "";
    if (!workspaceId) return true;
    const workspacePath = workspace.path?.trim() ?? "";
    const epoch = beginRuntimeViewEpoch(workspaceId);
    const selectEmptyRuntimeView = () =>
      publishRuntimeView(
        workspaceId,
        workspacePath,
        epoch,
        EMPTY_RUNTIME_SKILL_BINDING,
      );
    const trace = (event: string, payload?: Record<string, unknown>) => {
      recordSendWorkflowTrace("workspace-skill-materialization", event, {
        workspaceId,
        reason: context?.reason ?? null,
        ...payload,
      });
    };

    // Missing-live-binding recovery only needs an engine-reachable binding. It
    // must never wait on the Skills control plane: retain a same-path serving
    // binding when one exists, otherwise use canonical empty immediately.
    if (context?.skipServingViewRefresh) {
      const current = runtimeViewBindings.get(workspaceId);
      const binding = current?.workspacePath === workspacePath
        ? current.binding
        : EMPTY_RUNTIME_SKILL_BINDING;
      publishRuntimeView(workspaceId, workspacePath, epoch, binding);
      trace(current?.workspacePath === workspacePath
        ? "active-binding-reused-without-refresh"
        : "canonical-empty-selected-without-refresh");
      return true;
    }

    try {
      trace("start", {
        workspaceType: workspace.workspaceType ?? null,
        localTauri: Boolean(isTauriRuntime() && workspace.workspaceType === "local"),
      });
      if (isTauriRuntime() && workspace.workspaceType === "local") {
        const ensured = await deps.ensureLocalVesloServerRunning?.({ requireRuntimeChainReady: false });
        if (ensured === false) {
          selectEmptyRuntimeView();
          trace("server-unavailable");
          deps.wsDebug("skills:runtime-view:server-unavailable", {
            workspaceId,
            reason: context?.reason ?? null,
          });
          return true;
        }
      }

      const client = deps.vesloServerClient?.();
      if (!client) {
        selectEmptyRuntimeView();
        trace("skip:no-client");
        return true;
      }

      // Runtime activation resolves only the server-owned effective manifest.
      // Registry materialization belongs to registry events and explicit Skill
      // operations; ordinary start/send must not create that work.
      const ensureActiveRuntimeManifest = async (): Promise<void> => {
        if (typeof client.prepareRuntimeSkillView !== "function") {
          trace("active-manifest-unsupported");
          return;
        }
        const active = await client.prepareRuntimeSkillView(
          workspaceId,
          undefined,
        );
        publishRuntimeView(workspaceId, workspacePath, epoch, {
          revision: active.revision,
          authorizationRevision: active.authorizationRevision,
        });
        trace("active-manifest-ready", {
          activeCount: active.activeCount,
          revision: active.revision,
          authorizationRevision: active.authorizationRevision,
        });
      };

      // Read the already-published selection before native activation captures
      // it. This is not a freshness/materialization gate: the server returns
      // either its current serving binding or canonical empty. Any read failure
      // degrades to the same explicit empty binding and runtime still starts.
      await ensureActiveRuntimeManifest();
      trace("active-binding-selected");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      selectEmptyRuntimeView();
      if (error instanceof VesloServerError && error.status === 404) {
        trace("active-manifest-unsupported");
        deps.wsDebug("skills:runtime-view:unsupported-server", {
          workspaceId,
          reason: context?.reason ?? null,
        });
        return true;
      }
      trace("failed", {
        message,
        code: error instanceof VesloServerError ? error.code : null,
        status: error instanceof VesloServerError ? error.status : null,
      });
      deps.wsDebug("skills:materialization:failed", {
        workspaceId,
        reason: context?.reason ?? null,
        message,
      });
      return true;
    }
  }

  async function syncWorkspaceSkillMaterializationBeforeRuntime(
    workspace: WorkspaceInfo,
    context?: { reason?: string; skipServingViewRefresh?: boolean },
  ): Promise<boolean> {
    const workspaceId = workspace.id?.trim() ?? "";
    const workspacePath = workspace.path?.trim() ?? "";
    if (!workspaceId || !workspacePath) return true;
    const key = `${workspaceId}\u0000${workspacePath}`;
    const existing = runtimePreparationFlights.get(key);
    if (existing) return await existing;
    const flight = prepareWorkspaceSkillRuntimeView(workspace, context);
    runtimePreparationFlights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (runtimePreparationFlights.get(key) === flight) runtimePreparationFlights.delete(key);
    }
  }

  return {
    syncWorkspaceSkillMaterializationBeforeRuntime,
    /**
     * A binding resolved for a different path is treated as absent so the
     * caller re-resolves, rather than sending a stale view to the runtime.
     */
    runtimeSkillBinding: (
      workspaceId: string,
      workspacePath?: string,
    ): RuntimeSkillBinding | null => {
      const stored = runtimeViewBindings.get(workspaceId.trim());
      if (!stored) return null;
      const expectedPath = workspacePath?.trim();
      if (expectedPath && stored.workspacePath !== expectedPath) return null;
      return stored.binding;
    },
    /**
     * Called when a workspace is removed so its binding cannot outlive it.
     * Keep an incremented epoch tombstone: an older asynchronous preparation
     * may still settle after the same workspace id has been reused.
     */
    forgetWorkspaceRuntimeBinding: (workspaceId: string) => {
      const key = workspaceId.trim();
      if (!key) return;
      runtimeViewBindings.delete(key);
      beginRuntimeViewEpoch(key);
    },
  };
}
