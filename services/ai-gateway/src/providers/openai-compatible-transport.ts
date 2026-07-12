import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  headersToRecord,
  ProviderTransportError,
  type OpenAiCompatibleModelsTransportInput,
  type OpenAiCompatibleModelsTransportResponse,
  type OpenAiCompatibleProviderTransport,
  type OpenAiCompatibleTransportInput,
  type ProviderTransportResponse,
} from "./transport.js";

type OpenAiCompatibleTransportDependencies = {
  fetchImpl?: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxModelResponseBytes?: number;
};

const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_MODEL_RESPONSE_BYTES = 1024 * 1024;

export class OpenAiCompatibleTransport implements OpenAiCompatibleProviderTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly resolveHostname: (hostname: string) => Promise<string[]>;
  private readonly timeoutMs: number;
  private readonly maxModelResponseBytes: number;

  constructor(input: typeof fetch | OpenAiCompatibleTransportDependencies = {}) {
    const deps = typeof input === "function" ? { fetchImpl: input } : input;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.resolveHostname = deps.resolveHostname ?? resolveHostname;
    this.timeoutMs = normalizePositiveInteger(deps.timeoutMs, DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS);
    this.maxModelResponseBytes = normalizePositiveInteger(
      deps.maxModelResponseBytes,
      DEFAULT_MODEL_RESPONSE_BYTES,
    );
  }

  async chatCompletions(input: OpenAiCompatibleTransportInput): Promise<ProviderTransportResponse> {
    const baseUrl = input.baseUrl.replace(/\/+$/, "");
    const response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: openAiCompatibleHeaders(input.apiKey, true),
      body: JSON.stringify(input.body),
    }).catch((error: unknown) => {
      throw requestFailedError(error);
    });

    const body = await readOpenAiCompatibleResponseBody(response);
    const headers = headersToRecord(response.headers);
    if (!response.ok) {
      throw new ProviderTransportError(`openai_compatible_upstream_${response.status}`, {
        statusCode: response.status,
        body,
        headers,
      });
    }

    return { status: response.status, body, headers };
  }

  async listModels(input: OpenAiCompatibleModelsTransportInput): Promise<OpenAiCompatibleModelsTransportResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    try {
      const baseUrl = await validateModelDiscoveryBaseUrl(
        input.baseUrl,
        this.resolveHostname,
        controller.signal,
      );
      let response: Response;
      try {
        response = await this.fetchImpl(`${baseUrl}/models`, {
          method: "GET",
          headers: openAiCompatibleHeaders(input.apiKey, false),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw modelDiscoveryTimeoutError();
        }
        throw requestFailedError(error);
      }

      if (response.status >= 300 && response.status < 400) {
        throw new ProviderTransportError("openai_compatible_models_redirect_blocked", {
          statusCode: 502,
          code: "openai_compatible_models_redirect_blocked",
        });
      }

      const body = await readBoundedOpenAiCompatibleResponseBody(
        response,
        this.maxModelResponseBytes,
        controller.signal,
      );
      const headers = headersToRecord(response.headers);
      if (!response.ok) {
        throw new ProviderTransportError(`openai_compatible_models_upstream_${response.status}`, {
          statusCode: response.status,
          body,
          headers,
        });
      }

      return {
        models: readModelIds(body),
      };
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ProviderTransportError)) {
        throw modelDiscoveryTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function resolveHostname(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function validateModelDiscoveryBaseUrl(
  input: string,
  resolver: (hostname: string) => Promise<string[]>,
  signal: AbortSignal,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw modelDiscoveryTargetError();
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw modelDiscoveryTargetError();
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isExplicitLoopback(hostname)) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw modelDiscoveryTargetError();
    }
    return input.replace(/\/+$/, "");
  }
  if (parsed.protocol !== "https:" || isIP(hostname) !== 0) {
    throw modelDiscoveryTargetError();
  }

  let addresses: string[];
  try {
    addresses = await abortable(resolver(hostname), signal);
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw modelDiscoveryTimeoutError();
    throw new ProviderTransportError("openai_compatible_models_dns_failed", {
      statusCode: 503,
      code: "openai_compatible_models_dns_failed",
    });
  }
  if (addresses.length === 0) {
    throw new ProviderTransportError("openai_compatible_models_dns_failed", {
      statusCode: 503,
      code: "openai_compatible_models_dns_failed",
    });
  }
  if (addresses.some((address) => !isPublicAddress(address))) {
    throw modelDiscoveryTargetError();
  }
  return input.replace(/\/+$/, "");
}

function modelDiscoveryTargetError(): ProviderTransportError {
  return new ProviderTransportError("openai_compatible_models_target_not_allowed", {
    statusCode: 400,
    code: "openai_compatible_models_target_not_allowed",
  });
}

function modelDiscoveryTimeoutError(): ProviderTransportError {
  return new ProviderTransportError("openai_compatible_models_timeout", {
    statusCode: 504,
    code: "openai_compatible_models_timeout",
  });
}

function isExplicitLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPublicIpv4(normalized.slice("::ffff:".length));
  }
  return !(
    normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:")
  );
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw modelDiscoveryTimeoutError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(modelDiscoveryTimeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function openAiCompatibleHeaders(apiKey: string, includeContentType: boolean): Record<string, string> {
  return {
    ...(includeContentType ? { "content-type": "application/json" } : {}),
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
  };
}

function requestFailedError(error: unknown): ProviderTransportError {
  const message = error instanceof Error && error.message ? error.message : "fetch failed";
  return new ProviderTransportError(`openai_compatible_request_failed: ${message}`, {
    statusCode: 502,
    code: "openai_compatible_request_failed",
  });
}

async function readOpenAiCompatibleResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

async function readBoundedOpenAiCompatibleResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw modelDiscoveryResponseTooLargeError();
  }

  const reader = response.body?.getReader();
  if (!reader) return parseOpenAiCompatibleResponseText(response, "");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await abortable(reader.read(), signal);
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw modelDiscoveryResponseTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseOpenAiCompatibleResponseText(response, new TextDecoder().decode(bytes));
}

function parseOpenAiCompatibleResponseText(response: Response, text: string): unknown {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function modelDiscoveryResponseTooLargeError(): ProviderTransportError {
  return new ProviderTransportError("openai_compatible_models_response_too_large", {
    statusCode: 502,
    code: "openai_compatible_models_response_too_large",
  });
}

function readModelIds(body: unknown): string[] {
  const record = getRecord(body);
  const values: unknown[] = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(record?.models)
      ? record.models
      : Array.isArray(body)
        ? body
        : [];
  const seen = new Set<string>();
  const models: string[] = [];

  for (const value of values) {
    const id = readModelId(value);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    models.push(id);
  }

  return models;
}

function readModelId(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  const record = getRecord(value);
  const id = record?.id;
  return typeof id === "string" ? id.trim() : "";
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
