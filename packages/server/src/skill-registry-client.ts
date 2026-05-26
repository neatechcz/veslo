import { ApiError } from "./errors.js";
import {
  validateRegistrySkillListResponse,
  validateRegistrySkillPackageResponse,
  validateRegistrySkillSearchResponse,
} from "./skill-registry-types.js";
import type {
  RegistrySkillListResponse,
  RegistrySkillPackageResponse,
  RegistrySkillSearchResponse,
} from "./skill-registry-types.js";

type RegistryClientInput = {
  baseUrl: string;
  token?: string;
  denToken?: string;
  orgId?: string;
};

type PaginatedInput = RegistryClientInput & {
  cursor?: string;
  limit?: number;
};

type SearchInput = PaginatedInput & {
  query: string;
};

type DownloadPackageInput = RegistryClientInput & {
  versionId: string;
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

async function fetchRegistryJson(input: RegistryClientInput, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(input),
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

export async function searchRegistrySkills(input: SearchInput): Promise<RegistrySkillSearchResponse> {
  const url = buildUrl(input.baseUrl, "/v1/skills/search", {
    q: input.query,
    cursor: input.cursor,
    limit: input.limit,
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
