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

export type RuntimeSkillViewConflict =
  | "skill_view_changed"
  | "skill_view_stale"
  | "skill_view_deferred";

export type RuntimeSkillViewRefreshContext = {
  conflict: RuntimeSkillViewConflict;
  reason:
    | "skill-view-changed-retry"
    | "skill-view-stale-retry"
    | "skill-view-deferred-retry";
};

const DEFERRED_REFRESH_FALLBACK_MS = 250;
const DEFERRED_REFRESH_MAX_WAIT_MS = 5_000;

/**
 * A failed refresh should not expose the orchestrator's raw 409 envelope to
 * people using the desktop app. Keep the code for traces/tests while giving
 * the UI one actionable explanation of the completed recovery attempt.
 */
export class RuntimeSkillViewRefreshError extends Error {
  readonly code: RuntimeSkillViewConflict;
  readonly phase: "refresh" | "retry";

  constructor(conflict: RuntimeSkillViewConflict, phase: "refresh" | "retry") {
    const changed = conflict === "skill_view_changed";
    const deferred = conflict === "skill_view_deferred";
    super(
      deferred
        ? "Veslo is still finishing an active run before it can apply this workspace's skills, so the engine was not started. Wait for the run to end and try again."
        : phase === "refresh"
          ? changed
            ? "Workspace skills changed while Veslo was starting the engine. Veslo could not refresh the skill view, so the engine was not started. Resolve any Skills sync error and try again."
            : "The workspace skill view was out of date. Veslo could not refresh it, so the engine was not started. Try again after the workspace finishes loading."
          : changed
            ? "Workspace skills kept changing while Veslo was starting the engine. Veslo refreshed the skill view and retried, but the files changed again each time. Finish the skill sync or file edit, then try again."
            : "The workspace skill view was refreshed, but it became stale again before the engine started. Try again after the workspace finishes loading.",
    );
    this.name = "RuntimeSkillViewRefreshError";
    this.code = conflict;
    this.phase = phase;
  }
}

export function runtimeSkillViewConflict(error: unknown): RuntimeSkillViewConflict | null {
  const message = error instanceof Error ? error.message : safeStringify(error);
  // Order matters: these envelopes also carry a skill view revision, so match
  // their own markers before the generic ones.
  if (message.includes("directory_skill_view_refresh_deferred")) return "skill_view_deferred";
  // The engine is mid-run on an older view. Like a deferred refresh, the only
  // remedy is waiting for it to go idle — not re-resolving a healthy view.
  if (message.includes("skill_view_busy")) return "skill_view_deferred";
  if (message.includes("skill_view_changed")) return "skill_view_changed";
  if (message.includes("skill_view_stale")) return "skill_view_stale";
  return null;
}

/**
 * A deferred refresh is the orchestrator draining an active run before it
 * republishes a directory-scoped view. Nothing is wrong and there is nothing to
 * refresh; the caller is told how long to wait. Honour that hint instead of
 * surfacing a transient drain as a failed activation.
 */
