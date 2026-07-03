import { ApiError } from "./errors.js";
import type { HubMcpAuthorization, HubMcpItem, HubSkillItem } from "./types.js";

type DenCatalogPayload = {
  items?: unknown;
};

function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith("/") ? trimmed.replace(/\/+$/, "") : trimmed;
}

function toHubSkillItem(item: unknown, index: number): HubSkillItem {
  if (!item || typeof item !== "object") {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  const payload = item as Record<string, unknown>;
  const source = payload.source as Record<string, unknown> | undefined;
  if (
    typeof payload.name !== "string" ||
    typeof payload.description !== "string" ||
    !source ||
    typeof source.owner !== "string" ||
    typeof source.repo !== "string" ||
    typeof source.ref !== "string" ||
    typeof source.path !== "string"
  ) {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  return {
    name: payload.name,
    description: payload.description,
    ...(typeof payload.trigger === "string" ? { trigger: payload.trigger } : {}),
    source: {
      owner: source.owner,
      repo: source.repo,
      ref: source.ref,
      path: source.path,
    },
  };
}

function toMcpOAuthConfig(value: unknown, index: number) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  const payload = value as Record<string, unknown>;
  if (typeof payload.clientId !== "string") {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }
  if (payload.clientSecret !== undefined && typeof payload.clientSecret !== "string") {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }
  if (payload.scope !== undefined && typeof payload.scope !== "string") {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  return {
    clientId: payload.clientId,
    ...(typeof payload.clientSecret === "string" ? { clientSecret: payload.clientSecret } : {}),
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
  };
}

const FORBIDDEN_MCP_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-veslo-den-token",
  "x-veslo-connector-token",
]);

const SAFE_MCP_HEADER_NAMES = new Set([
  "x-veslo-connector",
]);

const FORBIDDEN_MCP_HEADER_NAME_PARTS = new Set([
  "authorization",
  "cookie",
  "key",
  "secret",
  "token",
]);

const FORBIDDEN_MCP_HEADER_NAME_FRAGMENTS = [
  "apikey",
  "accesstoken",
  "clientsecret",
  "idtoken",
  "refreshtoken",
];

function isForbiddenMcpHeaderName(key: string) {
  const normalizedKey = key.trim().toLowerCase();
  if (SAFE_MCP_HEADER_NAMES.has(normalizedKey)) {
    return false;
  }
  if (FORBIDDEN_MCP_HEADER_NAMES.has(normalizedKey)) {
    return true;
  }

  const parts = normalizedKey.split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.some((part) => FORBIDDEN_MCP_HEADER_NAME_PARTS.has(part))) {
    return true;
  }

  const compactKey = parts.join("");
  return FORBIDDEN_MCP_HEADER_NAME_FRAGMENTS.some((fragment) => compactKey.includes(fragment));
}

function toMcpHeaders(value: unknown, index: number): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog headers at index ${index}`);
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      !key.trim() ||
      isForbiddenMcpHeaderName(key) ||
      typeof entry !== "string" ||
      /bearer\s+/i.test(entry) ||
      /\{env:/i.test(entry)
    ) {
      throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog headers at index ${index}`);
    }
    result[key] = entry;
  }
  return result;
}

const FORBIDDEN_MCP_AUTHORIZATION_FIELD_NAMES = new Set([
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "runtimetoken",
  "token",
  "clientid",
  "clientsecret",
]);

function toMcpAuthorization(value: unknown, index: number): HubMcpAuthorization | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog authorization at index ${index}`);
  }

  const payload = value as Record<string, unknown>;
  const hasForbiddenTokenMaterial = Object.keys(payload).some((key) =>
    FORBIDDEN_MCP_AUTHORIZATION_FIELD_NAMES.has(key.replace(/[-_]/g, "").toLowerCase()));
  if (
    hasForbiddenTokenMaterial ||
    payload.type !== "veslo-server-oauth" ||
    typeof payload.provider !== "string" ||
    typeof payload.connectorId !== "string" ||
    !Array.isArray(payload.scopes) ||
    payload.scopes.some((scope) => typeof scope !== "string") ||
    typeof payload.startPath !== "string" ||
    typeof payload.runtimeTokenPath !== "string" ||
    typeof payload.statusPath !== "string" ||
    typeof payload.disconnectPath !== "string"
  ) {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog authorization at index ${index}`);
  }

  return {
    type: "veslo-server-oauth",
    provider: payload.provider,
    connectorId: payload.connectorId,
    scopes: payload.scopes as string[],
    startPath: payload.startPath,
    runtimeTokenPath: payload.runtimeTokenPath,
    statusPath: payload.statusPath,
    disconnectPath: payload.disconnectPath,
  };
}

