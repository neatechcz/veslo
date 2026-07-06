import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { parse } from "jsonc-parser";

import { isTauriRuntime } from "../utils";
import { isGatewayOwnedProvider, type GatewayOwnedProviderId } from "../utils/providers";
import { fetchWithTimeout } from "./http";
import { recordSendWorkflowTrace } from "./send-workflow-trace";
import { wrapStartupRequestAuditFetch } from "./startup-request-audit";

export type FieldsResult<T> =
  | ({ data: T; error?: undefined } & { request: Request; response: Response })
  | ({ data?: undefined; error: unknown } & { request: Request; response: Response });

export type OpencodeAuth = {
  username?: string;
  password?: string;
  token?: string;
  mode?: "basic" | "veslo";
};

// VSLO-86 — opencode engine cold-start (Bun JIT + SQLite migration + sandbox
// init + plugin vendoring) routinely takes 15-30s, and the first proxy request
// through the orchestrator after a workspace activate must wait for the engine
// to finish spawning. A 10s frontend timeout (the previous value) raced the
// engine warmup and surfaced as "Request timed out" Error badges on every
// workspace in the sidebar. Once the engine is up, requests complete in tens
// of ms — the longer ceiling only changes worst-case behavior.
const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 60_000;
const OAUTH_OPENCODE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS = 90_000;
const GATEWAY_PROVIDER_SECRET_OPTION_KEYS = new Set([
  "apikey",
  "apikeyid",
  "accesstoken",
  "refreshtoken",
  "token",
]);
const SERVER_PATCH_COMPARISON_SECRET_VALUE = "__veslo_secret_value__";
// VSLO-86 — a literal "[REDACTED]" sitting in opencode.jsonc on disk is a
// broken state from an earlier patch round-trip where the server returned
// the redacted value and the app patched it back through formatConfig. The
// comparison normalizer must distinguish this from a real token so the
// boot-time effect forces a re-patch with the current generated routing.
const SERVER_PATCH_COMPARISON_REDACTED_LITERAL = "__veslo_broken_redacted_token__";
const REDACTED_LITERAL = "[REDACTED]";

export const OPENCODE_SESSION_ID_TEMPLATE = "${OPENCODE_SESSION_ID}";
export const VESLO_OPENCODE_SERVER_CLIENT_TOKEN_ENV = "VESLO_OPENCODE_SERVER_CLIENT_TOKEN";
export const VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE = `{env:${VESLO_OPENCODE_SERVER_CLIENT_TOKEN_ENV}}`;
const VESLO_SESSION_ID_HEADER = "x-veslo-session-id";
export const VESLO_WORKSPACE_ID_HEADER = "x-veslo-workspace-id";
const CODEX_OAUTH_MODEL_OPTIONS: Record<string, unknown> = {
  reasoningEffort: "high",
  textVerbosity: "low",
  reasoningSummary: "auto",
};
const CODEX_OAUTH_MODEL_VARIANTS: Record<string, Record<string, unknown>> = {
  low: {
    reasoningEffort: "low",
    textVerbosity: "low",
    reasoningSummary: "auto",
  },
  medium: {
    reasoningEffort: "medium",
    textVerbosity: "low",
    reasoningSummary: "auto",
  },
  high: {
    reasoningEffort: "high",
    textVerbosity: "low",
    reasoningSummary: "auto",
  },
  xhigh: {
    reasoningEffort: "high",
    textVerbosity: "low",
    reasoningSummary: "auto",
  },
};
const auditedTauriFetch = wrapStartupRequestAuditFetch(
  tauriFetch as unknown as typeof globalThis.fetch,
  "tauri.opencode",
);

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

function resolveRequestTimeoutMs(input: RequestInfo | URL, fallbackMs: number): number {
  const url = getRequestUrl(input);
  if (/\/provider\/oauth\//.test(url) || /\/mcp\/auth\/callback\b/.test(url)) {
    return Math.max(fallbackMs, OAUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  if (/\/mcp\/.*auth\b/.test(url)) {
    return Math.max(fallbackMs, MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  return fallbackMs;
}

const encodeBasicAuth = (auth?: OpencodeAuth) => {
  if (!auth?.username || !auth?.password) return null;
  const token = `${auth.username}:${auth.password}`;
  if (typeof btoa === "function") return btoa(token);
  const buffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } } })
    .Buffer;
  return buffer ? buffer.from(token, "utf8").toString("base64") : null;
};

const resolveAuthHeader = (auth?: OpencodeAuth) => {
  if (auth?.mode === "veslo" && auth.token) {
    return `Bearer ${auth.token}`;
  }
  const encoded = encodeBasicAuth(auth);
  return encoded ? `Basic ${encoded}` : null;
};

