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
  const runtimeViewBindings = new Map<string, RuntimeSkillBinding>();

  const selectEmptyRuntimeView = (workspaceId: string) => {
    runtimeViewBindings.set(workspaceId, EMPTY_RUNTIME_SKILL_BINDING);
  };

  async function prepareWorkspaceSkillRuntimeView(
    workspace: WorkspaceInfo,
    context?: { reason?: string },
  ) {
    const workspaceId = workspace.id?.trim() ?? "";
    if (!workspaceId) return true;
    const trace = (event: string, payload?: Record<string, unknown>) => {
      recordSendWorkflowTrace("workspace-skill-materialization", event, {
        workspaceId,
        reason: context?.reason ?? null,
        ...payload,
      });
    };

    try {
      trace("start", {
        workspaceType: workspace.workspaceType ?? null,
        localTauri: Boolean(isTauriRuntime() && workspace.workspaceType === "local"),
      });
      if (isTauriRuntime() && workspace.workspaceType === "local") {
        const ensured = await deps.ensureLocalVesloServerRunning?.({ requireRuntimeChainReady: false });
        if (ensured === false) {
          selectEmptyRuntimeView(workspaceId);
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
        selectEmptyRuntimeView(workspaceId);
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
        runtimeViewBindings.set(workspaceId, {
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
      selectEmptyRuntimeView(workspaceId);
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
    context?: { reason?: string },
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
    runtimeSkillBinding: (workspaceId: string) => runtimeViewBindings.get(workspaceId.trim()) ?? null,
  };
}
