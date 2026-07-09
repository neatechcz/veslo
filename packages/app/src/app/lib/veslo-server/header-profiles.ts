import type { VesloSkillRegistryAuthContext } from "./types";

export const AUTHORIZATION_HEADER = "Authorization";
export const CONTENT_TYPE_HEADER = "Content-Type";
export const ACCEPT_HEADER = "Accept";
export const VESLO_HOST_TOKEN_HEADER = "X-Veslo-Host-Token";
export const VESLO_SEND_TRACE_ID_HEADER = "X-Veslo-Send-Trace-Id";
export const VESLO_ACCOUNT_ID_HEADER = "X-Veslo-Account-Id";
export const VESLO_DEN_API_BASE_HEADER = "x-veslo-den-api-base";
export const VESLO_DEN_TOKEN_HEADER = "x-veslo-den-token";
export const VESLO_DEN_ORG_ID_HEADER = "x-veslo-den-org-id";
export const VESLO_DEN_USER_ID_HEADER = "x-veslo-den-user-id";
export const VESLO_GATEWAY_AUTHORIZATION_HEADER = "X-Veslo-Gateway-Authorization";

export function normalizeBearerToken(token: string, label: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function applyVesloServerCredentials(
  headers: Record<string, string>,
  token?: string,
  hostToken?: string,
): void {
  if (token) {
    headers[AUTHORIZATION_HEADER] = `Bearer ${token}`;
  }
  if (hostToken) {
    headers[VESLO_HOST_TOKEN_HEADER] = hostToken;
  }
}

function applyExtraHeaders(headers: Record<string, string>, extra?: Record<string, string>): void {
  if (!extra) return;
  // Compatibility: existing callers can override base auth/content headers via extraHeaders.
  Object.assign(headers, extra);
}

export function buildVesloServerJsonHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { [CONTENT_TYPE_HEADER]: "application/json" };
  applyVesloServerCredentials(headers, token, hostToken);
  applyExtraHeaders(headers, extra);
  return headers;
}

export function buildVesloServerAuthHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  applyVesloServerCredentials(headers, token, hostToken);
  applyExtraHeaders(headers, extra);
  return headers;
}

export function buildGatewayCallerHeaders(userToken: string): Record<string, string> {
  return {
    [VESLO_GATEWAY_AUTHORIZATION_HEADER]: normalizeBearerToken(userToken, "userToken"),
  };
}

export function buildDenContextHeaders(options?: VesloSkillRegistryAuthContext): Record<string, string> | undefined {
  const denApiBase = options?.denApiBase?.trim() ?? "";
  const denToken = options?.denToken?.trim() ?? "";
  const denOrgId = options?.denOrgId?.trim() ?? "";
  const denUserId = options?.denUserId?.trim() ?? "";
  const headers = {
    ...(denApiBase ? { [VESLO_DEN_API_BASE_HEADER]: denApiBase } : {}),
    ...(denToken ? { [VESLO_DEN_TOKEN_HEADER]: denToken } : {}),
    ...(denOrgId ? { [VESLO_DEN_ORG_ID_HEADER]: denOrgId } : {}),
    ...(denUserId ? { [VESLO_DEN_USER_ID_HEADER]: denUserId } : {}),
  };
  return Object.keys(headers).length > 0 ? headers : undefined;
}
