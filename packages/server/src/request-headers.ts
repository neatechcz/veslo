import { normalizeDenApiBaseUrl } from "./den-api-base.js";
import { ApiError } from "./errors.js";
import type { RequestContext } from "./routing.js";
import type { ServerConfig } from "./types.js";

export const AUTHORIZATION_HEADER = "authorization";
export const CONTENT_TYPE_HEADER = "content-type";
export const ACCEPT_ENCODING_HEADER = "accept-encoding";
export const CONTENT_LENGTH_HEADER = "content-length";
export const HOST_HEADER = "host";
export const ORIGIN_HEADER = "origin";
export const VESLO_HOST_TOKEN_HEADER = "x-veslo-host-token";
export const VESLO_CLIENT_ID_HEADER = "x-veslo-client-id";
export const VESLO_SEND_TRACE_ID_HEADER = "x-veslo-send-trace-id";
export const VESLO_ACCOUNT_ID_HEADER = "x-veslo-account-id";
export const VESLO_USER_ID_HEADER = "x-veslo-user-id";
export const VESLO_DEN_USER_ID_HEADER = "x-veslo-den-user-id";
export const VESLO_ORG_ID_HEADER = "x-veslo-org-id";
export const VESLO_DEN_ORG_ID_HEADER = "x-veslo-den-org-id";
export const VESLO_DEN_API_BASE_HEADER = "x-veslo-den-api-base";
export const VESLO_DEN_TOKEN_HEADER = "x-veslo-den-token";
export const VESLO_GATEWAY_AUTHORIZATION_HEADER = "x-veslo-gateway-authorization";
export const VESLO_GATEWAY_TOKEN_HEADER = "x-veslo-gateway-token";
export const VESLO_SESSION_ID_HEADER = "x-veslo-session-id";
export const VESLO_WORKSPACE_ID_HEADER = "x-veslo-workspace-id";
export const VESLO_RUNTIME_SKILL_OPERATION_ID_HEADER = "x-veslo-runtime-skill-operation-id";
export const VESLO_SKILL_VIEW_REVISION_HEADER = "x-veslo-skill-view-revision";
export const VESLO_SKILL_AUTHORIZATION_REVISION_HEADER = "x-veslo-skill-authorization-revision";
export const VESLO_SKILL_MANIFEST_PATH_HEADER = "x-veslo-skill-manifest-path";
export const VESLO_MANAGED_SKILL_STORE_ROOT_HEADER = "x-veslo-managed-skill-store-root";
export const VESLO_ENGINE_DIRECTORY_INSTANCE_EPOCH_HEADER = "x-veslo-engine-directory-instance-epoch";
export const VESLO_ENGINE_SKILL_VIEW_REVISION_HEADER = "x-veslo-engine-skill-view-revision";
export const VESLO_ENGINE_AUTHORIZATION_REVISION_HEADER = "x-veslo-engine-authorization-revision";
export const VESLO_ENGINE_CONFIG_DIGEST_HEADER = "x-veslo-engine-config-digest";
export const OPENCODE_DIRECTORY_HEADER = "x-opencode-directory";

export const HOP_BY_HOP_REQUEST_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
] as const;

export const VESLO_ALLOWED_CORS_HEADERS = [
  "Authorization",
  "Content-Type",
  "X-Veslo-Host-Token",
  "X-Veslo-Client-Id",
  "X-Veslo-Send-Trace-Id",
  "x-veslo-account-id",
  "X-Veslo-User-Id",
  "X-Veslo-Den-User-Id",
  "X-Veslo-Org-Id",
  "X-Veslo-Den-Org-Id",
  "X-Veslo-Den-Api-Base",
  "X-Veslo-Den-Token",
  "X-Veslo-Gateway-Authorization",
  "X-Veslo-Gateway-Token",
  "X-Veslo-Session-Id",
  "X-Veslo-Workspace-Id",
  "X-OpenCode-Directory",
  "X-Opencode-Directory",
  "x-opencode-directory",
] as const;

