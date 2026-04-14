import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { parse } from "jsonc-parser";

import { isTauriRuntime } from "../utils";
import { isGatewayOwnedProvider, type GatewayOwnedProviderId } from "../utils/providers";
import { fetchWithTimeout } from "./http";

type FieldsResult<T> =
  | ({ data: T; error?: undefined } & { request: Request; response: Response })
  | ({ data?: undefined; error: unknown } & { request: Request; response: Response });

export type OpencodeAuth = {
  username?: string;
  password?: string;
  token?: string;
  mode?: "basic" | "veslo";
};

const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
const OAUTH_OPENCODE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS = 90_000;
const GATEWAY_PROVIDER_SECRET_OPTION_KEYS = new Set([
  "apikey",
  "apikeyid",
  "accesstoken",
  "refreshtoken",
  "token",
]);
const GATEWAY_PROVIDER_ALLOWED_HEADER_KEYS = new Set([
  "xveslogatewaytoken",
  "xveslosessionid",
]);

export const OPENCODE_SESSION_ID_TEMPLATE = "${OPENCODE_SESSION_ID}";

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
        tauriFetch as unknown as typeof globalThis.fetch,
        request,
        undefined,
        DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
      );
    }

    const headers = new Headers(init?.headers);
    addAuth(headers);
    return fetchWithTimeout(
      tauriFetch as unknown as typeof globalThis.fetch,
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
    if (isGatewayProviderSecretKey(normalizeConfigKey(key))) {
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

export function applyGatewayProviderRouting(
  content: string | null | undefined,
  input: {
    providerId: GatewayOwnedProviderId;
    serverBaseUrl: string;
    gatewayAccessToken: string;
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

  const gatewayAccessToken = input.gatewayAccessToken.trim();
  if (!gatewayAccessToken) {
    throw new Error("Gateway access token is required");
  }

  const parsed = parseConfigContent(content);
  const providerRoot = readConfigObject(parsed.provider);
  const existingProvider = readConfigObject(providerRoot[providerId]);
  const existingOptions = sanitizeGatewayProviderOptions(existingProvider.options);
  const existingHeaders = sanitizeGatewayProviderHeaders(existingOptions.headers);
  const existingModels = readConfigObject(existingProvider.models);
  const assignedModels = Array.from(
    new Set((input.models ?? []).map((value) => value.trim()).filter(Boolean)),
  );

  const codexProviderFields = providerId === "codex_oauth"
    ? {
        name: typeof existingProvider.name === "string" && existingProvider.name.trim()
          ? existingProvider.name
          : "Veslo Codex OAuth",
        npm: typeof existingProvider.npm === "string" && existingProvider.npm.trim()
          ? existingProvider.npm
          : "@ai-sdk/openai-compatible",
        env: Array.isArray(existingProvider.env) ? existingProvider.env : [],
        models: assignedModels.reduce<Record<string, unknown>>(
          (models, modelId) => {
            models[modelId] = readConfigObject(models[modelId]);
            if (!Object.keys(models[modelId] as Record<string, unknown>).length) {
              models[modelId] = {
                name: modelId,
                tool_call: true,
                reasoning: true,
              };
            }
            return models;
          },
          { ...existingModels },
        ),
      }
    : {};

  parsed.provider = {
    ...providerRoot,
    [providerId]: {
      ...existingProvider,
      ...codexProviderFields,
      options: {
        ...existingOptions,
        baseURL: `${serverBaseUrl}/ai-gateway/providers/${providerId}/v1`,
        headers: {
          ...existingHeaders,
          "x-veslo-gateway-token": gatewayAccessToken,
          "x-veslo-session-id": OPENCODE_SESSION_ID_TEMPLATE,
        },
      },
    },
  };

  return JSON.stringify(parsed, null, 2);
}

export async function waitForHealthy(
  client: ReturnType<typeof createClient>,
  options?: { timeoutMs?: number; pollMs?: number },
) {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollMs = options?.pollMs ?? 250;

  const start = Date.now();
  let lastError: string | null = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const health = unwrap(await client.global.health());
      if (health.healthy) {
        return health;
      }
      lastError = "Server reported unhealthy";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(lastError ?? "Timed out waiting for server health");
}
