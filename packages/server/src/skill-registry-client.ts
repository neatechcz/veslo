import { ApiError } from "./errors.js";
import {
  validateRegistrySkillListResponse,
  validateRegistrySkillEventsResponse,
  validateRegistrySkillInstallationResponse,
  validateRegistrySkillInstallationsResponse,
  validateRegistrySkillPackageResponse,
  validateRegistrySkillRolloutPoliciesResponse,
  validateRegistrySkillRolloutPolicyResponse,
  validateRegistrySkillResponse,
  validateRegistrySkillReviewRequestResponse,
  validateRegistrySkillSearchResponse,
  validateRegistrySkillVersionResponse,
  validateRegistrySkillVersionsResponse,
  validateWorkspaceSkillSetResponse,
} from "./skill-registry-types.js";
import type {
  RegistrySkillEventsResponse,
  RegistrySkillInstallationResponse,
  RegistrySkillInstallationSource,
  RegistrySkillInstallationsResponse,
  RegistrySkillListResponse,
  RegistrySkillPackageResponse,
  RegistrySkillPackageArchive,
  RegistrySkillRolloutPoliciesResponse,
  RegistrySkillRolloutPolicyAudience,
  RegistrySkillRolloutPolicyCatalogScope,
  RegistrySkillRolloutPolicyRemovalPolicy,
  RegistrySkillRolloutPolicyResponse,
  RegistrySkillRolloutPolicyTarget,
  RegistrySkillRolloutPolicyUpdatePolicy,
  RegistrySkillResponse,
  RegistrySkillReviewRequestResponse,
  RegistrySkillSearchResponse,
  RegistrySkillVersionResponse,
  RegistrySkillVersionsResponse,
  WorkspaceSkillSetResponse,
} from "./skill-registry-types.js";

type RegistryClientInput = {
  baseUrl: string;
  token?: string;
  denToken?: string;
  orgId?: string;
  userId?: string;
};

type PaginatedInput = RegistryClientInput & {
  cursor?: string;
  limit?: number;
};

type SearchInput = PaginatedInput & {
  query: string;
  workspaceId?: string;
  ownerScope?: string;
  reviewStatus?: string;
  includeDeleted?: boolean;
  language?: string;
};

type DownloadPackageInput = RegistryClientInput & {
  versionId: string;
};

type SkillVersionsInput = PaginatedInput & {
  skillId: string;
};

type WorkspaceSkillSetInput = RegistryClientInput & {
  workspaceId: string;
};

type ListInstallationsInput = PaginatedInput & {
  source?: RegistrySkillInstallationSource;
  target?: "personal-global" | "workspace";
};

type ListRolloutPoliciesInput = PaginatedInput & {
  skillId?: string;
  target?: RegistrySkillRolloutPolicyTarget;
  audience?: RegistrySkillRolloutPolicyAudience;
  catalogScope?: RegistrySkillRolloutPolicyCatalogScope;
  targetOrgId?: string;
  targetUserId?: string;
  workspaceId?: string;
  enabled?: boolean;
};

type EventsInput = PaginatedInput & {
  orgId?: string;
  workspaceId?: string;
};

type CreateSkillInput = RegistryClientInput & {
  scope: string;
  name: string;
  displayName?: string;
  description?: string;
  targetOrgId?: string;
  workspaceId?: string;
};

type CreateVersionInput = RegistryClientInput & {
  skillId: string;
  package: RegistrySkillPackageArchive;
};

type CreateInstallationInput = RegistryClientInput & {
  scope: string;
  skillId: string;
  versionId: string;
  targetOrgId?: string;
  workspaceId?: string;
  ownerUserId?: string;
  updatePolicy?: string;
  releaseChannel?: string;
};

type UpdateInstallationInput = RegistryClientInput & {
  installationId: string;
  enabled?: boolean;
  versionId?: string | null;
  updatePolicy?: string;
  releaseChannel?: string | null;
};

type InstallationIdInput = RegistryClientInput & {
  installationId: string;
};

type RestoreInstallationInput = InstallationIdInput & {
  targetOrgId?: string | null;
  ownerUserId?: string | null;
  workspaceId?: string | null;
  versionId?: string | null;
};

