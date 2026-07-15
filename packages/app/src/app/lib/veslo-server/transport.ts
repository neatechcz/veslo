import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "../../utils";
import { fetchWithTimeout } from "../http";
import { wrapStartupRequestAuditFetch } from "../startup-request-audit";
import {
  buildVesloServerAuthHeaders as buildAuthHeaders,
  buildVesloServerJsonHeaders as buildHeaders,
} from "./header-profiles";
import { runVesloJsonRequestWithBroker } from "./request-broker";
import type { VesloServerStatus } from "./types";

export {
  buildDenContextHeaders,
  buildGatewayCallerHeaders,
  normalizeBearerToken,
} from "./header-profiles";

type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
};

export type VesloServerResponseMediaType =
  | "application/json"
  | "application/*+json"
  | "text/plain"
  | "missing"
  | "other";

export type VesloServerResponseKind = "empty" | "non_json" | "malformed_json";

export type VesloServerResponseDiagnostic = {
  requestMethod: string;
  operation: "session-archives:list";
  requestOrigin: string;
  requestPathname: string;
  httpStatus: number;
  mediaType: VesloServerResponseMediaType;
  responseContentType: string;
  responseKind: VesloServerResponseKind;
  responsePreview?: string;
};

const MAX_RESPONSE_CONTENT_TYPE_LENGTH = 128;
const MAX_RESPONSE_PREVIEW_LENGTH = 512;
const RESPONSE_PREVIEW_TRUNCATION_SUFFIX = "...[truncated]";
const RESPONSE_CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const REDACTED_RESPONSE_VALUE = "[redacted]";

const REQUEST_FAILED_MESSAGE = "The Veslo server request failed.";
const NON_JSON_RESPONSE_MESSAGE = "The Veslo server returned a non-JSON response.";
const MALFORMED_JSON_RESPONSE_MESSAGE = "The Veslo server returned malformed JSON.";

function recordFromValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class VesloServerError extends Error {
  status: number;
  code: string;
  details?: unknown;
  responseDiagnostic?: VesloServerResponseDiagnostic;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    responseDiagnostic?: unknown,
  ) {
    super(message);
    this.name = "VesloServerError";
    this.status = status;
    this.code = code;
    this.details = details;
    const normalizedDiagnostic = normalizeVesloServerResponseDiagnostic(responseDiagnostic);
    if (normalizedDiagnostic) {
      this.responseDiagnostic = normalizedDiagnostic;
    }
  }
}

function normalizeRequestMethod(method: string | undefined): string {
  return method?.trim().toUpperCase() || "GET";
}

function canonicalResponseContentType(value: string | null): string {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!mediaType) return "missing";
  if (
    mediaType.length > MAX_RESPONSE_CONTENT_TYPE_LENGTH
    || !RESPONSE_CONTENT_TYPE_PATTERN.test(mediaType)
  ) {
    return "invalid";
  }
  return mediaType;
}