export const VESLO_ALLOWED_CORS_HEADERS_VALUE = VESLO_ALLOWED_CORS_HEADERS.join(", ");

export type DenCatalogContext = {
  denToken: string;
  denOrgId: string;
  denApiBase: string;
};

export type DenContextHeaders = {
  denApiBase?: string;
  denToken?: string;
  denOrgId?: string;
  denUserId?: string;
};

export type SoulDenHeaderContext = {
  baseUrl: string;
  denToken?: string;
  orgId?: string;
  userId?: string;
};

export type SkillRegistryRequestInput = {
  baseUrl: string;
  token?: string;
  denToken?: string;
  orgId?: string;
  userId?: string;
};

export function trimmedHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim() ?? "";
  return value || undefined;
}

export function readBearerToken(request: Request): string | undefined {
  const header = trimmedHeader(request, AUTHORIZATION_HEADER);
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export function readVesloClientId(request: Request): string | undefined {
  return trimmedHeader(request, VESLO_CLIENT_ID_HEADER);
}

export function readVesloHostToken(request: Request): string | undefined {
  return trimmedHeader(request, VESLO_HOST_TOKEN_HEADER);
}

export function readDenUserIdentityHeader(request: Request): string | undefined {
  return (
    trimmedHeader(request, VESLO_DEN_USER_ID_HEADER) ??
    trimmedHeader(request, VESLO_USER_ID_HEADER) ??
    trimmedHeader(request, VESLO_ACCOUNT_ID_HEADER)
  );
}

export function readDenContextHeaders(ctx: RequestContext): DenContextHeaders {
  return {
    ...(trimmedHeader(ctx.request, VESLO_DEN_API_BASE_HEADER)
      ? { denApiBase: trimmedHeader(ctx.request, VESLO_DEN_API_BASE_HEADER) }
      : {}),
    ...(trimmedHeader(ctx.request, VESLO_DEN_TOKEN_HEADER)
      ? { denToken: trimmedHeader(ctx.request, VESLO_DEN_TOKEN_HEADER) }
      : {}),
    ...(trimmedHeader(ctx.request, VESLO_DEN_ORG_ID_HEADER)
      ? { denOrgId: trimmedHeader(ctx.request, VESLO_DEN_ORG_ID_HEADER) }
      : {}),
    ...(readDenUserIdentityHeader(ctx.request) ? { denUserId: readDenUserIdentityHeader(ctx.request) } : {}),
  };
}

function requireDenToken(ctx: RequestContext): string {
  const denToken = trimmedHeader(ctx.request, VESLO_DEN_TOKEN_HEADER);
  if (!denToken) {
    throw new ApiError(401, "den_token_required", "Missing Den token header (x-veslo-den-token)");
  }
  return denToken;
}

function requireDenOrgId(ctx: RequestContext): string {
  const denOrgId = trimmedHeader(ctx.request, VESLO_DEN_ORG_ID_HEADER);
  if (!denOrgId) {
    throw new ApiError(400, "den_org_required", "Missing Den org header (x-veslo-den-org-id)");
  }
  return denOrgId;
}

export function resolveRequestOverrideDenApiBase(ctx: RequestContext): string {
  const rawRequestBase = trimmedHeader(ctx.request, VESLO_DEN_API_BASE_HEADER) ?? "";
  if (rawRequestBase) {
    const normalized = normalizeDenApiBaseUrl(rawRequestBase);
    if (!normalized) {
      throw new ApiError(400, "den_api_base_invalid", "Invalid Den API base header (x-veslo-den-api-base)");
    }
    return normalized;
  }
  return normalizeDenApiBaseUrl(ctx.config.denApiBase) ?? "";
}

export function requireRequestOverrideDenCatalogContext(ctx: RequestContext): DenCatalogContext {
  const context = readRequestOverrideDenCatalogContext(ctx);
  if (!context.denApiBase) {
    throw new ApiError(503, "den_catalog_misconfigured", "Den catalog base URL is missing");
  }
  return context;
}

export function readRequestOverrideDenCatalogContext(ctx: RequestContext): DenCatalogContext {
  const denToken = requireDenToken(ctx);
  const denOrgId = requireDenOrgId(ctx);
  const denApiBase = resolveRequestOverrideDenApiBase(ctx);
  return { denToken, denOrgId, denApiBase };
}

export function readOptionalRequestOverrideDenCatalogContext(ctx: RequestContext): DenCatalogContext | null {
  const denToken = trimmedHeader(ctx.request, VESLO_DEN_TOKEN_HEADER);
  const denOrgId = trimmedHeader(ctx.request, VESLO_DEN_ORG_ID_HEADER);
  const denApiBaseHeader = trimmedHeader(ctx.request, VESLO_DEN_API_BASE_HEADER);
  if (!denToken && !denOrgId && !denApiBaseHeader) return null;
  return requireRequestOverrideDenCatalogContext(ctx);
}

export function requireConfiguredDenCatalogContext(ctx: RequestContext): DenCatalogContext {
  return {
    denToken: requireDenToken(ctx),
    denOrgId: requireDenOrgId(ctx),
    denApiBase: normalizeDenApiBaseUrl(ctx.config.denApiBase) ?? "",
  };
}

export function readSoulDenContext(ctx: RequestContext): SoulDenHeaderContext {
  const denContext = readDenContextHeaders(ctx);
  const requestBaseUrl = normalizeDenApiBaseUrl(denContext.denApiBase);
  const configuredBaseUrl = normalizeDenApiBaseUrl(ctx.config.denApiBase);
  return {
    baseUrl: requestBaseUrl || configuredBaseUrl || "",
    ...(denContext.denToken !== undefined ? { denToken: denContext.denToken } : {}),
    ...(denContext.denOrgId !== undefined ? { orgId: denContext.denOrgId } : {}),
    ...(denContext.denUserId !== undefined ? { userId: denContext.denUserId } : {}),
  };
}

export function skillRegistryConfiguredBaseUrl(config: Pick<ServerConfig, "skillRegistryBaseUrl">): string {
  return config.skillRegistryBaseUrl?.trim() || "";
}

export function skillRegistryRequestBaseUrl(ctx: RequestContext): string {
  return (
    skillRegistryConfiguredBaseUrl(ctx.config) ||
    (normalizeDenApiBaseUrl(trimmedHeader(ctx.request, VESLO_DEN_API_BASE_HEADER)) ?? "")
  );
}

export function requireSkillRegistryRequestBaseUrl(ctx: RequestContext): void {
  if (!skillRegistryRequestBaseUrl(ctx)) {
    throw new ApiError(503, "skill_registry_misconfigured", "Skill registry base URL is missing");
  }
}

export function readSkillRegistryIdentityHeaders(ctx: RequestContext): {
  denToken?: string;
  orgId?: string;
  userId?: string;
} {
  const denToken = trimmedHeader(ctx.request, VESLO_DEN_TOKEN_HEADER);
  const orgId = trimmedHeader(ctx.request, VESLO_DEN_ORG_ID_HEADER);
  const userId = readDenUserIdentityHeader(ctx.request);
  return {
    ...(denToken !== undefined ? { denToken } : {}),
    ...(orgId !== undefined ? { orgId } : {}),
    ...(userId !== undefined ? { userId } : {}),
  };
}

export function readSkillRegistryRequestInput(ctx: RequestContext): SkillRegistryRequestInput {
  const identity = readSkillRegistryIdentityHeaders(ctx);
  const token = ctx.config.skillRegistryToken?.trim() || undefined;
  return {
    baseUrl: skillRegistryRequestBaseUrl(ctx),
    ...(token !== undefined ? { token } : {}),
    ...(identity.denToken !== undefined ? { denToken: identity.denToken } : {}),
    ...(identity.orgId !== undefined ? { orgId: identity.orgId } : {}),
    ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
  };
}
