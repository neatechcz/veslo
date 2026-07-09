import { ApiError } from "../errors.js";
import { addRoute, type RequestContext, type Route } from "../routing.js";
import {
  readSkillRegistryRequestInput as skillRegistryRequestInput,
  requireSkillRegistryRequestBaseUrl,
  skillRegistryRequestBaseUrl,
} from "../request-headers.js";
import {
  approveRegistrySkillReviewRequest,
  createRegistrySkill,
  createRegistrySkillInstallation,
  createRegistrySkillReviewRequest,
  createRegistrySkillRolloutPolicy,
  createRegistrySkillVersion,
  deleteRegistrySkillInstallation,
  deleteRegistrySkillRolloutPolicy,
  listRegistrySkillEvents,
  listRegistrySkillRolloutPolicies,
  listRegistrySkillVersions,
  rejectRegistrySkillReviewRequest,
  replaceRegistryWorkspaceSkillSet,
  restoreRegistrySkillInstallation,
  searchRegistrySkills,
  updateRegistrySkillInstallation,
  updateRegistrySkillRolloutPolicy,
} from "../skill-registry-client.js";
import type {
  RegistrySkillPackageArchive,
  RegistrySkillRolloutPolicyAudience,
  RegistrySkillRolloutPolicyCatalogScope,
  RegistrySkillRolloutPolicyRemovalPolicy,
  RegistrySkillRolloutPolicyTarget,
  RegistrySkillRolloutPolicyUpdatePolicy,
} from "../skill-registry-types.js";
import {
  ensureWritable,
  jsonResponse,
  readJsonBody,
} from "../route-helpers.js";

function trimmedSearchParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value ? value : undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.trunc(parsed);
}

function optionalBodyString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBodyNullableString(body: Record<string, unknown>, field: string): string | null | undefined {
  if (body[field] === null) return null;
  return optionalBodyString(body, field);
}

function optionalBodyBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === "boolean" ? value : undefined;
}

function requireBodyString(body: Record<string, unknown>, field: string): string {
  const value = optionalBodyString(body, field);
  if (!value) {
    throw new ApiError(400, "invalid_payload", `${field} is required`);
  }
  return value;
}

function requireBodyObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = body[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_payload", `${field} is required`);
  }
  return value as Record<string, unknown>;
}

