import type { ScheduledJob } from "../tauri";
import type {
  VesloAuditEntry,
  VesloReloadEvent,
  VesloServerCapabilities,
  VesloServerDiagnostics,
  VesloSoulAuthContext,
  VesloWorkspaceExport,
  VesloWorkspaceInfo,
  VesloWorkspaceList,
  VesloWorkspaceSystemProvisionResult,
} from "../veslo-server/types";
import { workspacePath } from "./path";

type RequestJsonOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
};

export type WorkspaceClientContext = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  requestJson: <T>(baseUrl: string, path: string, options?: RequestJsonOptions) => Promise<T>;
  timeouts: {
    health: number;
    status: number;
    capabilities: number;
    listWorkspaces: number;
    activateWorkspace: number;
    addLocalWorkspace: number;
    deleteWorkspace: number;
    config: number;
    workspaceExport: number;
    workspaceImport: number;
    workspaceProvision: number;
  };
};

function buildDenContextHeaders(options?: VesloSoulAuthContext): Record<string, string> | undefined {
  const denApiBase = options?.denApiBase?.trim() ?? "";
  const denToken = options?.denToken?.trim() ?? "";
  const denOrgId = options?.denOrgId?.trim() ?? "";
  const denUserId = options?.denUserId?.trim() ?? "";
  const headers = {
    ...(denApiBase ? { "x-veslo-den-api-base": denApiBase } : {}),
    ...(denToken ? { "x-veslo-den-token": denToken } : {}),
    ...(denOrgId ? { "x-veslo-den-org-id": denOrgId } : {}),
    ...(denUserId ? { "x-veslo-den-user-id": denUserId } : {}),
  };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function createWorkspaceClient(context: WorkspaceClientContext) {
  const { baseUrl, token, hostToken, requestJson, timeouts } = context;

  return {
    health: () =>
      requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health", {
        token,
        hostToken,
        timeoutMs: timeouts.health,
      }),

    status: () =>
      requestJson<VesloServerDiagnostics>(baseUrl, "/status", {
        token,
        hostToken,
        timeoutMs: timeouts.status,
      }),

    statusForWorkspace: (workspaceId: string) =>
      requestJson<VesloServerDiagnostics>(baseUrl, `/w/${encodeURIComponent(workspaceId)}/status`, {
        token,
        hostToken,
        timeoutMs: timeouts.status,
      }),

    capabilities: () =>
      requestJson<VesloServerCapabilities>(baseUrl, "/capabilities", {
        token,
        hostToken,
        timeoutMs: timeouts.capabilities,
      }),

    list: () =>
      requestJson<VesloWorkspaceList>(baseUrl, "/workspaces", {
        token,
        hostToken,
        timeoutMs: timeouts.listWorkspaces,
      }),

    activate: (workspaceId: string) =>
      requestJson<{ activeId: string; workspace: VesloWorkspaceInfo }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/activate`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace },
      ),

    addLocal: (input: {
      path: string;
      name?: string;
      baseUrl?: string | null;
      directory?: string | null;
      opencodeUsername?: string | null;
      opencodePassword?: string | null;
    }) =>
      requestJson<{
        activeId: string;
        workspace: VesloWorkspaceInfo;
        items: VesloWorkspaceInfo[];
        persisted: boolean;
      }>(baseUrl, "/workspaces/local", {
        token,
        hostToken,
        method: "POST",
        body: {
          path: input.path,
          name: input.name,
          ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
          ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
          ...(input.opencodeUsername?.trim() ? { opencodeUsername: input.opencodeUsername.trim() } : {}),
          ...(input.opencodePassword?.trim() ? { opencodePassword: input.opencodePassword.trim() } : {}),
        },
        timeoutMs: timeouts.addLocalWorkspace,
      }),

    delete: (workspaceId: string) =>
      requestJson<{ ok: boolean; deleted: boolean; persisted: boolean; activeId: string | null; items: VesloWorkspaceInfo[] }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteWorkspace },
      ),

    export: (workspaceId: string) =>
      requestJson<VesloWorkspaceExport>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/export`, {
        token,
        hostToken,
        timeoutMs: timeouts.workspaceExport,
      }),

    import: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/import`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.workspaceImport,
      }),

    provisionSystem: (workspaceId: string, options?: VesloSoulAuthContext) =>
      requestJson<VesloWorkspaceSystemProvisionResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/system/provision`,
        {
          token,
          hostToken,
          method: "POST",
          extraHeaders: buildDenContextHeaders(options),
          timeoutMs: timeouts.workspaceProvision,
        },
      ),

    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; veslo: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `${workspacePath(workspaceId)}/config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    patchConfig: (workspaceId: string, payload: { opencode?: Record<string, unknown>; veslo?: Record<string, unknown> }) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `${workspacePath(workspaceId)}/config`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),

    listReloadEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: VesloReloadEvent[]; cursor?: number }>(
        baseUrl,
        `${workspacePath(workspaceId)}/events${query}`,
        { token, hostToken },
      );
    },

    reloadEngine: (workspaceId: string) =>
      requestJson<{ ok: boolean; reloadedAt?: number }>(baseUrl, `${workspacePath(workspaceId)}/engine/reload`, {
        token,
        hostToken,
        method: "POST",
      }),

    listAudit: (workspaceId: string, limit = 50) =>
      requestJson<{ items: VesloAuditEntry[] }>(baseUrl, `${workspacePath(workspaceId)}/audit?limit=${limit}`, {
        token,
        hostToken,
      }),

    listScheduledJobs: (workspaceId: string) =>
      requestJson<{ items: ScheduledJob[] }>(baseUrl, `${workspacePath(workspaceId)}/scheduler/jobs`, {
        token,
        hostToken,
      }),

    deleteScheduledJob: (workspaceId: string, name: string) =>
      requestJson<{ job: ScheduledJob }>(
        baseUrl,
        `${workspacePath(workspaceId)}/scheduler/jobs/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
  };
}

type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