const createTauriFetch = (auth?: OpencodeAuth) => {
  const authHeader = resolveAuthHeader(auth);
  const addAuth = (headers: Headers) => {
    if (!authHeader || headers.has("Authorization")) return;
    headers.set("Authorization", authHeader);
  };

  return (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      addAuth(headers);
      const request = new Request(input, { headers });
      return fetchWithTimeout(
        auditedTauriFetch,
        request,
        undefined,
        DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
      );
    }

    const headers = new Headers(init?.headers);
    addAuth(headers);
    return fetchWithTimeout(
      auditedTauriFetch,
      input,
      {
        ...init,
        headers,
      },
      DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
    );
  };
};

export function unwrap<T>(result: FieldsResult<T>): NonNullable<T> {
  if (result.data !== undefined) {
    return result.data as NonNullable<T>;
  }
  const message =
    result.error instanceof Error
      ? result.error.message
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
  throw new Error(message || "Unknown error");
}

export function createClient(baseUrl: string, directory?: string, auth?: OpencodeAuth) {
  const headers: Record<string, string> = {};
  if (!isTauriRuntime()) {
    const authHeader = resolveAuthHeader(auth);
    if (authHeader) {
      headers.Authorization = authHeader;
    }
  }

  const fetchImpl = isTauriRuntime()
    ? createTauriFetch(auth)
    : (input: RequestInfo | URL, init?: RequestInit) =>
        fetchWithTimeout(globalThis.fetch, input, init, DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS);
  return createOpencodeClient({
    baseUrl,
    directory,
    headers: Object.keys(headers).length ? headers : undefined,
    fetch: fetchImpl,
  });
}

function normalizeConfigKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const GATEWAY_PROVIDER_ALLOWED_HEADER_KEYS = new Set([
  VESLO_SESSION_ID_HEADER,
  VESLO_WORKSPACE_ID_HEADER,
].map(normalizeConfigKey));

function isGatewayProviderSecretKey(normalizedKey: string): boolean {
  if (!normalizedKey) return false;
  if (GATEWAY_PROVIDER_ALLOWED_HEADER_KEYS.has(normalizedKey)) return false;
  if (normalizedKey === "authorization") return true;
  if (normalizedKey === "apikey") return true;
  if (normalizedKey === "accesskey") return true;
  if (normalizedKey === "privatekey") return true;
  if (normalizedKey.endsWith("token")) return true;
  if (normalizedKey.endsWith("secret")) return true;
  if (normalizedKey.endsWith("apikey")) return true;
  if (normalizedKey.endsWith("accesskey")) return true;
  if (normalizedKey.endsWith("privatekey")) return true;
  return false;
}

function readConfigObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function summarizeUrlForTrace(value: string | null | undefined): Record<string, unknown> {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return { present: false };
  try {
    const parsed = new URL(trimmed);
    return {
      present: true,
      origin: parsed.origin,
      pathname: parsed.pathname.replace(/\/+$/, "") || "/",
    };
  } catch {
    return {
      present: true,
      invalid: true,
      length: trimmed.length,
    };
  }
}

function headerNamesForTrace(value: unknown): string[] {
  return Object.keys(readConfigObject(value)).sort((a, b) => a.localeCompare(b));
}

function modelNamesForTrace(value: unknown): string[] {
  return Object.keys(readConfigObject(value)).sort((a, b) => a.localeCompare(b));
}

function recordOpencodeConfigTrace(event: string, payload: Record<string, unknown>) {
  recordSendWorkflowTrace("opencode-config", event, payload);
}

function parseConfigContent(content?: string | null): Record<string, unknown> {
  const raw = content?.trim() ?? "";
  if (!raw) return {};

  const parsed = parse(raw);
  return readConfigObject(parsed);
}

function sanitizeGatewayProviderHeaders(value: unknown): Record<string, string> {
  const headers = readConfigObject(value);
  const sanitized: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(headers)) {
    const normalizedKey = normalizeConfigKey(key);
    if (normalizedKey === normalizeConfigKey(VESLO_WORKSPACE_ID_HEADER)) {
      continue;
    }
    if (isGatewayProviderSecretKey(normalizedKey) || normalizedKey === "xveslogatewaytoken") {
      continue;
    }
    if (typeof rawValue !== "string") continue;
    sanitized[key] = rawValue;
  }

  return sanitized;
}

function sanitizeGatewayProviderOptions(value: unknown): Record<string, unknown> {
  const options = readConfigObject(value);
  const sanitized: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(options)) {
    const normalizedKey = normalizeConfigKey(key);
    if (GATEWAY_PROVIDER_SECRET_OPTION_KEYS.has(normalizedKey)) {
      continue;
    }
    if (normalizedKey === "headers") {
      sanitized[key] = sanitizeGatewayProviderHeaders(rawValue);
      continue;
    }
    sanitized[key] = rawValue;
  }

  return sanitized;
}

