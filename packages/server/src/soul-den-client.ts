import { ApiError } from "./errors.js";
import type { SoulDocument, SoulScope, SoulVersion } from "./soul-memory.js";

type SoulDenScope = Extract<SoulScope, "organization" | "user">;

type SoulDenClientInput = {
  baseUrl: string;
  token?: string;
  denToken?: string;
  orgId?: string;
  userId?: string;
  requestId?: string;
  fetch?: typeof fetch;
};

type ScopedSoulInput = SoulDenClientInput & {
  scope: SoulDenScope;
};

type UpdateSoulInput = SoulDenClientInput & {
  content: string;
  changeSummary: string;
  baseVersionId: string | null;
  heartbeatEnabled?: boolean;
};

type ListSoulVersionsInput = ScopedSoulInput & {
  cursor?: string;
  limit?: number;
};

type SoulVersionInput = ScopedSoulInput & {
  versionId: string;
};

type RestoreSoulVersionInput = SoulVersionInput & {
  changeSummary: string;
};

export type SoulVersionsResponse = {
  versions: SoulVersion[];
  nextCursor: string | null;
};

function parseBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new ApiError(500, "soul_den_misconfigured", "Soul Den base URL is missing");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError(500, "soul_den_misconfigured", "Soul Den base URL is invalid", { url: trimmed });
  }

  if (parsed.search || parsed.hash) {
    throw new ApiError(500, "soul_den_misconfigured", "Soul Den base URL must not include query or hash", {
      url: `${parsed.origin}${parsed.pathname}`,
    });
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(500, "soul_den_misconfigured", "Soul Den base URL must not include credentials", {
      url: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
    });
  }

  return parsed;
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

function buildHeaders(input: SoulDenClientInput): Headers {
  const headers = new Headers({ Accept: "application/json" });
  const token = input.token?.trim() || input.denToken?.trim();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const orgId = input.orgId?.trim();
  if (orgId) {
    headers.set("x-veslo-org-id", orgId);
    headers.set("x-veslo-den-org-id", orgId);
  }

  const userId = input.userId?.trim();
  if (userId) {
    headers.set("x-veslo-user-id", userId);
    headers.set("x-veslo-den-user-id", userId);
  }

  const requestId = input.requestId?.trim();
  if (requestId) headers.set("x-request-id", requestId);

  return headers;
}

async function parseSoulJson(response: Response, url: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiError(502, "soul_den_invalid_payload", "Soul Den returned invalid JSON", {
      url,
      status: response.status,
    });
  }
}

async function buildStatusDetails(response: Response, url: string): Promise<{ url: string; status: number }> {
  await response.body?.cancel().catch(() => undefined);
  return { url, status: response.status };
}

async function throwSoulStatusError(response: Response, url: string): Promise<never> {
  const details = await buildStatusDetails(response, url);
  if (response.status === 401) {
    throw new ApiError(401, "soul_den_unauthorized", "Soul Den authorization failed", details);
  }
  if (response.status === 403) {
    throw new ApiError(403, "soul_den_forbidden", "Soul Den access is forbidden", details);
  }
  if (response.status === 404) {
    throw new ApiError(404, "soul_den_not_found", "Soul Den resource was not found", details);
  }
  if (response.status === 409) {
    throw new ApiError(409, "soul_den_conflict", "Soul Den rejected a stale Soul version", details);
  }
  throw new ApiError(502, "soul_den_fetch_failed", `Soul Den request failed (${response.status})`, details);
}

