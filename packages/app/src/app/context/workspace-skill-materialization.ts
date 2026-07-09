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
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";

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

export function isSkillRegistryMaterializationError(error: unknown): boolean {
  if (error instanceof VesloServerError) {
    const code = error.code.trim();
    if (code.startsWith("skill_registry_")) return true;
    return error.message.includes("Skill registry") || error.message.includes("skill registry");
  }
  const message = error instanceof Error ? error.message : safeStringify(error);
  return message.includes("Skill registry") || message.includes("skill registry");
}

const SKILL_REGISTRY_DIAGNOSTIC_KEYS = [
  "registryAction",
  "registryResource",
  "registryScope",
  "registryPath",
  "workspaceId",
  "versionId",
  "installationId",
  "skillId",
  "skillName",
  "rolloutPolicyId",
  "target",
  "source",
  "audience",
] as const;

function skillRegistryDetailsPayload(details: unknown): Record<string, string> {
  const record = details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
  const payload: Record<string, string> = {};
  for (const key of SKILL_REGISTRY_DIAGNOSTIC_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) payload[key] = value.trim();
  }
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (url && !payload.registryPath) {
    try {
      const parsed = new URL(url);
      payload.registryPath = `${parsed.pathname}${parsed.search}`;
    } catch {
      payload.registryPath = url;
    }
  }
  return payload;
}

function skillRegistryErrorTracePayload(error: VesloServerError) {
  return {
    code: error.code,
    message: error.message,
    status: error.status,
    ...skillRegistryDetailsPayload(error.details),
  };
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
    let observedMaterializationStatus: {
      registryConfigured: boolean;
      workspaceRegistryConfigured?: boolean;
      status?: string | null;
      reloadRequired?: boolean | null;
    } | null = null;
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
          trace("server-unavailable");
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
      if (!client) {
        trace("skip:no-client");
        return true;
      }

      const denAuth = readDenAuth();
      const materializationAuth = {
        denApiBase: denAuth?.denApiBase?.trim() || undefined,
        denToken: denAuth?.token?.trim() || undefined,
        denOrgId: denAuth?.orgId?.trim() || undefined,
        denUserId: denAuth?.user?.id?.trim() || undefined,
      };

      const status = await client.getWorkspaceSkillMaterializationStatus(workspaceId, materializationAuth);
      observedMaterializationStatus = {
        registryConfigured: status.registryConfigured,
        workspaceRegistryConfigured: status.workspaceRegistryConfigured,
        status: status.status,
        reloadRequired: status.reloadRequired ?? false,
      };
      trace("status", {
        registryConfigured: status.registryConfigured,
        workspaceRegistryConfigured: status.workspaceRegistryConfigured ?? null,
        status: status.status,
        reloadRequired: status.reloadRequired ?? false,
        registryError: status.registryError ?? null,
      });
      const workspaceRegistryUnavailable =
        !status.registryConfigured ||
        status.workspaceRegistryConfigured === false ||
        status.status === "not-configured";
      if (workspaceRegistryUnavailable) {
        deps.wsDebug("skills:materialization:skip:not-configured", {
          workspaceId,
          reason: context?.reason ?? null,
        });
        return true;
      }
      if (status.status === "degraded" && status.reloadRequired !== true) {
        deps.wsDebug("skills:materialization:degraded", {
          workspaceId,
          reason: context?.reason ?? null,
          registryError: status.registryError ?? null,
        });
        if (status.registryError) {
          reportError(
            new VesloServerError(
              status.registryError.status ?? 0,
              status.registryError.code,
              status.registryError.message,
              status.registryError,
            ),
            "workspace.skillMaterialization",
          );
        }
        return true;
      }

      const activeRun = Object.keys(deps.workspaceBusy()[workspace.id] ?? {}).length > 0;
      if (activeRun) {
        await client.syncWorkspaceSkillMaterialization(workspaceId, { ...materializationAuth, activeRun: true });
        trace("pending:active-run");
        deps.wsDebug("skills:materialization:pending:active-run", {
          workspaceId,
          reason: context?.reason ?? null,
        });
        return true;
      }

      if (status.status === "current" && status.reloadRequired !== true) {
        trace("skip:current");
        deps.wsDebug("skills:materialization:skip:current", {
          workspaceId,
          reason: context?.reason ?? null,
        });
        return true;
      }

      const result = await client.syncWorkspaceSkillMaterialization(workspaceId, materializationAuth);
      trace("synced", {
        status: result.status,
        synced: result.synced,
        reloadRequired: result.reloadRequired ?? false,
        materializedCount: result.materializedSkills.length,
        removedCount: result.removedSkillNames?.length ?? 0,
        registryError: result.registryError ?? null,
      });
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
      const message = error instanceof Error ? error.message : safeStringify(error);
      const configuredSyncRequired =
        observedMaterializationStatus?.registryConfigured === true &&
        (observedMaterializationStatus.status !== "current" ||
          observedMaterializationStatus.reloadRequired === true);
      if (isSkillRegistryMaterializationError(error)) {
        const registryError = error instanceof VesloServerError
          ? skillRegistryErrorTracePayload(error)
          : null;
        trace("degraded", {
          message,
          code: error instanceof VesloServerError ? error.code : null,
          status: error instanceof VesloServerError ? error.status : null,
          registryError,
        });
        deps.wsDebug("skills:materialization:degraded", {
          workspaceId,
          reason: context?.reason ?? null,
          message,
          registryError,
        });
        reportError(error, "workspace.skillMaterialization");
        return true;
      }
      const configuredSyncAuthOrRouteFailure =
        configuredSyncRequired &&
        error instanceof VesloServerError &&
        (error.status === 401 || error.status === 403 || error.status === 404);
      if (configuredSyncAuthOrRouteFailure) {
        trace("failed:configured-sync", {
          message,
          code: error.code,
          status: error.status,
          observedStatus: observedMaterializationStatus,
        });
        deps.wsDebug("skills:materialization:failed:configured-sync", {
          workspaceId,
          reason: context?.reason ?? null,
          message,
          status: error.status,
          observedStatus: observedMaterializationStatus,
        });
        deps.setError(addOpencodeCacheHint(message));
        deps.updateWorkspaceConnectionState(workspaceId, { status: "error", message });
        return true;
      }
      if (error instanceof VesloServerError && error.status === 404) {
        trace("skip:unsupported-server");
        deps.wsDebug("skills:materialization:skip:unsupported-server", {
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
      deps.setError(addOpencodeCacheHint(message));
      deps.updateWorkspaceConnectionState(workspaceId, { status: "error", message });
      return false;
    }
  }

  return { syncWorkspaceSkillMaterializationBeforeRuntime };
}