export function runtimeSkillViewRetryAfterMs(error: unknown): number {
  const message = error instanceof Error ? error.message : safeStringify(error);
  const parsed = Number(/"retryAfterMs"\s*:\s*(\d+)/.exec(message)?.[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFERRED_REFRESH_FALLBACK_MS;
  return Math.min(parsed, DEFERRED_REFRESH_MAX_WAIT_MS);
}

/**
 * The cross-process workspace skill lease closes the race between Veslo's own
 * writers, but nothing can stop an editor save, a sync client, or a branch
 * switch from landing mid-activation. Those settle in well under a second, so
 * more than one retry is what separates a transient conflict from a real
 * "finish your edit" situation.
 */
const RUNTIME_SKILL_VIEW_RETRY_LIMIT = 2;

/**
 * The server owns the effective manifest and the desktop owns process
 * activation. Every app activation path must bridge the retries at this exact
 * boundary; placing it here prevents host-start and workspace-switch paths
 * from drifting apart.
 */
export async function prepareRuntimeWithSkillViewRefresh<T>(input: {
  prepare: () => Promise<T>;
  refresh: (context: RuntimeSkillViewRefreshContext) => Promise<boolean>;
  onRetry?: (context: RuntimeSkillViewRefreshContext) => void;
  retryLimit?: number;
  /** Injectable so tests do not pay the orchestrator's real drain hint. */
  wait?: (ms: number) => Promise<void>;
}): Promise<T> {
  const retryLimit = input.retryLimit ?? RUNTIME_SKILL_VIEW_RETRY_LIMIT;
  const wait =
    input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // The UI explains the conflict the user actually hit first; a later attempt
  // failing as "stale" instead of "changed" is noise from the same root cause.
  let firstConflict: RuntimeSkillViewConflict | null = null;

  for (let retries = 0; ; retries += 1) {
    try {
      return await input.prepare();
    } catch (error) {
      const conflict = runtimeSkillViewConflict(error);
      if (!conflict) throw error;
      firstConflict ??= conflict;
      if (retries >= retryLimit) {
        throw new RuntimeSkillViewRefreshError(firstConflict, "retry");
      }
      const context: RuntimeSkillViewRefreshContext = {
        conflict,
        reason:
          conflict === "skill_view_changed"
            ? "skill-view-changed-retry"
            : conflict === "skill_view_deferred"
              ? "skill-view-deferred-retry"
              : "skill-view-stale-retry",
      };
      input.onRetry?.(context);
      // A drain is not a stale view: the orchestrator is finishing an active run
      // before it republishes. Waiting is the whole remedy, and asking the
      // server to re-resolve would only invalidate a view that is already fine.
      if (conflict === "skill_view_deferred") {
        await wait(runtimeSkillViewRetryAfterMs(error));
        continue;
      }
      let refreshed = false;
      try {
        refreshed = await input.refresh(context);
      } catch {
        throw new RuntimeSkillViewRefreshError(firstConflict, "refresh");
      }
      if (!refreshed) throw new RuntimeSkillViewRefreshError(firstConflict, "refresh");
    }
  }
}

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
  const runtimePreparationFlights = new Map<string, Promise<boolean>>();
  const runtimeViewRevisions = new Map<string, string>();

  async function prepareWorkspaceSkillRuntimeView(
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

      // The orchestrator stages the effective-skill view synchronously while
      // starting the engine. Force the server to resolve the active workspace
      // skills now so the manifest exists before prepareWorkspaceRuntime()
      // starts the process. This is intentionally separate from registry
      // materialization: local-only workspaces need the same guarantee.
      const ensureActiveRuntimeManifest = async (): Promise<void> => {
        if (typeof client.prepareRuntimeSkillView !== "function") {
          trace("active-manifest-unsupported");
          return;
        }
        const forceRefresh =
          context?.reason === "skill-view-changed-retry" ||
          context?.reason === "skill-view-stale-retry";
        const active = await client.prepareRuntimeSkillView(
          workspaceId,
          forceRefresh ? { forceRefresh: true } : undefined,
        );
        runtimeViewRevisions.set(workspaceId, active.revision);
        trace("active-manifest-ready", { activeCount: active.activeCount, revision: active.revision });
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
        await ensureActiveRuntimeManifest();
        deps.wsDebug("skills:materialization:skip:not-configured", {
          workspaceId,
          reason: context?.reason ?? null,
        });
        return true;
      }
      if (status.status === "degraded" && status.reloadRequired !== true) {
        await ensureActiveRuntimeManifest();
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
        await ensureActiveRuntimeManifest();
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
      await ensureActiveRuntimeManifest();
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
    runtimeSkillViewRevision: (workspaceId: string) => runtimeViewRevisions.get(workspaceId.trim()) ?? null,
  };
}