type CreateRolloutPolicyInput = RegistryClientInput & {
  skillId: string;
  versionId?: string | null;
  target: RegistrySkillRolloutPolicyTarget;
  audience: RegistrySkillRolloutPolicyAudience;
  catalogScope: RegistrySkillRolloutPolicyCatalogScope;
  targetOrgId?: string;
  targetUserId?: string;
  workspaceId?: string;
  enabled?: boolean;
  updatePolicy: RegistrySkillRolloutPolicyUpdatePolicy;
  releaseChannel?: string | null;
  removalPolicy: RegistrySkillRolloutPolicyRemovalPolicy;
};

type UpdateRolloutPolicyInput = RegistryClientInput & {
  policyId: string;
  skillId?: string;
  versionId?: string | null;
  target?: RegistrySkillRolloutPolicyTarget;
  audience?: RegistrySkillRolloutPolicyAudience;
  catalogScope?: RegistrySkillRolloutPolicyCatalogScope;
  targetOrgId?: string | null;
  targetUserId?: string | null;
  workspaceId?: string | null;
  enabled?: boolean;
  updatePolicy?: RegistrySkillRolloutPolicyUpdatePolicy;
  releaseChannel?: string | null;
  removalPolicy?: RegistrySkillRolloutPolicyRemovalPolicy;
};

type RolloutPolicyIdInput = RegistryClientInput & {
  policyId: string;
};

type CreateReviewRequestInput = RegistryClientInput & {
  skillId: string;
  versionId: string;
  scope: string;
  targetOrgId?: string;
  reason?: string;
  releaseChannel?: string;
};

type ReplaceWorkspaceSkillSetInput = RegistryClientInput & {
  workspaceId: string;
  targetOrgId?: string;
  releaseChannel?: string;
  skills: Array<{
    installationId: string;
    desiredVersionId?: string | null;
    releaseChannel?: string | null;
  }>;
};

type ReviewDecisionInput = RegistryClientInput & {
  requestId: string;
  reviewerNote?: string;
  releaseChannel?: string;
};

function parseBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new ApiError(500, "skill_registry_misconfigured", "Skill registry base URL is missing");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError(500, "skill_registry_misconfigured", "Skill registry base URL is invalid", { url: trimmed });
  }

  if (parsed.search || parsed.hash) {
    throw new ApiError(500, "skill_registry_misconfigured", "Skill registry base URL must not include query or hash", {
      url: `${parsed.origin}${parsed.pathname}`,
    });
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(500, "skill_registry_misconfigured", "Skill registry base URL must not include credentials", {
      url: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
    });
  }

  return parsed;
}

function buildHeaders(input: RegistryClientInput): Headers {
  const headers = new Headers({ Accept: "application/json" });
  const token = input.token?.trim() || input.denToken?.trim();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const orgId = input.orgId?.trim();
  if (orgId) headers.set("x-veslo-den-org-id", orgId);

  const userId = input.userId?.trim();
  if (userId) headers.set("x-veslo-den-user-id", userId);

  return headers;
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string | number | undefined> = {}): string {
  const base = parseBaseUrl(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  base.pathname = `${prefix}/${suffix}`;
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) base.searchParams.set(key, String(value));
  }
  return base.toString();
}

async function parseRegistryJson(response: Response, url: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiError(502, "skill_registry_invalid_payload", "Skill registry returned invalid JSON", {
      url,
      status: response.status,
    });
  }
}

async function buildStatusDetails(response: Response, url: string): Promise<{ url: string; status: number }> {
  await response.body?.cancel().catch(() => undefined);
  return { url, status: response.status };
}

async function throwRegistryStatusError(response: Response, url: string): Promise<never> {
  const details = await buildStatusDetails(response, url);
  if (response.status === 401) {
    throw new ApiError(401, "skill_registry_unauthorized", "Skill registry authorization failed", details);
  }
  if (response.status === 403) {
    throw new ApiError(403, "skill_registry_forbidden", "Skill registry access is forbidden", details);
  }
  if (response.status === 404) {
    throw new ApiError(404, "skill_registry_not_found", "Skill registry resource was not found", details);
  }
  throw new ApiError(
    502,
    "skill_registry_fetch_failed",
    `Skill registry request failed (${response.status})`,
    details,
  );
}