async function fetchSoulJson(
  input: SoulDenClientInput,
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  let response: Response;
  const headers = buildHeaders(input);
  const hasBody = options.body !== undefined;
  if (hasBody) headers.set("content-type", "application/json");

  try {
    response = await (input.fetch ?? fetch)(url, {
      ...(options.method ? { method: options.method } : {}),
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ApiError(502, "soul_den_fetch_failed", "Failed to fetch Soul Den", { url });
  }

  if (!response.ok) {
    await throwSoulStatusError(response, url);
  }

  return parseSoulJson(response, url);
}

function validateSoulDocument(payload: unknown, url: string): SoulDocument {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(502, "soul_den_invalid_payload", "Soul Den returned an invalid Soul document", { url });
  }
  const document = payload as SoulDocument;
  if (
    typeof document.id !== "string"
    || !["organization", "user", "workspace"].includes(document.scope)
    || typeof document.ownerId !== "string"
    || !(document.currentVersionId === null || typeof document.currentVersionId === "string")
    || typeof document.heartbeatEnabled !== "boolean"
    || !Array.isArray(document.versions)
  ) {
    throw new ApiError(502, "soul_den_invalid_payload", "Soul Den returned an invalid Soul document", { url });
  }
  return document;
}

function validateSoulVersion(payload: unknown, url: string): SoulVersion {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(502, "soul_den_invalid_payload", "Soul Den returned an invalid Soul version", { url });
  }
  const version = payload as SoulVersion;
  if (
    typeof version.id !== "string"
    || typeof version.content !== "string"
    || typeof version.changeSummary !== "string"
    || typeof version.createdAt !== "string"
    || typeof version.createdBy !== "string"
    || typeof version.source !== "string"
    || !(version.baseVersionId === null || typeof version.baseVersionId === "string")
    || !(version.restoreSourceVersionId === null || typeof version.restoreSourceVersionId === "string")
  ) {
    throw new ApiError(502, "soul_den_invalid_payload", "Soul Den returned an invalid Soul version", { url });
  }
  return version;
}

function validateSoulVersionsResponse(payload: unknown, url: string): SoulVersionsResponse {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(502, "soul_den_invalid_payload", "Soul Den returned invalid Soul versions", { url });
  }
  const response = payload as SoulVersionsResponse;
  if (!Array.isArray(response.versions) || !(response.nextCursor === null || typeof response.nextCursor === "string")) {
    throw new ApiError(502, "soul_den_invalid_payload", "Soul Den returned invalid Soul versions", { url });
  }
  return {
    versions: response.versions.map((item) => validateSoulVersion(item, url)),
    nextCursor: response.nextCursor,
  };
}

function updateBody(input: UpdateSoulInput): {
  content: string;
  changeSummary: string;
  baseVersionId: string | null;
  heartbeatEnabled?: boolean;
} {
  return {
    content: input.content,
    changeSummary: input.changeSummary,
    baseVersionId: input.baseVersionId,
    ...(input.heartbeatEnabled === undefined ? {} : { heartbeatEnabled: input.heartbeatEnabled }),
  };
}

export async function getUserSoul(input: SoulDenClientInput): Promise<SoulDocument> {
  const url = buildUrl(input.baseUrl, "/v1/soul/user");
  return validateSoulDocument(await fetchSoulJson(input, url), url);
}

export async function updateUserSoul(input: UpdateSoulInput): Promise<SoulDocument> {
  const url = buildUrl(input.baseUrl, "/v1/soul/user");
  return validateSoulDocument(await fetchSoulJson(input, url, { method: "PATCH", body: updateBody(input) }), url);
}

export async function getOrganizationSoul(input: SoulDenClientInput): Promise<SoulDocument> {
  const url = buildUrl(input.baseUrl, "/v1/soul/organization");
  return validateSoulDocument(await fetchSoulJson(input, url), url);
}

export async function updateOrganizationSoul(input: UpdateSoulInput): Promise<SoulDocument> {
  const url = buildUrl(input.baseUrl, "/v1/soul/organization");
  return validateSoulDocument(await fetchSoulJson(input, url, { method: "PATCH", body: updateBody(input) }), url);
}

export async function listSoulVersions(input: ListSoulVersionsInput): Promise<SoulVersionsResponse> {
  const url = buildUrl(input.baseUrl, `/v1/soul/${input.scope}/versions`, {
    cursor: input.cursor,
    limit: input.limit,
  });
  return validateSoulVersionsResponse(await fetchSoulJson(input, url), url);
}

export async function getSoulVersion(input: SoulVersionInput): Promise<SoulVersion> {
  const url = buildUrl(input.baseUrl, `/v1/soul/${input.scope}/versions/${encodeURIComponent(input.versionId)}`);
  return validateSoulVersion(await fetchSoulJson(input, url), url);
}

export async function restoreSoulVersion(input: RestoreSoulVersionInput): Promise<SoulDocument> {
  const url = buildUrl(
    input.baseUrl,
    `/v1/soul/${input.scope}/versions/${encodeURIComponent(input.versionId)}/restore`,
  );
  return validateSoulDocument(
    await fetchSoulJson(input, url, { method: "POST", body: { changeSummary: input.changeSummary } }),
    url,
  );
}