export function registerSkillRegistryRoutes(routes: Route[]): void {
  addRoute(routes, "POST", "/v1/skills", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await createRegistrySkill({
      ...skillRegistryRequestInput(ctx),
      scope: requireBodyString(body, "scope"),
      name: requireBodyString(body, "name"),
      displayName: optionalBodyString(body, "displayName"),
      description: optionalBodyString(body, "description"),
      targetOrgId: optionalBodyString(body, "orgId"),
      workspaceId: optionalBodyString(body, "workspaceId"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/v1/skills/:skillId/versions", "client", async (ctx) => {
    requireSkillRegistryRequestBaseUrl(ctx);
    const limit = parseInteger(trimmedSearchParam(ctx.url.searchParams, "limit"));
    const result = await listRegistrySkillVersions({
      ...skillRegistryRequestInput(ctx),
      skillId: ctx.params.skillId ?? "",
      cursor: trimmedSearchParam(ctx.url.searchParams, "cursor"),
      limit: limit ?? undefined,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skills/:skillId/versions", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await createRegistrySkillVersion({
      ...skillRegistryRequestInput(ctx),
      skillId: ctx.params.skillId ?? "",
      package: requireBodyObject(body, "package") as RegistrySkillPackageArchive,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skills/:skillId/review-requests", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await createRegistrySkillReviewRequest({
      ...skillRegistryRequestInput(ctx),
      skillId: ctx.params.skillId ?? "",
      scope: requireBodyString(body, "scope"),
      versionId: requireBodyString(body, "versionId"),
      targetOrgId: optionalBodyString(body, "orgId"),
      reason: optionalBodyString(body, "reason"),
      releaseChannel: optionalBodyString(body, "releaseChannel"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skill-review-requests/:requestId/approve", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await approveRegistrySkillReviewRequest({
      ...skillRegistryRequestInput(ctx),
      requestId: ctx.params.requestId ?? "",
      reviewerNote: optionalBodyString(body, "reviewerNote"),
      releaseChannel: optionalBodyString(body, "releaseChannel"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skill-review-requests/:requestId/reject", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await rejectRegistrySkillReviewRequest({
      ...skillRegistryRequestInput(ctx),
      requestId: ctx.params.requestId ?? "",
      reviewerNote: optionalBodyString(body, "reviewerNote"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skill-installations", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await createRegistrySkillInstallation({
      ...skillRegistryRequestInput(ctx),
      scope: requireBodyString(body, "scope"),
      skillId: requireBodyString(body, "skillId"),
      versionId: requireBodyString(body, "versionId"),
      targetOrgId: optionalBodyString(body, "orgId"),
      ownerUserId: optionalBodyString(body, "ownerUserId"),
      workspaceId: optionalBodyString(body, "workspaceId"),
      updatePolicy: optionalBodyString(body, "updatePolicy"),
      releaseChannel: optionalBodyString(body, "releaseChannel"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "PATCH", "/v1/skill-installations/:installationId", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await updateRegistrySkillInstallation({
      ...skillRegistryRequestInput(ctx),
      installationId: ctx.params.installationId ?? "",
      enabled: optionalBodyBoolean(body, "enabled"),
      versionId: optionalBodyNullableString(body, "versionId"),
      updatePolicy: optionalBodyString(body, "updatePolicy"),
      releaseChannel: optionalBodyNullableString(body, "releaseChannel"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/v1/skill-installations/:installationId", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const result = await deleteRegistrySkillInstallation({
      ...skillRegistryRequestInput(ctx),
      installationId: ctx.params.installationId ?? "",
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skill-installations/:installationId/restore", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await restoreRegistrySkillInstallation({
      ...skillRegistryRequestInput(ctx),
      installationId: ctx.params.installationId ?? "",
      targetOrgId: optionalBodyNullableString(body, "orgId"),
      ownerUserId: optionalBodyNullableString(body, "ownerUserId"),
      workspaceId: optionalBodyNullableString(body, "workspaceId"),
      versionId: optionalBodyNullableString(body, "versionId"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "PATCH", "/v1/workspaces/:workspaceId/skill-set", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const skills = Array.isArray(body.skills) ? body.skills : [];
    const result = await replaceRegistryWorkspaceSkillSet({
      ...skillRegistryRequestInput(ctx),
      workspaceId: ctx.params.workspaceId ?? "",
      targetOrgId: optionalBodyString(body, "orgId"),
      releaseChannel: optionalBodyString(body, "releaseChannel"),
      skills: skills as Array<{ installationId: string; desiredVersionId?: string | null; releaseChannel?: string | null }>,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/v1/skill-rollout-policies", "client", async (ctx) => {
    if (!skillRegistryRequestBaseUrl(ctx)) {
      return jsonResponse({ policies: [], nextCursor: null });
    }

    const limit = parseInteger(trimmedSearchParam(ctx.url.searchParams, "limit"));
    const enabledParam = trimmedSearchParam(ctx.url.searchParams, "enabled");
    const result = await listRegistrySkillRolloutPolicies({
      ...skillRegistryRequestInput(ctx),
      cursor: trimmedSearchParam(ctx.url.searchParams, "cursor"),
      limit: limit ?? undefined,
      skillId: trimmedSearchParam(ctx.url.searchParams, "skillId"),
      target: trimmedSearchParam(ctx.url.searchParams, "target") as RegistrySkillRolloutPolicyTarget | undefined,
      audience: trimmedSearchParam(ctx.url.searchParams, "audience") as
        | RegistrySkillRolloutPolicyAudience
        | undefined,
      catalogScope: trimmedSearchParam(ctx.url.searchParams, "catalogScope") as
        | RegistrySkillRolloutPolicyCatalogScope
        | undefined,
      targetOrgId: trimmedSearchParam(ctx.url.searchParams, "orgId"),
      targetUserId: trimmedSearchParam(ctx.url.searchParams, "userId"),
      workspaceId: trimmedSearchParam(ctx.url.searchParams, "workspaceId"),
      enabled: enabledParam === undefined ? undefined : enabledParam === "true",
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skill-rollout-policies", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await createRegistrySkillRolloutPolicy({
      ...skillRegistryRequestInput(ctx),
      skillId: requireBodyString(body, "skillId"),
      versionId: optionalBodyNullableString(body, "versionId"),
      target: requireBodyString(body, "target") as RegistrySkillRolloutPolicyTarget,
      audience: requireBodyString(body, "audience") as RegistrySkillRolloutPolicyAudience,
      catalogScope: requireBodyString(body, "catalogScope") as RegistrySkillRolloutPolicyCatalogScope,
      targetOrgId: optionalBodyString(body, "orgId"),
      targetUserId: optionalBodyString(body, "userId"),
      workspaceId: optionalBodyString(body, "workspaceId"),
      enabled: optionalBodyBoolean(body, "enabled"),
      updatePolicy: requireBodyString(body, "updatePolicy") as RegistrySkillRolloutPolicyUpdatePolicy,
      releaseChannel: optionalBodyNullableString(body, "releaseChannel"),
      removalPolicy: requireBodyString(body, "removalPolicy") as RegistrySkillRolloutPolicyRemovalPolicy,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "PATCH", "/v1/skill-rollout-policies/:policyId", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await updateRegistrySkillRolloutPolicy({
      ...skillRegistryRequestInput(ctx),
      policyId: ctx.params.policyId ?? "",
      skillId: optionalBodyString(body, "skillId"),
      versionId: optionalBodyNullableString(body, "versionId"),
      target: optionalBodyString(body, "target") as RegistrySkillRolloutPolicyTarget | undefined,
      audience: optionalBodyString(body, "audience") as RegistrySkillRolloutPolicyAudience | undefined,
      catalogScope: optionalBodyString(body, "catalogScope") as RegistrySkillRolloutPolicyCatalogScope | undefined,
      targetOrgId: optionalBodyNullableString(body, "orgId"),
      targetUserId: optionalBodyNullableString(body, "userId"),
      workspaceId: optionalBodyNullableString(body, "workspaceId"),
      enabled: optionalBodyBoolean(body, "enabled"),
      updatePolicy: optionalBodyString(body, "updatePolicy") as RegistrySkillRolloutPolicyUpdatePolicy | undefined,
      releaseChannel: optionalBodyNullableString(body, "releaseChannel"),
      removalPolicy: optionalBodyString(body, "removalPolicy") as
        | RegistrySkillRolloutPolicyRemovalPolicy
        | undefined,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/v1/skill-rollout-policies/:policyId", "host", async (ctx) => {
    ensureWritable(ctx.config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const result = await deleteRegistrySkillRolloutPolicy({
      ...skillRegistryRequestInput(ctx),
      policyId: ctx.params.policyId ?? "",
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/v1/skills/search", "client", async (ctx) => {
    const query = trimmedSearchParam(ctx.url.searchParams, "q");
    if (!query) {
      throw new ApiError(400, "invalid_query", "Skill registry search query is required");
    }

    if (!skillRegistryRequestBaseUrl(ctx)) {
      return jsonResponse({
        query,
        skills: [],
        nextCursor: null,
        registryConfigured: false,
      });
    }

    const limit = parseInteger(trimmedSearchParam(ctx.url.searchParams, "limit"));
    const includeDeletedParam = trimmedSearchParam(ctx.url.searchParams, "includeDeleted");
    const result = await searchRegistrySkills({
      ...skillRegistryRequestInput(ctx),
      query,
      cursor: trimmedSearchParam(ctx.url.searchParams, "cursor"),
      limit: limit ?? undefined,
      workspaceId: trimmedSearchParam(ctx.url.searchParams, "workspaceId"),
      ownerScope: trimmedSearchParam(ctx.url.searchParams, "ownerScope"),
      reviewStatus: trimmedSearchParam(ctx.url.searchParams, "reviewStatus"),
      includeDeleted: includeDeletedParam === undefined ? undefined : includeDeletedParam === "true",
      language: trimmedSearchParam(ctx.url.searchParams, "language"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/v1/skill-registry-events", "client", async (ctx) => {
    if (!skillRegistryRequestBaseUrl(ctx)) {
      return jsonResponse({
        events: [],
        nextCursor: null,
        revision: null,
        registryConfigured: false,
      });
    }

    const limit = parseInteger(trimmedSearchParam(ctx.url.searchParams, "limit"));
    const result = await listRegistrySkillEvents({
      ...skillRegistryRequestInput(ctx),
      cursor: trimmedSearchParam(ctx.url.searchParams, "cursor"),
      limit: limit ?? undefined,
      orgId: trimmedSearchParam(ctx.url.searchParams, "orgId"),
      workspaceId: trimmedSearchParam(ctx.url.searchParams, "workspaceId"),
    });
    return jsonResponse(result);
  });
}