async function fetchRegistryJson(
  input: RegistryClientInput,
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  let response: Response;
  const headers = buildHeaders(input);
  const hasBody = options.body !== undefined;
  if (hasBody) headers.set("content-type", "application/json");
  try {
    response = await fetch(url, {
      ...(options.method ? { method: options.method } : {}),
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (error) {
    throw new ApiError(
      502,
      "skill_registry_fetch_failed",
      "Failed to fetch skill registry",
      { url },
    );
  }

  if (!response.ok) {
    await throwRegistryStatusError(response, url);
  }

  return parseRegistryJson(response, url);
}

function validatePayload<T>(validator: (value: unknown) => T, payload: unknown, url: string): T {
  try {
    return validator(payload);
  } catch (error) {
    throw new ApiError(
      502,
      "skill_registry_invalid_payload",
      "Skill registry returned an invalid payload",
      { url },
    );
  }
}

export async function listRegistrySkills(input: PaginatedInput): Promise<RegistrySkillListResponse> {
  const url = buildUrl(input.baseUrl, "/v1/skills", {
    cursor: input.cursor,
    limit: input.limit,
  });
  const payload = await fetchRegistryJson(input, url);
  return validatePayload(validateRegistrySkillListResponse, payload, url);
}

export async function listRegistrySkillVersions(input: SkillVersionsInput): Promise<RegistrySkillVersionsResponse> {
  const url = buildUrl(input.baseUrl, `/v1/skills/${encodeURIComponent(input.skillId)}/versions`, {
    cursor: input.cursor,
    limit: input.limit,
  });
  const payload = await fetchRegistryJson(input, url);
  return validatePayload(validateRegistrySkillVersionsResponse, payload, url);
}

export async function searchRegistrySkills(input: SearchInput): Promise<RegistrySkillSearchResponse> {
  const url = buildUrl(input.baseUrl, "/v1/skills/search", {
    q: input.query,
    cursor: input.cursor,
    limit: input.limit,
    workspaceId: input.workspaceId,
    ownerScope: input.ownerScope,
    reviewStatus: input.reviewStatus,
    includeDeleted: input.includeDeleted === undefined ? undefined : input.includeDeleted ? "true" : "false",
    language: input.language,
  });
  const payload = await fetchRegistryJson(input, url);
  return validatePayload(validateRegistrySkillSearchResponse, payload, url);
}

export async function downloadSkillPackageFromRegistry(
  input: DownloadPackageInput,
): Promise<RegistrySkillPackageResponse> {
  const url = buildUrl(input.baseUrl, `/v1/skill-versions/${encodeURIComponent(input.versionId)}/package`);
  const payload = await fetchRegistryJson(input, url);
  return validatePayload(validateRegistrySkillPackageResponse, payload, url);
}

export async function getWorkspaceSkillSetFromRegistry(
  input: WorkspaceSkillSetInput,
): Promise<WorkspaceSkillSetResponse> {
  const url = buildUrl(input.baseUrl, `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/skill-set`);
  const payload = await fetchRegistryJson(input, url);
  return validatePayload(validateWorkspaceSkillSetResponse, payload, url);
}

export async function replaceRegistryWorkspaceSkillSet(
  input: ReplaceWorkspaceSkillSetInput,
): Promise<WorkspaceSkillSetResponse> {
  const url = buildUrl(input.baseUrl, `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/skill-set`);
  const payload = await fetchRegistryJson(input, url, {
    method: "PATCH",
    body: {
      orgId: input.targetOrgId,
      releaseChannel: input.releaseChannel,
      skills: input.skills,
    },
  });
  return validatePayload(validateWorkspaceSkillSetResponse, payload, url);
}

export async function listRegistrySkillInstallations(
  input: ListInstallationsInput,
): Promise<RegistrySkillInstallationsResponse> {
  const url = buildUrl(input.baseUrl, "/v1/skill-installations", {
    cursor: input.cursor,
    limit: input.limit,
    source: input.source,
    target: input.target,
  });
  const payload = await fetchRegistryJson(input, url);
  return validatePayload(validateRegistrySkillInstallationsResponse, payload, url);
}

export async function listRegistrySkillEvents(input: EventsInput): Promise<RegistrySkillEventsResponse> {
  const url = buildUrl(input.baseUrl, "/v1/skill-registry-events", {
    cursor: input.cursor,
    limit: input.limit,
    orgId: input.orgId,
    workspaceId: input.workspaceId,
  });
  const payload = await fetchRegistryJson(input, url);
  return validatePayload(validateRegistrySkillEventsResponse, payload, url);
}

export async function listRegistrySkillRolloutPolicies(
  input: ListRolloutPoliciesInput,
): Promise<RegistrySkillRolloutPoliciesResponse> {
  const url = buildUrl(input.baseUrl, "/v1/skill-rollout-policies", {
    cursor: input.cursor,
    limit: input.limit,
    orgId: input.targetOrgId,
    userId: input.targetUserId,
    workspaceId: input.workspaceId,
    skillId: input.skillId,
    target: input.target,
    audience: input.audience,
    catalogScope: input.catalogScope,
    enabled: input.enabled === undefined ? undefined : input.enabled ? "true" : "false",
  });
  const payload = await fetchRegistryJson(input, url);
  return validatePayload(validateRegistrySkillRolloutPoliciesResponse, payload, url);
}

export async function createRegistrySkill(input: CreateSkillInput): Promise<RegistrySkillResponse> {
  const url = buildUrl(input.baseUrl, "/v1/skills");
  const payload = await fetchRegistryJson(input, url, {
    method: "POST",
    body: {
      scope: input.scope,
      name: input.name,
      displayName: input.displayName,
      description: input.description,
      orgId: input.targetOrgId,
      workspaceId: input.workspaceId,
    },
  });
  return validatePayload(validateRegistrySkillResponse, payload, url);
}

export async function createRegistrySkillVersion(input: CreateVersionInput): Promise<RegistrySkillVersionResponse> {
  const url = buildUrl(input.baseUrl, `/v1/skills/${encodeURIComponent(input.skillId)}/versions`);
  const payload = await fetchRegistryJson(input, url, {
    method: "POST",
    body: { package: input.package },
  });
  return validatePayload(validateRegistrySkillVersionResponse, payload, url);
}

export async function createRegistrySkillInstallation(
  input: CreateInstallationInput,
): Promise<RegistrySkillInstallationResponse> {
  const url = buildUrl(input.baseUrl, "/v1/skill-installations");
  const payload = await fetchRegistryJson(input, url, {
    method: "POST",
    body: {
      scope: input.scope,
      skillId: input.skillId,
      versionId: input.versionId,
      orgId: input.targetOrgId,
      ownerUserId: input.ownerUserId,
      workspaceId: input.workspaceId,
      updatePolicy: input.updatePolicy,
      releaseChannel: input.releaseChannel,
    },
  });
  return validatePayload(validateRegistrySkillInstallationResponse, payload, url);
}

export async function createRegistrySkillRolloutPolicy(
  input: CreateRolloutPolicyInput,
): Promise<RegistrySkillRolloutPolicyResponse> {
  const url = buildUrl(input.baseUrl, "/v1/skill-rollout-policies");
  const payload = await fetchRegistryJson(input, url, {
    method: "POST",
    body: {
      skillId: input.skillId,
      versionId: input.versionId,
      target: input.target,
      audience: input.audience,
      catalogScope: input.catalogScope,
      orgId: input.targetOrgId,
      userId: input.targetUserId,
      workspaceId: input.workspaceId,
      enabled: input.enabled,
      updatePolicy: input.updatePolicy,
      releaseChannel: input.releaseChannel,
      removalPolicy: input.removalPolicy,
    },
  });
  return validatePayload(validateRegistrySkillRolloutPolicyResponse, payload, url);
}

export async function updateRegistrySkillRolloutPolicy(
  input: UpdateRolloutPolicyInput,
): Promise<RegistrySkillRolloutPolicyResponse> {
  const url = buildUrl(input.baseUrl, `/v1/skill-rollout-policies/${encodeURIComponent(input.policyId)}`);
  const payload = await fetchRegistryJson(input, url, {
    method: "PATCH",
    body: {
      skillId: input.skillId,
      versionId: input.versionId,
      target: input.target,
      audience: input.audience,
      catalogScope: input.catalogScope,
      orgId: input.targetOrgId,
      userId: input.targetUserId,
      workspaceId: input.workspaceId,
      enabled: input.enabled,
      updatePolicy: input.updatePolicy,
      releaseChannel: input.releaseChannel,
      removalPolicy: input.removalPolicy,
    },
  });
  return validatePayload(validateRegistrySkillRolloutPolicyResponse, payload, url);
}

export async function deleteRegistrySkillRolloutPolicy(
  input: RolloutPolicyIdInput,
): Promise<RegistrySkillRolloutPolicyResponse> {
  const url = buildUrl(input.baseUrl, `/v1/skill-rollout-policies/${encodeURIComponent(input.policyId)}`);
  const payload = await fetchRegistryJson(input, url, { method: "DELETE" });
  return validatePayload(validateRegistrySkillRolloutPolicyResponse, payload, url);
}

export async function updateRegistrySkillInstallation(
  input: UpdateInstallationInput,
): Promise<RegistrySkillInstallationResponse> {
  const url = buildUrl(input.baseUrl, `/v1/skill-installations/${encodeURIComponent(input.installationId)}`);
  const payload = await fetchRegistryJson(input, url, {
    method: "PATCH",
    body: {
      enabled: input.enabled,
      versionId: input.versionId,
      updatePolicy: input.updatePolicy,
      releaseChannel: input.releaseChannel,
    },
  });
  return validatePayload(validateRegistrySkillInstallationResponse, payload, url);
}

export async function deleteRegistrySkillInstallation(
  input: InstallationIdInput,
): Promise<RegistrySkillInstallationResponse> {
  const url = buildUrl(input.baseUrl, `/v1/skill-installations/${encodeURIComponent(input.installationId)}`);
  const payload = await fetchRegistryJson(input, url, { method: "DELETE" });
  return validatePayload(validateRegistrySkillInstallationResponse, payload, url);
}

export async function restoreRegistrySkillInstallation(
  input: RestoreInstallationInput,
): Promise<RegistrySkillInstallationResponse> {
  const url = buildUrl(
    input.baseUrl,
    `/v1/skill-installations/${encodeURIComponent(input.installationId)}/restore`,
  );
  const payload = await fetchRegistryJson(input, url, {
    method: "POST",
    body: {
      orgId: input.targetOrgId,
      ownerUserId: input.ownerUserId,
      workspaceId: input.workspaceId,
      versionId: input.versionId,
    },
  });
  return validatePayload(validateRegistrySkillInstallationResponse, payload, url);
}

export async function createRegistrySkillReviewRequest(
  input: CreateReviewRequestInput,
): Promise<RegistrySkillReviewRequestResponse> {
  const url = buildUrl(input.baseUrl, `/v1/skills/${encodeURIComponent(input.skillId)}/review-requests`);
  const payload = await fetchRegistryJson(input, url, {
    method: "POST",
    body: {
      scope: input.scope,
      versionId: input.versionId,
      orgId: input.targetOrgId,
      reason: input.reason,
      releaseChannel: input.releaseChannel,
    },
  });
  return validatePayload(validateRegistrySkillReviewRequestResponse, payload, url);
}

export async function approveRegistrySkillReviewRequest(
  input: ReviewDecisionInput,
): Promise<RegistrySkillReviewRequestResponse> {
  const url = buildUrl(input.baseUrl, `/v1/skill-review-requests/${encodeURIComponent(input.requestId)}/approve`);
  const payload = await fetchRegistryJson(input, url, {
    method: "POST",
    body: {
      reviewerNote: input.reviewerNote,
      releaseChannel: input.releaseChannel,
    },
  });
  return validatePayload(validateRegistrySkillReviewRequestResponse, payload, url);
}

export async function rejectRegistrySkillReviewRequest(
  input: ReviewDecisionInput,
): Promise<RegistrySkillReviewRequestResponse> {
  const url = buildUrl(input.baseUrl, `/v1/skill-review-requests/${encodeURIComponent(input.requestId)}/reject`);
  const payload = await fetchRegistryJson(input, url, {
    method: "POST",
    body: {
      reviewerNote: input.reviewerNote,
    },
  });
  return validatePayload(validateRegistrySkillReviewRequestResponse, payload, url);
}
