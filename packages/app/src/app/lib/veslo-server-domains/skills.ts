import type {
  VesloDisabledSkillsResponse,
  VesloGlobalSkillMaterializationStatus,
  VesloGlobalSkillMaterializationSyncResult,
  VesloHubSkillItem,
  VesloSkillBatchRemoveRequest,
  VesloSkillBatchRemoveResponse,
  VesloSkillContent,
  VesloSkillFilesContent,
  VesloSkillEnabledStateResponse,
  VesloSkillEnabledTarget,
  VesloSkillImportCandidatesResponse,
  VesloSkillImportResult,
  VesloSkillItem,
  VesloSkillMaterializationRequestOptions,
  VesloSkillMaterializationStatus,
  VesloSkillMaterializationSyncOptions,
  VesloSkillMaterializationSyncResult,
  VesloSkillRegistryAuthContext,
  VesloSkillRegistryCreateInstallationInput,
  VesloSkillRegistryCreateReviewRequestInput,
  VesloSkillRegistryCreateRolloutPolicyInput,
  VesloSkillRegistryCreateSkillInput,
  VesloSkillRegistryCreateVersionInput,
  VesloSkillRegistryInstallationResponse,
  VesloSkillRegistryListRolloutPoliciesInput,
  VesloSkillRegistryListVersionsInput,
  VesloSkillRegistryReplaceWorkspaceSkillSetInput,
  VesloSkillRegistryRestoreInstallationInput,
  VesloSkillRegistryReviewDecisionInput,
  VesloSkillRegistryReviewRequestResponse,
  VesloSkillRegistryRolloutPoliciesResponse,
  VesloSkillRegistryRolloutPolicyResponse,
  VesloSkillRegistrySearchParams,
  VesloSkillRegistrySearchResponse,
  VesloSkillRegistrySkillResponse,
  VesloSkillRegistryUpdateInstallationInput,
  VesloSkillRegistryUpdateRolloutPolicyInput,
  VesloSkillRegistryVersionResponse,
  VesloSkillRegistryVersionsResponse,
  VesloSkillRegistryWorkspaceSkillSetResponse,
  VesloSkillRemovalMutationResult,
  VesloSkillRemovalScope,
  VesloSkillRemovalsResponse,
  VesloSkillResolveResult,
  VesloUserGlobalSkillStoreContent,
  VesloUserGlobalSkillStoreItem,
  VesloUserGlobalSkillStoreMutationResult,
  VesloUserGlobalSkillStoreSyncResult,
} from "../veslo-server/types";
import { buildDenContextHeaders } from "../veslo-server/header-profiles";
import { workspacePath } from "./path";

type RequestJsonOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
};

export type SkillsClientContext = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  requestJson: <T>(baseUrl: string, path: string, options?: RequestJsonOptions) => Promise<T>;
  validateSearchResponse: (value: unknown) => VesloSkillRegistrySearchResponse;
  timeouts: {
    skillRegistrySearch: number;
    skillRegistryMutation: number;
    skillMaterialization: number;
  };
};

function setTrimmedSearchParam(search: URLSearchParams, key: string, value?: string | null) {
  const normalized = value?.trim() ?? "";
  if (normalized) search.set(key, normalized);
}

function skillMaterializationSyncBody(
  options?: VesloSkillMaterializationRequestOptions,
): VesloSkillMaterializationSyncOptions | undefined {
  return options?.activeRun === true ? { activeRun: true } : undefined;
}

