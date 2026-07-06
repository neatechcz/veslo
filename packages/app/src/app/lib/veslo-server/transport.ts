import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "../../utils";
import { fetchWithTimeout } from "../http";
import { wrapStartupRequestAuditFetch } from "../startup-request-audit";
import { runVesloJsonRequestWithBroker } from "./request-broker";
import type { VesloServerStatus, VesloSkillRegistryAuthContext } from "./types";

type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
};

export class VesloServerError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function resolveVesloServerAuthFailureStatus(
  error: unknown,
  credentials: { token?: string | null; hostToken?: string | null },
): VesloServerStatus | null {
  if (!(error instanceof VesloServerError) || (error.status !== 401 && error.status !== 403)) {
    return null;
  }
  const hasCredential = Boolean(credentials.token?.trim() || credentials.hostToken?.trim());
  return hasCredential ? "auth_desync" : "limited";
}

function buildHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-Veslo-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

function buildAuthHeaders(token?: string, hostToken?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-Veslo-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

export function normalizeBearerToken(token: string, label: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export function buildGatewayCallerHeaders(userToken: string) {
  return {
    "X-Veslo-Gateway-Authorization": normalizeBearerToken(userToken, "userToken"),
  };
}

export function buildDenContextHeaders(options?: VesloSkillRegistryAuthContext): Record<string, string> | undefined {
  const denApiBase = options?.denApiBase?.trim() ?? "";
  const denToken = options?.denToken?.trim() ?? "";
  const denOrgId = options?.denOrgId?.trim() ?? "";
  const denUserId = options?.denUserId?.trim() ?? "";
  const headers = {
    ...(denApiBase ? { "x-veslo-den-api-base": denApiBase } : {}),
    ...(denToken ? { "x-veslo-den-token": denToken } : {}),
    ...(denOrgId ? { "x-veslo-den-org-id": denOrgId } : {}),
    ...(denUserId ? { "x-veslo-den-user-id": denUserId } : {}),
  };
  return Object.keys(headers).length > 0 ? headers : undefined;
}

const auditedTauriFetch = wrapStartupRequestAuditFetch(
  tauriFetch as unknown as typeof globalThis.fetch,
  "tauri.veslo-server",
);

// Use Tauri's fetch when running in the desktop app to avoid CORS issues
const resolveFetch = () => (isTauriRuntime() ? auditedTauriFetch : globalThis.fetch);

const DEFAULT_VESLO_SERVER_TIMEOUT_MS = 10_000;

export async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    hostToken?: string;
    body?: unknown;
    timeoutMs?: number;
    extraHeaders?: Record<string, string>;
  } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const method = options.method ?? "GET";
  const headers = buildHeaders(options.token, options.hostToken, options.extraHeaders);
  const body = options.body ? JSON.stringify(options.body) : undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS;

  return runVesloJsonRequestWithBroker<T>({
    method,
    url,
    headers,
    timeoutMs,
    shareable: method.trim().toUpperCase() === "GET" && body === undefined,
    run: async () => {
      const fetchImpl = resolveFetch();
      const response = await fetchWithTimeout(
        fetchImpl,
        url,
        {
          method,
          headers,
          body,
        },
        timeoutMs,
      );

      const text = await response.text();
      const json = text ? JSON.parse(text) : null;

      if (!response.ok) {
        let code = typeof json?.code === "string" ? json.code : "request_failed";
        let message = typeof json?.message === "string" ? json.message : response.statusText;
        // Orchestrator proxy returns {"error":"workspace not found"} on 404 for
        // /workspace/:id/opencode/* and similar per-workspace paths. Treat it as
        // registry drift, not as proof that independently-derived workspace IDs
        // disagree.
        if (response.status === 404 && typeof json?.error === "string") {
          message = json.error;
          if (json.error === "workspace not found") {
            code = "workspace_registry_unsynced";
          }
        }
        throw new VesloServerError(response.status, code, message, json?.details);
      }

      return json as T;
    },
  });
}

export async function requestJsonRaw<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<RawJsonResponse<T>> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }

  return { ok: response.ok, status: response.status, json };
}

export async function requestMultipartRaw(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: FormData; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "POST",
      headers: buildAuthHeaders(options.token, options.hostToken),
      body: options.body,
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

export async function requestBinary(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildAuthHeaders(options.token, options.hostToken),
    },
    options.timeoutMs ?? DEFAULT_VESLO_SERVER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new VesloServerError(response.status, code, message, json?.details);
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2] ?? null;
  const filename = filenameRaw ? decodeURIComponent(filenameRaw) : null;
  const data = await response.arrayBuffer();
  return { data, contentType, filename };
}
