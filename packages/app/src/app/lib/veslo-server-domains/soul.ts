import type {
  VesloSoulAuthContext,
  VesloSoulMaterializationResult,
  VesloSoulOverviewResponse,
  VesloSoulReadResponse,
  VesloSoulRestoreInput,
  VesloSoulScope,
  VesloSoulUpdateInput,
  VesloSoulVersionGetOptions,
  VesloSoulVersionListOptions,
  VesloSoulVersionResponse,
  VesloSoulVersionsResponse,
  VesloWorkspaceSoulsResponse,
} from "../veslo-server/types";
import { buildDenContextHeaders } from "../veslo-server/header-profiles";

type RequestJsonOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
};

export type SoulClientContext = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  requestJson: <T>(baseUrl: string, path: string, options?: RequestJsonOptions) => Promise<T>;
  timeoutMs: number;
};

function setTrimmedSearchParam(search: URLSearchParams, key: string, value?: string | null) {
  const normalized = value?.trim() ?? "";
  if (normalized) search.set(key, normalized);
}

function activeWorkspaceIdsPayload(input?: {
  activeWorkspaceIds?: string[];
  activeRun?: boolean;
}): { activeWorkspaceIds?: string[]; activeRun?: boolean } {
  const activeWorkspaceIds = [
    ...new Set((input?.activeWorkspaceIds ?? []).map((item) => item.trim()).filter(Boolean)),
  ];
  return {
    ...(activeWorkspaceIds.length ? { activeWorkspaceIds } : {}),
    ...(input?.activeRun === true ? { activeRun: true } : {}),
  };
}

function soulRestoreBody(
  input?: VesloSoulRestoreInput,
): { changeSummary?: string; activeWorkspaceIds?: string[]; activeRun?: boolean } | undefined {
  if (!input) return undefined;
  const body = {
    ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
    ...activeWorkspaceIdsPayload(input),
  };
  return Object.keys(body).length ? body : undefined;
}

function buildSoulVersionsPath(scope: VesloSoulScope, options?: VesloSoulVersionListOptions) {
  const search = new URLSearchParams();
  if (scope === "workspace") {
    setTrimmedSearchParam(search, "workspaceId", options?.workspaceId);
  } else {
    setTrimmedSearchParam(search, "cursor", options?.cursor);
    if (typeof options?.limit === "number" && Number.isSafeInteger(options.limit) && options.limit > 0) {
      search.set("limit", String(options.limit));
    }
  }
  const suffix = search.toString();
  return `/soul/${encodeURIComponent(scope)}/versions${suffix ? `?${suffix}` : ""}`;
}

function buildSoulVersionPath(scope: VesloSoulScope, versionId: string, options?: VesloSoulVersionGetOptions) {
  const search = new URLSearchParams();
  if (scope === "workspace") {
    setTrimmedSearchParam(search, "workspaceId", options?.workspaceId);
  }
  const suffix = search.toString();
  return `/soul/${encodeURIComponent(scope)}/versions/${encodeURIComponent(versionId)}${suffix ? `?${suffix}` : ""}`;
}

function soulUpdateBody(input: VesloSoulUpdateInput) {
  return {
    content: input.content,
    changeSummary: input.changeSummary,
    baseVersionId: input.baseVersionId,
    ...activeWorkspaceIdsPayload(input),
  };
}

export function createSoulClient(context: SoulClientContext) {
  const { baseUrl, token, hostToken, requestJson, timeoutMs } = context;

  return {
    overview: (options?: VesloSoulAuthContext) =>
      requestJson<VesloSoulOverviewResponse>(baseUrl, "/soul", {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs,
      }),

    getOrganization: (options?: VesloSoulAuthContext) =>
      requestJson<VesloSoulReadResponse>(baseUrl, "/soul/organization", {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs,
      }),

    getUser: (options?: VesloSoulAuthContext) =>
      requestJson<VesloSoulReadResponse>(baseUrl, "/soul/user", {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs,
      }),

    listWorkspaces: (options?: VesloSoulAuthContext) =>
      requestJson<VesloWorkspaceSoulsResponse>(baseUrl, "/soul/workspaces", {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs,
      }),

    getWorkspace: (workspaceId: string, options?: VesloSoulAuthContext) =>
      requestJson<VesloSoulReadResponse>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/soul`, {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs,
      }),

    listVersions: (scope: VesloSoulScope, options?: VesloSoulVersionListOptions) =>
      requestJson<VesloSoulVersionsResponse>(baseUrl, buildSoulVersionsPath(scope, options), {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs,
      }),

    getVersion: (scope: VesloSoulScope, versionId: string, options?: VesloSoulVersionGetOptions) =>
      requestJson<VesloSoulVersionResponse>(baseUrl, buildSoulVersionPath(scope, versionId, options), {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
        timeoutMs,
      }),

    updateOrganization: (input: VesloSoulUpdateInput) =>
      requestJson<VesloSoulReadResponse>(baseUrl, "/soul/organization", {
        token,
        hostToken,
        method: "PATCH",
        body: soulUpdateBody(input),
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs,
      }),

    updateUser: (input: VesloSoulUpdateInput) =>
      requestJson<VesloSoulReadResponse>(baseUrl, "/soul/user", {
        token,
        hostToken,
        method: "PATCH",
        body: soulUpdateBody(input),
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs,
      }),

    restoreOrganizationVersion: (versionId: string, input?: VesloSoulRestoreInput) =>
      requestJson<VesloSoulReadResponse>(
        baseUrl,
        `/soul/organization/versions/${encodeURIComponent(versionId)}/restore`,
        {
          token,
          hostToken,
          method: "POST",
          body: soulRestoreBody(input),
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs,
        },
      ),

    restoreUserVersion: (versionId: string, input?: VesloSoulRestoreInput) =>
      requestJson<VesloSoulReadResponse>(
        baseUrl,
        `/soul/user/versions/${encodeURIComponent(versionId)}/restore`,
        {
          token,
          hostToken,
          method: "POST",
          body: soulRestoreBody(input),
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs,
        },
      ),

    updateWorkspace: (workspaceId: string, input: VesloSoulUpdateInput) =>
      requestJson<VesloSoulReadResponse>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/soul`, {
        token,
        hostToken,
        method: "PATCH",
        body: soulUpdateBody(input),
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs,
      }),

    restoreWorkspaceVersion: (workspaceId: string, versionId: string, input?: VesloSoulRestoreInput) =>
      requestJson<VesloSoulReadResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/soul/versions/${encodeURIComponent(versionId)}/restore`,
        {
          token,
          hostToken,
          method: "POST",
          body: soulRestoreBody(input),
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs,
        },
      ),

    syncWorkspaceMaterialization: (
      workspaceId: string,
      options?: VesloSoulAuthContext & { activeRun?: boolean },
    ) =>
      requestJson<VesloSoulMaterializationResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/soul/materialization/sync`,
        {
          token,
          hostToken,
          method: "POST",
          body: options?.activeRun === true ? { activeRun: true } : undefined,
          extraHeaders: buildDenContextHeaders(options),
          timeoutMs,
        },
      ),

    setWorkspaceHeartbeat: (workspaceId: string, enabled: boolean, options?: VesloSoulAuthContext) =>
      requestJson<VesloSoulReadResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/soul/heartbeat-toggle`,
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled },
          extraHeaders: buildDenContextHeaders(options),
          timeoutMs,
        },
      ),
  };
}

export type SoulClient = ReturnType<typeof createSoulClient>;