function buildSkillRegistrySearchPath(params: VesloSkillRegistrySearchParams) {
  const search = new URLSearchParams();
  setTrimmedSearchParam(search, "q", params.q);
  setTrimmedSearchParam(search, "workspaceId", params.workspaceId);
  const ownerScope = params.ownerScope ?? params.owner ?? params.scope;
  if (ownerScope) search.set("ownerScope", ownerScope);
  const reviewStatus = params.reviewStatus ?? params.approvalStatus;
  if (reviewStatus) search.set("reviewStatus", reviewStatus);
  if (typeof params.includeDeleted === "boolean") {
    search.set("includeDeleted", params.includeDeleted ? "true" : "false");
  }
  setTrimmedSearchParam(search, "language", params.language);
  setTrimmedSearchParam(search, "cursor", params.cursor);
  if (typeof params.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0) {
    search.set("limit", String(params.limit));
  }
  const suffix = search.toString();
  return `/v1/skills/search${suffix ? `?${suffix}` : ""}`;
}

function buildSkillRegistryVersionsPath(skillId: string, params?: VesloSkillRegistryListVersionsInput) {
  const search = new URLSearchParams();
  setTrimmedSearchParam(search, "cursor", params?.cursor);
  if (typeof params?.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0) {
    search.set("limit", String(params.limit));
  }
  const suffix = search.toString();
  return `/v1/skills/${encodeURIComponent(skillId)}/versions${suffix ? `?${suffix}` : ""}`;
}

function buildSkillRegistryRolloutPoliciesPath(params?: VesloSkillRegistryListRolloutPoliciesInput) {
  const search = new URLSearchParams();
  setTrimmedSearchParam(search, "cursor", params?.cursor);
  if (typeof params?.limit === "number" && Number.isSafeInteger(params.limit) && params.limit > 0) {
    search.set("limit", String(params.limit));
  }
  if (params?.target) search.set("target", params.target);
  if (params?.audience) search.set("audience", params.audience);
  setTrimmedSearchParam(search, "workspaceId", params?.workspaceId);
  const suffix = search.toString();
  return `/v1/skill-rollout-policies${suffix ? `?${suffix}` : ""}`;
}

function buildSkillRemovalsPath(params?: {
  scope?: VesloSkillRemovalScope;
  workspaceId?: string;
  includeRestored?: boolean;
}) {
  const search = new URLSearchParams();
  if (params?.scope) search.set("scope", params.scope);
  setTrimmedSearchParam(search, "workspaceId", params?.workspaceId);
  if (typeof params?.includeRestored === "boolean") {
    search.set("includeRestored", params.includeRestored ? "true" : "false");
  }
  const suffix = search.toString();
  return `/skill-removals${suffix ? `?${suffix}` : ""}`;
}

function buildDeleteGlobalSkillPath(name: string, options?: { path?: string; reason?: string }) {
  const search = new URLSearchParams();
  setTrimmedSearchParam(search, "path", options?.path);
  setTrimmedSearchParam(search, "reason", options?.reason);
  const suffix = search.toString();
  return `/skills/user-global/${encodeURIComponent(name)}${suffix ? `?${suffix}` : ""}`;
}