function sanitizeGatewayProviderModel(value: unknown): {
  config: Record<string, unknown>;
  headers: Record<string, string>;
} {
  const model = readConfigObject(value);
  const sanitized: Record<string, unknown> = {};
  let headers: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(model)) {
    const normalizedKey = normalizeConfigKey(key);
    if (isGatewayProviderSecretKey(normalizedKey)) {
      continue;
    }
    if (normalizedKey === "headers") {
      headers = sanitizeGatewayProviderHeaders(rawValue);
      continue;
    }
    sanitized[key] = rawValue;
  }

  return { config: sanitized, headers };
}

function normalizeConfigForServerPatchComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeConfigForServerPatchComparison(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(input)) {
    const normalizedKey = normalizeConfigKey(key);
    // Desired config no longer contains gateway credentials. If a server read
    // still contains this legacy header, force a scrub patch even when redacted.
    if (normalizedKey === "xveslogatewaytoken") {
      output[key] = SERVER_PATCH_COMPARISON_REDACTED_LITERAL;
      continue;
    }

    if (isGatewayProviderSecretKey(normalizedKey)) {
      const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
      if (trimmed === REDACTED_LITERAL) {
        output[key] = SERVER_PATCH_COMPARISON_REDACTED_LITERAL;
        continue;
      }
      output[key] = trimmed ? SERVER_PATCH_COMPARISON_SECRET_VALUE : rawValue;
      continue;
    }

    output[key] = normalizeConfigForServerPatchComparison(rawValue);
  }

  return output;
}

export function managedConfigContentsMatchForServerPatch(
  currentContent: string | null | undefined,
  desiredContent: string | null | undefined,
): boolean {
  const current = normalizeConfigForServerPatchComparison(parseConfigContent(currentContent));
  const desired = normalizeConfigForServerPatchComparison(parseConfigContent(desiredContent));
  const matches = JSON.stringify(current) === JSON.stringify(desired);
  recordOpencodeConfigTrace("managed-config-compare", {
    matches,
    currentBytes: currentContent?.length ?? 0,
    desiredBytes: desiredContent?.length ?? 0,
  });
  return matches;
}

function mergeProviderEnv(existing: unknown, required: string): string[] {
  const values = Array.isArray(existing)
    ? existing.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean)
    : [];
  if (!values.includes(required)) values.push(required);
  return values;
}

function gatewayServerAuthorizationHeader(): string {
  return `Bearer ${VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE}`;
}