function canonicalResponseMediaType(contentType: string): VesloServerResponseMediaType {
  if (contentType === "missing") return "missing";
  if (contentType === "application/json") return "application/json";
  if (/^application\/[a-z0-9!#$&^_.+-]+\+json$/i.test(contentType)) return "application/*+json";
  if (contentType === "text/plain") return "text/plain";
  return "other";
}

function normalizeDiagnosticOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin === "null" ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

function normalizeDiagnosticPathname(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || !value.startsWith("/")
    || value.startsWith("//")
    || /[?#\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  try {
    return new URL(value, "https://diagnostic.invalid").pathname === value ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeResponseContentType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "missing" || value === "invalid") return value;
  const canonical = canonicalResponseContentType(value);
  return canonical === value && canonical !== "missing" && canonical !== "invalid"
    ? canonical
    : undefined;
}

function stripResponsePreviewQueryValues(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
      try {
        const url = new URL(match);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(/([?&][a-z0-9_.-]+)=([^&\s"'<>]*)/gi, "$1=[redacted]");
}

function redactResponsePreview(value: string): string | undefined {
  const sanitized = stripResponsePreviewQueryValues(value)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;&]+/gi, (match) => {
      const scheme = match.split(/\s+/, 1)[0] ?? "Bearer";
      return `${scheme} ${REDACTED_RESPONSE_VALUE}`;
    })
    .replace(/\bAuthorization\s*[:=]\s*[^\s,;]+/gi, `Authorization: ${REDACTED_RESPONSE_VALUE}`)
    .replace(
      /((?:["']?(?:access[-_]?token|token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|code|verifier)["']?)\s*[:=]\s*)(?:\[redacted\]|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}&\]<>"']+)/gi,
      `$1${REDACTED_RESPONSE_VALUE}`,
    )
    .replace(/\/Users\/[^/\s"'<>]+/g, "[redacted-home]")
    .replace(/\/home\/[^/\s"'<>]+/g, "[redacted-home]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+/g, "[redacted-home]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) return undefined;
  const characters = Array.from(sanitized);
  if (characters.length <= MAX_RESPONSE_PREVIEW_LENGTH) return sanitized;
  return `${characters.slice(0, MAX_RESPONSE_PREVIEW_LENGTH - RESPONSE_PREVIEW_TRUNCATION_SUFFIX.length).join("")}${RESPONSE_PREVIEW_TRUNCATION_SUFFIX}`;
}

function diagnosticEndpoint(urlValue: string): { requestOrigin: string; requestPathname: string } | undefined {
  try {
    const url = new URL(urlValue);
    const requestOrigin = normalizeDiagnosticOrigin(url.origin);
    const requestPathname = normalizeDiagnosticPathname(url.pathname);
    return requestOrigin && requestPathname ? { requestOrigin, requestPathname } : undefined;
  } catch {
    return undefined;
  }
}

function isJsonMediaType(mediaType: VesloServerResponseMediaType): boolean {
  return mediaType === "application/json" || mediaType === "application/*+json";
}

function isResponseKind(value: unknown): value is VesloServerResponseKind {
  return value === "empty" || value === "non_json" || value === "malformed_json";
}

function isResponseMediaType(value: unknown): value is VesloServerResponseMediaType {
  return value === "application/json"
    || value === "application/*+json"
    || value === "text/plain"
    || value === "missing"
    || value === "other";
}

export function normalizeVesloServerResponseDiagnostic(
  value: unknown,
): VesloServerResponseDiagnostic | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<VesloServerResponseDiagnostic>;
  const httpStatus = candidate.httpStatus;
  const requestOrigin = normalizeDiagnosticOrigin(candidate.requestOrigin);
  const requestPathname = normalizeDiagnosticPathname(candidate.requestPathname);
  const responseContentType = normalizeResponseContentType(candidate.responseContentType);
  if (
    candidate.operation !== "session-archives:list"
    || typeof candidate.requestMethod !== "string"
    || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(candidate.requestMethod)
    || !requestOrigin
    || !requestPathname
    || typeof httpStatus !== "number"
    || !Number.isInteger(httpStatus)
    || httpStatus < 100
    || httpStatus > 599
    || !isResponseMediaType(candidate.mediaType)
    || !responseContentType
    || !isResponseKind(candidate.responseKind)
  ) {
    return undefined;
  }

  const responsePreview =
    typeof candidate.responsePreview === "string"
      ? redactResponsePreview(candidate.responsePreview)
      : undefined;

  return {
    requestMethod: candidate.requestMethod,
    operation: candidate.operation,
    requestOrigin,
    requestPathname,
    httpStatus,
    mediaType: candidate.mediaType,
    responseContentType,
    responseKind: candidate.responseKind,
    ...(responsePreview ? { responsePreview } : {}),
  };
}

function buildResponseDiagnostic(
  operation: VesloServerResponseDiagnostic["operation"] | undefined,
  requestUrl: string,
  requestMethod: string,
  response: Response,
  mediaType: VesloServerResponseMediaType,
  responseContentType: string,
  responseKind: VesloServerResponseKind,
  text: string,
): VesloServerResponseDiagnostic | undefined {
  if (!operation) return undefined;
  const endpoint = diagnosticEndpoint(requestUrl);
  if (!endpoint) return undefined;
  return normalizeVesloServerResponseDiagnostic({
    requestMethod,
    operation,
    ...endpoint,
    httpStatus: response.status,
    mediaType,
    responseContentType,
    responseKind,
    responsePreview: text,
  });
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
    diagnosticOperation?: VesloServerResponseDiagnostic["operation"];
  } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const method = normalizeRequestMethod(options.method);
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
      const init: RequestInit = {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      };
      const response = await fetchWithTimeout(
        fetchImpl,
        url,
        init,
        timeoutMs,
      );

      const text = await response.text();
      const isEmptyResponse = text.trim().length === 0;
      const responseContentType = canonicalResponseContentType(response.headers.get("content-type"));
      const mediaType = canonicalResponseMediaType(responseContentType);

      if (!isEmptyResponse && !isJsonMediaType(mediaType)) {
        throw new VesloServerError(
          response.status,
          "non_json_response",
          NON_JSON_RESPONSE_MESSAGE,
          undefined,
          buildResponseDiagnostic(
            options.diagnosticOperation,
            url,
            method,
            response,
            mediaType,
            responseContentType,
            "non_json",
            text,
          ),
        );
      }

      let json: any = null;
      if (!isEmptyResponse) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new VesloServerError(
            response.status,
            "malformed_json_response",
            MALFORMED_JSON_RESPONSE_MESSAGE,
            undefined,
            buildResponseDiagnostic(
              options.diagnosticOperation,
              url,
              method,
              response,
              mediaType,
              responseContentType,
              "malformed_json",
              text,
            ),
          );
        }
      }

      if (!response.ok) {
        let code = typeof json?.code === "string" ? json.code : "request_failed";
        let message = typeof json?.message === "string" ? json.message : REQUEST_FAILED_MESSAGE;
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
        throw new VesloServerError(
          response.status,
          code,
          message,
          json?.details,
          isEmptyResponse
            ? buildResponseDiagnostic(
                options.diagnosticOperation,
                url,
                method,
                response,
                mediaType,
                responseContentType,
                "empty",
                text,
              )
            : undefined,
        );
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
  const body = options.body ? JSON.stringify(options.body) : undefined;
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: buildHeaders(options.token, options.hostToken),
    ...(body !== undefined ? { body } : {}),
  };
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    init,
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
  const init: RequestInit = {
    method: options.method ?? "POST",
    headers: buildAuthHeaders(options.token, options.hostToken),
    ...(options.body ? { body: options.body } : {}),
  };
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    init,
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
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const errorPayload = recordFromValue(json);
    const code = typeof errorPayload.code === "string" ? errorPayload.code : "request_failed";
    const message = typeof errorPayload.message === "string" ? errorPayload.message : response.statusText;
    throw new VesloServerError(response.status, code, message, errorPayload.details);
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2] ?? null;
  const filename = filenameRaw ? decodeURIComponent(filenameRaw) : null;
  const data = await response.arrayBuffer();
  return { data, contentType, filename };
}