export function createSkillsClient(context: SkillsClientContext) {
  const { baseUrl, token, hostToken, requestJson, timeouts } = context;

  return {
    list: (workspaceId: string, options?: { includeGlobal?: boolean; includeDisabled?: boolean }) => {
      const queryParams = new URLSearchParams();
      if (options?.includeGlobal) queryParams.set("includeGlobal", "true");
      if (options?.includeDisabled) queryParams.set("includeDisabled", "true");
      const query = queryParams.toString();
      return requestJson<{ items: VesloSkillItem[] }>(
        baseUrl,
        `${workspacePath(workspaceId)}/skills${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },

    listDisabled: (options?: { workspaceId?: string }) => {
      const queryParams = new URLSearchParams();
      if (options?.workspaceId?.trim()) queryParams.set("workspaceId", options.workspaceId.trim());
      const query = queryParams.toString();
      return requestJson<VesloDisabledSkillsResponse>(
        baseUrl,
        `/skills/disabled${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },

    setEnabledState: (payload: { target: VesloSkillEnabledTarget; enabled: boolean }) =>
      requestJson<VesloSkillEnabledStateResponse>(baseUrl, "/skills/enabled-state", {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),

    resolve: (
      workspaceId: string,
      payload: {
        text: string;
        includeGlobal?: boolean;
        threshold?: number;
        ambiguityDelta?: number;
        maxCandidates?: number;
      },
    ) =>
      requestJson<VesloSkillResolveResult>(baseUrl, `${workspacePath(workspaceId)}/skills/resolve`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),

    searchRegistry: async (params: VesloSkillRegistrySearchParams) => {
      const payload = await requestJson<unknown>(baseUrl, buildSkillRegistrySearchPath(params), {
        token,
        hostToken,
        timeoutMs: timeouts.skillRegistrySearch,
      });
      return context.validateSearchResponse(payload);
    },

    createRegistrySkill: (input: VesloSkillRegistryCreateSkillInput) =>
      requestJson<VesloSkillRegistrySkillResponse>(baseUrl, "/v1/skills", {
        token,
        hostToken,
        method: "POST",
        body: {
          scope: input.scope,
          name: input.name,
          displayName: input.displayName,
          description: input.description,
          orgId: input.orgId,
          workspaceId: input.workspaceId,
        },
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.skillRegistryMutation,
      }),

    createRegistrySkillVersion: (skillId: string, input: VesloSkillRegistryCreateVersionInput) =>
      requestJson<VesloSkillRegistryVersionResponse>(
        baseUrl,
        `/v1/skills/${encodeURIComponent(skillId)}/versions`,
        {
          token,
          hostToken,
          method: "POST",
          body: { package: input.package },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),

    createRegistrySkillInstallation: (input: VesloSkillRegistryCreateInstallationInput) =>
      requestJson<VesloSkillRegistryInstallationResponse>(baseUrl, "/v1/skill-installations", {
        token,
        hostToken,
        method: "POST",
        body: {
          scope: input.scope,
          skillId: input.skillId,
          versionId: input.versionId,
          orgId: input.orgId,
          ownerUserId: input.ownerUserId,
          workspaceId: input.workspaceId,
          updatePolicy: input.updatePolicy,
          releaseChannel: input.releaseChannel,
        },
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.skillRegistryMutation,
      }),

    listRegistrySkillVersions: (skillId: string, input?: VesloSkillRegistryListVersionsInput) =>
      requestJson<VesloSkillRegistryVersionsResponse>(baseUrl, buildSkillRegistryVersionsPath(skillId, input), {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.skillRegistrySearch,
      }),

    updateRegistrySkillInstallation: (installationId: string, input: VesloSkillRegistryUpdateInstallationInput) =>
      requestJson<VesloSkillRegistryInstallationResponse>(
        baseUrl,
        `/v1/skill-installations/${encodeURIComponent(installationId)}`,
        {
          token,
          hostToken,
          method: "PATCH",
          body: {
            enabled: input.enabled,
            versionId: input.versionId,
            updatePolicy: input.updatePolicy,
            releaseChannel: input.releaseChannel,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),

    deleteRegistrySkillInstallation: (installationId: string, input?: VesloSkillRegistryAuthContext) =>
      requestJson<VesloSkillRegistryInstallationResponse>(
        baseUrl,
        `/v1/skill-installations/${encodeURIComponent(installationId)}`,
        {
          token,
          hostToken,
          method: "DELETE",
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),

    restoreRegistrySkillInstallation: (
      installationId: string,
      input: VesloSkillRegistryRestoreInstallationInput,
    ) =>
      requestJson<VesloSkillRegistryInstallationResponse>(
        baseUrl,
        `/v1/skill-installations/${encodeURIComponent(installationId)}/restore`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            orgId: input.orgId,
            ownerUserId: input.ownerUserId,
            workspaceId: input.workspaceId,
            versionId: input.versionId,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),

    createRegistrySkillReviewRequest: (skillId: string, input: VesloSkillRegistryCreateReviewRequestInput) =>
      requestJson<VesloSkillRegistryReviewRequestResponse>(
        baseUrl,
        `/v1/skills/${encodeURIComponent(skillId)}/review-requests`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            scope: input.scope,
            versionId: input.versionId,
            orgId: input.orgId,
            reason: input.reason,
            releaseChannel: input.releaseChannel,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),

    replaceRegistryWorkspaceSkillSet: (workspaceId: string, input: VesloSkillRegistryReplaceWorkspaceSkillSetInput) =>
      requestJson<VesloSkillRegistryWorkspaceSkillSetResponse>(
        baseUrl,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/skill-set`,
        {
          token,
          hostToken,
          method: "PATCH",
          body: {
            orgId: input.orgId,
            releaseChannel: input.releaseChannel,
            skills: input.skills,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),

    approveRegistrySkillReviewRequest: (requestId: string, input: VesloSkillRegistryReviewDecisionInput) =>
      requestJson<VesloSkillRegistryReviewRequestResponse>(
        baseUrl,
        `/v1/skill-review-requests/${encodeURIComponent(requestId)}/approve`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            reviewerNote: input.reviewerNote,
            releaseChannel: input.releaseChannel,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),

    rejectRegistrySkillReviewRequest: (requestId: string, input: VesloSkillRegistryReviewDecisionInput) =>
      requestJson<VesloSkillRegistryReviewRequestResponse>(
        baseUrl,
        `/v1/skill-review-requests/${encodeURIComponent(requestId)}/reject`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            reviewerNote: input.reviewerNote,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),

    listRegistrySkillRolloutPolicies: (input?: VesloSkillRegistryListRolloutPoliciesInput) =>
      requestJson<VesloSkillRegistryRolloutPoliciesResponse>(
        baseUrl,
        buildSkillRegistryRolloutPoliciesPath(input),
        {
          token,
          hostToken,
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistrySearch,
        },
      ),

    createRegistrySkillRolloutPolicy: (input: VesloSkillRegistryCreateRolloutPolicyInput) =>
      requestJson<VesloSkillRegistryRolloutPolicyResponse>(baseUrl, "/v1/skill-rollout-policies", {
        token,
        hostToken,
        method: "POST",
        body: {
          skillId: input.skillId,
          versionId: input.versionId,
          target: input.target,
          audience: input.audience,
          catalogScope: input.catalogScope,
          orgId: input.orgId,
          userId: input.userId,
          workspaceId: input.workspaceId,
          enabled: input.enabled,
          updatePolicy: input.updatePolicy,
          releaseChannel: input.releaseChannel,
          removalPolicy: input.removalPolicy,
        },
        extraHeaders: buildDenContextHeaders(input),
        timeoutMs: timeouts.skillRegistryMutation,
      }),

    updateRegistrySkillRolloutPolicy: (policyId: string, input: VesloSkillRegistryUpdateRolloutPolicyInput) =>
      requestJson<VesloSkillRegistryRolloutPolicyResponse>(
        baseUrl,
        `/v1/skill-rollout-policies/${encodeURIComponent(policyId)}`,
        {
          token,
          hostToken,
          method: "PATCH",
          body: {
            skillId: input.skillId,
            versionId: input.versionId,
            target: input.target,
            audience: input.audience,
            catalogScope: input.catalogScope,
            orgId: input.orgId,
            userId: input.userId,
            workspaceId: input.workspaceId,
            enabled: input.enabled,
            updatePolicy: input.updatePolicy,
            releaseChannel: input.releaseChannel,
            removalPolicy: input.removalPolicy,
          },
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),

    deleteRegistrySkillRolloutPolicy: (policyId: string, input?: VesloSkillRegistryAuthContext) =>
      requestJson<VesloSkillRegistryRolloutPolicyResponse>(
        baseUrl,
        `/v1/skill-rollout-policies/${encodeURIComponent(policyId)}`,
        {
          token,
          hostToken,
          method: "DELETE",
          extraHeaders: buildDenContextHeaders(input),
          timeoutMs: timeouts.skillRegistryMutation,
        },
      ),

    getGlobalMaterializationStatus: () =>
      requestJson<VesloGlobalSkillMaterializationStatus>(baseUrl, "/skills/materialization", {
        token,
        hostToken,
        timeoutMs: timeouts.skillMaterialization,
      }),

    syncGlobalMaterialization: (options?: VesloSkillMaterializationRequestOptions) =>
      requestJson<VesloGlobalSkillMaterializationSyncResult>(
        baseUrl,
        "/skills/materialization/sync-global",
        {
          method: "POST",
          token,
          hostToken,
          body: skillMaterializationSyncBody(options),
          extraHeaders: buildDenContextHeaders(options),
          timeoutMs: timeouts.skillMaterialization,
        },
      ),

    getWorkspaceMaterializationStatus: (workspaceId: string, options?: VesloSkillRegistryAuthContext) =>
      requestJson<VesloSkillMaterializationStatus>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skills/materialization`,
        {
          token,
          hostToken,
          extraHeaders: buildDenContextHeaders(options),
          timeoutMs: timeouts.skillMaterialization,
        },
      ),

    syncWorkspaceMaterialization: (workspaceId: string, options?: VesloSkillMaterializationRequestOptions) =>
      requestJson<VesloSkillMaterializationSyncResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skills/materialization/sync`,
        {
          method: "POST",
          token,
          hostToken,
          body: skillMaterializationSyncBody(options),
          extraHeaders: buildDenContextHeaders(options),
          timeoutMs: timeouts.skillMaterialization,
        },
      ),

    listUserGlobalStore: () =>
      requestJson<{ items: VesloUserGlobalSkillStoreItem[] }>(baseUrl, "/skills/user-global-store", {
        token,
        hostToken,
      }),

    getUserGlobalStoreSkill: (name: string) =>
      requestJson<VesloUserGlobalSkillStoreContent>(
        baseUrl,
        `/skills/user-global-store/${encodeURIComponent(name)}`,
        { token, hostToken },
      ),

    getUserGlobalStoreSkillFiles: (name: string) =>
      requestJson<VesloSkillFilesContent>(
        baseUrl,
        `/skills/user-global-store/${encodeURIComponent(name)}/files`,
        { token, hostToken },
      ),

    upsertUserGlobalStoreSkill: (payload: {
      name: string;
      content: string;
      description?: string;
      enabled?: boolean;
    }) =>
      requestJson<VesloUserGlobalSkillStoreMutationResult>(baseUrl, "/skills/user-global-store", {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),

    deleteUserGlobalStoreSkill: (name: string) =>
      requestJson<VesloUserGlobalSkillStoreMutationResult>(
        baseUrl,
        `/skills/user-global-store/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),

    syncUserGlobalStore: (workspaceId: string) =>
      requestJson<VesloUserGlobalSkillStoreSyncResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/skills/user-global-store/sync`,
        {
          token,
          hostToken,
          method: "POST",
          timeoutMs: timeouts.skillMaterialization,
        },
      ),

    listHub: (options?: { denToken?: string; denOrgId?: string }) =>
      requestJson<{ items: VesloHubSkillItem[] }>(baseUrl, "/hub/skills", {
        token,
        hostToken,
        extraHeaders: buildDenContextHeaders(options),
      }),

    installHub: (
      workspaceId: string,
      name: string,
      options?: { overwrite?: boolean; repo?: { owner?: string; repo?: string; ref?: string } },
    ) =>
      requestJson<{ ok: boolean; name: string; path: string; action: "added" | "updated"; written: number; skipped: number }>(
        baseUrl,
        `${workspacePath(workspaceId)}/skills/hub/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(options?.overwrite ? { overwrite: true } : {}),
            ...(options?.repo ? { repo: options.repo } : {}),
          },
        },
      ),

    get: (workspaceId: string, name: string, options?: { includeGlobal?: boolean; path?: string }) => {
      const queryParams = new URLSearchParams();
      if (options?.includeGlobal) queryParams.set("includeGlobal", "true");
      if (options?.path?.trim()) queryParams.set("path", options.path.trim());
      const query = queryParams.toString();
      return requestJson<VesloSkillContent>(
        baseUrl,
        `${workspacePath(workspaceId)}/skills/${encodeURIComponent(name)}${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },

    getFiles: (workspaceId: string, name: string, options?: { includeGlobal?: boolean; includeDisabled?: boolean; path?: string }) => {
      const queryParams = new URLSearchParams();
      if (options?.includeGlobal) queryParams.set("includeGlobal", "true");
      if (options?.includeDisabled) queryParams.set("includeDisabled", "true");
      if (options?.path?.trim()) queryParams.set("path", options.path.trim());
      const query = queryParams.toString();
      return requestJson<VesloSkillFilesContent>(
        baseUrl,
        `${workspacePath(workspaceId)}/skills/${encodeURIComponent(name)}/files${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },

    getGlobalFiles: (name: string, options: { path: string; includeDisabled?: boolean }) => {
      const queryParams = new URLSearchParams();
      queryParams.set("path", options.path.trim());
      if (options.includeDisabled) queryParams.set("includeDisabled", "true");
      return requestJson<VesloSkillFilesContent>(
        baseUrl,
        `/skills/user-global/${encodeURIComponent(name)}/files?${queryParams.toString()}`,
        { token, hostToken },
      );
    },

    upsert: (workspaceId: string, payload: { name: string; path?: string; content: string; description?: string }) =>
      requestJson<VesloSkillItem>(baseUrl, `${workspacePath(workspaceId)}/skills`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),

    delete: (workspaceId: string, name: string, options?: { path?: string }) => {
      const queryParams = new URLSearchParams();
      if (options?.path?.trim()) queryParams.set("path", options.path.trim());
      const query = queryParams.toString();
      return requestJson<{ ok: true; name: string; path: string }>(
        baseUrl,
        `${workspacePath(workspaceId)}/skills/${encodeURIComponent(name)}${query ? `?${query}` : ""}`,
        { token, hostToken, method: "DELETE" },
      );
    },

    deleteGlobal: (name: string, options?: { path?: string; reason?: string }) =>
      requestJson<VesloSkillRemovalMutationResult>(baseUrl, buildDeleteGlobalSkillPath(name, options), {
        token,
        hostToken,
        method: "DELETE",
      }),

    batchRemove: (input: VesloSkillBatchRemoveRequest) => {
      const { denApiBase, denToken, denOrgId, denUserId, ...body } = input;
      return requestJson<VesloSkillBatchRemoveResponse>(baseUrl, "/skills/batch-remove", {
        token,
        hostToken,
        method: "POST",
        body,
        extraHeaders: buildDenContextHeaders({ denApiBase, denToken, denOrgId, denUserId }),
        timeoutMs: timeouts.skillRegistryMutation,
      });
    },

    listRemovals: (params?: {
      scope?: VesloSkillRemovalScope;
      workspaceId?: string;
      includeRestored?: boolean;
    }) =>
      requestJson<VesloSkillRemovalsResponse>(baseUrl, buildSkillRemovalsPath(params), {
        token,
        hostToken,
      }),

    listImportCandidates: () =>
      requestJson<VesloSkillImportCandidatesResponse>(baseUrl, "/skills/import-candidates", {
        token,
        hostToken,
      }),

    importCandidates: (candidateIds: string[]) =>
      requestJson<VesloSkillImportResult>(baseUrl, "/skills/import-candidates/import", {
        token,
        hostToken,
        method: "POST",
        body: { candidateIds },
      }),

    restoreRemoval: (removalId: string) =>
      requestJson<VesloSkillRemovalMutationResult>(
        baseUrl,
        `/skill-removals/${encodeURIComponent(removalId)}/restore`,
        { token, hostToken, method: "POST" },
      ),
  };
}

export type SkillsClient = ReturnType<typeof createSkillsClient>;