export function applyGatewayProviderRouting(
  content: string | null | undefined,
  input: {
    providerId: GatewayOwnedProviderId;
    serverBaseUrl: string;
    serverClientToken: string;
    gatewayAccessToken?: string | null;
    workspaceId?: string | null;
    models?: string[];
  },
) {
  const providerId = input.providerId.trim().toLowerCase();
  if (!isGatewayOwnedProvider(providerId)) {
    throw new Error(`Gateway routing is not supported for provider: ${input.providerId}`);
  }

  const serverBaseUrl = input.serverBaseUrl.trim().replace(/\/+$/, "");
  if (!serverBaseUrl) {
    throw new Error("Server base URL is required");
  }

  const serverClientToken = input.serverClientToken.trim();
  if (!serverClientToken) {
    throw new Error("Server client token is required");
  }

  const workspaceId = input.workspaceId?.trim() ?? "";

  const parsed = parseConfigContent(content);
  const providerRoot = readConfigObject(parsed.provider);
  const existingProvider = readConfigObject(providerRoot[providerId]);
  const existingOptions = sanitizeGatewayProviderOptions(existingProvider.options);
  const existingHeaders = sanitizeGatewayProviderHeaders(existingOptions.headers);
  const existingModels = readConfigObject(existingProvider.models);
  const isOpenAiCompatibleGatewayProvider = providerId === "codex_oauth" || providerId === "openai_compatible";
  const assignedModels = Array.from(
    new Set((input.models ?? []).map((value) => value.trim()).filter(Boolean)),
  );
  recordOpencodeConfigTrace("apply-gateway-provider-routing:start", {
    providerId,
    workspaceId: workspaceId || null,
    serverBaseUrl: summarizeUrlForTrace(serverBaseUrl),
    modelCount: assignedModels.length,
    models: assignedModels,
    openAiCompatible: isOpenAiCompatibleGatewayProvider,
    hasServerClientToken: Boolean(serverClientToken),
    hasGatewayAccessToken: Boolean(input.gatewayAccessToken?.trim()),
    existingProviderKeys: Object.keys(existingProvider).sort((a, b) => a.localeCompare(b)),
    existingOptionsKeys: Object.keys(existingOptions).sort((a, b) => a.localeCompare(b)),
    existingOptionsBaseUrl: summarizeUrlForTrace(
      typeof existingOptions.baseURL === "string" ? existingOptions.baseURL : null,
    ),
    existingProviderHeaderNames: headerNamesForTrace(existingOptions.headers),
    existingModelNames: modelNamesForTrace(existingModels),
  });
  const routedModels = assignedModels.reduce<Record<string, unknown>>((models, modelId) => {
    const existingModel = sanitizeGatewayProviderModel(existingModels[modelId]);
    const modelConfig: Record<string, unknown> = {
      ...(isOpenAiCompatibleGatewayProvider
        ? {
            name: modelId,
            tool_call: true,
            reasoning: true,
          }
        : {}),
      ...existingModel.config,
      headers: {
        ...existingModel.headers,
        ...(isOpenAiCompatibleGatewayProvider
          ? {}
          : { Authorization: `Bearer ${VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE}` }),
        [VESLO_SESSION_ID_HEADER]: OPENCODE_SESSION_ID_TEMPLATE,
      },
    };
    if (providerId === "codex_oauth") {
      modelConfig.options = {
        ...CODEX_OAUTH_MODEL_OPTIONS,
        ...readConfigObject(existingModel.config.options),
      };
      modelConfig.variants = {
        ...CODEX_OAUTH_MODEL_VARIANTS,
        ...readConfigObject(existingModel.config.variants),
      };
    }
    models[modelId] = modelConfig;
    return models;
  }, {});

  const nextProvider: Record<string, unknown> = {
    ...existingProvider,
    ...(isOpenAiCompatibleGatewayProvider
      ? {
          name: typeof existingProvider.name === "string" && existingProvider.name.trim()
            ? existingProvider.name
            : providerId === "codex_oauth"
              ? "Veslo Codex OAuth"
              : "OpenAI-compatible",
          npm: typeof existingProvider.npm === "string" && existingProvider.npm.trim()
            ? existingProvider.npm
            : "@ai-sdk/openai-compatible",
          env: mergeProviderEnv(existingProvider.env, VESLO_OPENCODE_SERVER_CLIENT_TOKEN_ENV),
        }
      : {}),
    options: {
      ...existingOptions,
      ...(isOpenAiCompatibleGatewayProvider ? { apiKey: VESLO_OPENCODE_SERVER_CLIENT_TOKEN_TEMPLATE } : {}),
      baseURL: `${serverBaseUrl}/ai-gateway/providers/${providerId}/v1`,
      ...(
        isOpenAiCompatibleGatewayProvider
          ? {
              headers: {
                ...existingHeaders,
                Authorization: gatewayServerAuthorizationHeader(),
              },
            }
          : Object.keys(existingHeaders).length > 0
            ? { headers: existingHeaders }
            : {}
      ),
    },
  };

  if (assignedModels.length > 0) {
    nextProvider.models = routedModels;
  }

  parsed.provider = {
    ...providerRoot,
    [providerId]: nextProvider,
  };

  const output = JSON.stringify(parsed, null, 2);
  recordOpencodeConfigTrace("apply-gateway-provider-routing:done", {
    providerId,
    workspaceId: workspaceId || null,
    serverBaseUrl: summarizeUrlForTrace(serverBaseUrl),
    routeBaseUrl: summarizeUrlForTrace(`${serverBaseUrl}/ai-gateway/providers/${providerId}/v1`),
    modelCount: assignedModels.length,
    models: assignedModels,
    modelHeaderNames: Object.fromEntries(
      assignedModels.map((modelId) => [
        modelId,
        headerNamesForTrace(readConfigObject(readConfigObject(routedModels[modelId]).headers)),
      ]),
    ),
    providerOptionKeys: Object.keys(nextProvider.options as Record<string, unknown>).sort((a, b) =>
      a.localeCompare(b)
    ),
    outputBytes: output.length,
  });
  return output;
}

export async function waitForHealthy(
  client: ReturnType<typeof createClient>,
  options?: { timeoutMs?: number; pollMs?: number },
) {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollMs = options?.pollMs ?? 250;
  const maxRequestTimeoutMs = 1_500;

  const start = Date.now();
  let lastError: string | null = null;

  while (Date.now() - start < timeoutMs) {
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - start));
    const requestTimeoutMs = Math.min(maxRequestTimeoutMs, remainingMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const health = unwrap(await client.global.health({ signal: controller.signal }));
      if (health.healthy) {
        return health;
      }
      lastError = "Server reported unhealthy";
    } catch (error) {
      lastError = controller.signal.aborted
        ? "OpenCode health request timed out"
        : error instanceof Error
          ? error.message
          : "Unknown error";
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(lastError ?? "Timed out waiting for server health");
}
