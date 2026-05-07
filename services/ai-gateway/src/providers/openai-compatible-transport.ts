import {
  headersToRecord,
  ProviderTransportError,
  type OpenAiCompatibleModelsTransportInput,
  type OpenAiCompatibleModelsTransportResponse,
  type OpenAiCompatibleProviderTransport,
  type OpenAiCompatibleTransportInput,
  type ProviderTransportResponse,
} from "./transport.js";

export class OpenAiCompatibleTransport implements OpenAiCompatibleProviderTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

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
    const baseUrl = input.baseUrl.replace(/\/+$/, "");
    const response = await this.fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      headers: openAiCompatibleHeaders(input.apiKey, false),
    }).catch((error: unknown) => {
      throw requestFailedError(error);
    });

    const body = await readOpenAiCompatibleResponseBody(response);
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
  }
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