function toHubMcpItem(item: unknown, index: number): HubMcpItem {
  if (!item || typeof item !== "object") {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  const payload = item as Record<string, unknown>;
  const config = payload.config as Record<string, unknown> | undefined;
  const source = payload.source as Record<string, unknown> | undefined;
  if (
    typeof payload.id !== "string" ||
    typeof payload.name !== "string" ||
    (payload.description !== undefined && typeof payload.description !== "string") ||
    !config ||
    (config.type !== "remote" && config.type !== "local") ||
    !source
  ) {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  let normalizedSource: HubMcpItem["source"];
  if (source.scope === "org") {
    if (typeof source.orgId !== "string") {
      throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
    }
    normalizedSource = {
      scope: "org",
      orgId: source.orgId,
    };
  } else if (source.scope === "platform") {
    normalizedSource = { scope: "platform" };
  } else {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  const provider = payload.provider as Record<string, unknown> | undefined;
  if (
    provider !== undefined &&
    (!provider ||
      typeof provider !== "object" ||
      typeof provider.id !== "string" ||
      (provider.group !== undefined && typeof provider.group !== "string"))
  ) {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  if (config.type === "remote" && typeof config.url !== "string") {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  if (
    config.type === "local" &&
    (!Array.isArray(config.command) || config.command.some((part) => typeof part !== "string"))
  ) {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  const oauth = toMcpOAuthConfig(config.oauth, index);
  const headers = toMcpHeaders(config.headers, index);
  const authorization = toMcpAuthorization(payload.authorization, index);
  if (authorization?.type === "veslo-server-oauth" && oauth !== undefined && oauth !== false) {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  return {
    id: payload.id,
    name: payload.name,
    ...(typeof payload.description === "string" ? { description: payload.description } : {}),
    config: {
      type: config.type,
      ...(typeof config.url === "string" ? { url: config.url } : {}),
      ...(Array.isArray(config.command) ? { command: config.command as string[] } : {}),
      ...(oauth !== undefined ? { oauth } : {}),
      ...(headers !== undefined ? { headers } : {}),
    },
    ...(authorization !== undefined ? { authorization } : {}),
    source: normalizedSource,
    ...(provider !== undefined
      ? {
          provider: {
            id: provider.id as string,
            ...(typeof provider.group === "string" ? { group: provider.group } : {}),
          },
        }
      : {}),
  };
}

export async function fetchOrgSkillsCatalog(input: {
  baseUrl: string;
  orgId: string;
  denToken: string;
}): Promise<HubSkillItem[]> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) {
    throw new ApiError(500, "den_catalog_misconfigured", "Den catalog base URL is missing");
  }

  const orgId = input.orgId.trim();
  if (!orgId) {
    throw new ApiError(400, "den_org_required", "Den organization id is required");
  }

  const denToken = input.denToken.trim();
  if (!denToken) {
    throw new ApiError(401, "den_token_required", "Den token is required");
  }

  const url = `${baseUrl}/v1/orgs/${encodeURIComponent(orgId)}/skills/catalog`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${denToken}`,
      },
    });
  } catch (error) {
    throw new ApiError(
      502,
      "den_catalog_fetch_failed",
      "Failed to fetch Den org skills catalog",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new ApiError(
      502,
      "den_catalog_fetch_failed",
      `Failed to fetch Den org skills catalog (${response.status})`,
      details || url,
    );
  }

  let payload: DenCatalogPayload;
  try {
    payload = await response.json() as DenCatalogPayload;
  } catch {
    throw new ApiError(502, "den_catalog_invalid_payload", "Den org skills catalog returned invalid JSON");
  }

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
    throw new ApiError(502, "den_catalog_invalid_payload", "Den org skills catalog payload must contain items array");
  }

  return payload.items.map((item, index) => toHubSkillItem(item, index));
}

export async function fetchOrgMcpCatalog(input: {
  baseUrl: string;
  orgId: string;
  denToken: string;
}): Promise<HubMcpItem[]> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) {
    throw new ApiError(500, "den_catalog_misconfigured", "Den catalog base URL is missing");
  }

  const orgId = input.orgId.trim();
  if (!orgId) {
    throw new ApiError(400, "den_org_required", "Den organization id is required");
  }

  const denToken = input.denToken.trim();
  if (!denToken) {
    throw new ApiError(401, "den_token_required", "Den token is required");
  }

  const url = `${baseUrl}/v1/orgs/${encodeURIComponent(orgId)}/mcp/catalog`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${denToken}`,
      },
    });
  } catch (error) {
    throw new ApiError(
      502,
      "den_catalog_fetch_failed",
      "Failed to fetch Den org MCP catalog",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new ApiError(
      502,
      "den_catalog_fetch_failed",
      `Failed to fetch Den org MCP catalog (${response.status})`,
      details || url,
    );
  }

  let payload: DenCatalogPayload;
  try {
    payload = await response.json() as DenCatalogPayload;
  } catch {
    throw new ApiError(502, "den_catalog_invalid_payload", "Den org MCP catalog returned invalid JSON");
  }

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
    throw new ApiError(502, "den_catalog_invalid_payload", "Den org MCP catalog payload must contain items array");
  }

  return payload.items.map((item, index) => toHubMcpItem(item, index));
}

export async function createOrgMcpRuntimeToken(input: {
  baseUrl: string;
  denToken: string;
  runtimeTokenPath: string;
}): Promise<{ token: string; expiresAt: string | null }> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) {
    throw new ApiError(500, "den_catalog_misconfigured", "Den catalog base URL is missing");
  }

  const denToken = input.denToken.trim();
  if (!denToken) {
    throw new ApiError(401, "den_token_required", "Den token is required");
  }

  const path = input.runtimeTokenPath.trim();
  if (!path.startsWith("/v1/")) {
    throw new ApiError(502, "den_catalog_invalid_payload", "Den runtime token path is invalid");
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${denToken}`,
      },
    });
  } catch (error) {
    throw new ApiError(
      502,
      "den_runtime_token_fetch_failed",
      "Failed to fetch Den MCP runtime token",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new ApiError(
      502,
      "den_runtime_token_fetch_failed",
      `Failed to fetch Den MCP runtime token (${response.status})`,
      details || path,
    );
  }

  const payload = await response.json().catch(() => null) as {
    token?: unknown;
    expiresAt?: unknown;
  } | null;
  if (
    !payload ||
    typeof payload.token !== "string" ||
    (payload.expiresAt !== null && payload.expiresAt !== undefined && typeof payload.expiresAt !== "string")
  ) {
    throw new ApiError(502, "den_catalog_invalid_payload", "Den MCP runtime token payload is invalid");
  }

  return {
    token: payload.token,
    expiresAt: typeof payload.expiresAt === "string" ? payload.expiresAt : null,
  };
}
