import { currentLocale as __vesloIndirectLocale, t as __vesloIndirectT } from "../../i18n";
import { reportError } from "../lib/error-reporter";
import { readDenAuth } from "../lib/den-auth";
import {
  VesloServerError,
  type VesloServerClient,
} from "../lib/veslo-server";
import type { WorkspaceInfo } from "../lib/tauri";
import type { WorkspaceConnectionState } from "../types";
import {
  addOpencodeCacheHint,
  isTauriRuntime,
  safeStringify,
} from "../utils";

export type WorkspaceSkillMaterializationGateDeps = {
  workspaceBusy: () => Record<string, { sessionId: string; startedAt: number }>;
  ensureLocalVesloServerRunning?: () => Promise<boolean>;
  vesloServerClient?: () => VesloServerClient | null;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  setError: (value: string | null) => void;
  updateWorkspaceConnectionState: (
    workspaceId: string,
    next: Partial<WorkspaceConnectionState>,
  ) => void;
  wsDebug: (label: string, payload?: unknown) => void;
};

export function isSkillRegistryMaterializationError(error: unknown): boolean {
  if (error instanceof VesloServerError) {
    const code = error.code.trim();
    if (code.startsWith("skill_registry_")) return true;
    return error.message.includes("Skill registry") || error.message.includes("skill registry");
  }
  const message = error instanceof Error ? error.message : safeStringify(error);
  return message.includes("Skill registry") || message.includes("skill registry");
}

export function createWorkspaceSkillMaterializationGate(
  deps: WorkspaceSkillMaterializationGateDeps,
) {
  async function syncWorkspaceSkillMaterializationBeforeRuntime(
    workspace: WorkspaceInfo,
    context?: { reason?: string },
  ) {
    const workspaceId = workspace.id?.trim() ?? "";
    if (!workspaceId) return true;

    try {
      if (isTauriRuntime() && workspace.workspaceType === "local") {
        const ensured = await deps.ensureLocalVesloServerRunning?.();
        if (ensured === false) {
          deps.wsDebug("skills:materialization:failed:server-unavailable", {
            workspaceId,
            reason: context?.reason ?? null,
          });
          deps.updateWorkspaceConnectionState(workspaceId, {
            status: "error",
            message: __vesloIndirectT("ui.indirect.veslo_server_unavailable_failed_to_prepare_wor_y4yrip", __vesloIndirectLocale()),
          });
          return false;
        }
      }

      const client = deps.vesloServerClient?.();
      if (!client) return true;

      const denAuth = readDenAuth();
      const materializationAuth = {
        denApiBase: denAuth?.denApiBase?.trim() || undefined,
        denToken: denAuth?.token?.trim() || undefined,
        denOrgId: denAuth?.orgId?.trim() || undefined,
        denUserId: denAuth?.user?.id?.trim() || undefined,
      };

      const status = await client.getWorkspaceSkillMaterializationStatus(workspaceId);
      if (!status.registryConfigured) {
        deps.wsDebug("skills:materialization:skip:not-configured", {
          workspaceId,
          reason: context?.reason ?? null,
        });
        return true;
      }

      const activeRun = Boolean(deps.workspaceBusy()[workspace.id]);
      if (activeRun) {
        await client.syncWorkspaceSkillMaterialization(workspaceId, { ...materializationAuth, activeRun: true });
        deps.wsDebug("skills:materialization:pending:active-run", {
          workspaceId,
          reason: context?.reason ?? null,
        });
        return true;
      }

      if (status.status === "current" && status.reloadRequired !== true) {
        deps.wsDebug("skills:materialization:skip:current", {
          workspaceId,
          reason: context?.reason ?? null,
        });
        return true;
      }

      const result = await client.syncWorkspaceSkillMaterialization(workspaceId, materializationAuth);
      deps.wsDebug("skills:materialization:synced", {
        workspaceId,
        reason: context?.reason ?? null,
        status: result.status,
        synced: result.synced,
        reloadRequired: result.reloadRequired ?? false,
        materializedCount: result.materializedSkills.length,
        removedCount: result.removedSkillNames?.length ?? 0,
      });
      if (result.synced || result.reloadRequired === true) {
        deps.refreshSkills({ force: true }).catch(e => reportError(e, "workspace.refreshSkills"));
      }
      return true;
    } catch (error) {
      if (error instanceof VesloServerError && error.status === 404) {
        deps.wsDebug("skills:materialization:skip:unsupported-server", {
          workspaceId,
          reason: context?.reason ?? null,
        });
        return true;
      }
      const message = error instanceof Error ? error.message : safeStringify(error);
      if (isSkillRegistryMaterializationError(error)) {
        deps.wsDebug("skills:materialization:degraded", {
          workspaceId,
          reason: context?.reason ?? null,
          message,
        });
        reportError(error, "workspace.skillMaterialization");
        return true;
      }
      deps.wsDebug("skills:materialization:failed", {
        workspaceId,
        reason: context?.reason ?? null,
        message,
      });
      deps.setError(addOpencodeCacheHint(message));
      deps.updateWorkspaceConnectionState(workspaceId, { status: "error", message });
      return false;
    }
  }

  return { syncWorkspaceSkillMaterializationBeforeRuntime };
}
