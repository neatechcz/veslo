import { ApiError } from "./errors.js";
import type { HubSkillItem } from "./types.js";

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
