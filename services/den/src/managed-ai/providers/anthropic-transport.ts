import type { UpstreamAuth } from "../credentials/token-broker.js"
import {
  headersToRecord,
  ProviderTransportError,
  readProviderResponseBody,
  type AnthropicProviderTransport,
  type MessagesTransportInput,
  type ProviderTransportResponse,
} from "./transport.js"

export type AnthropicTransportDeps = {
  baseUrl?: string
  fetchImpl?: typeof fetch
  apiVersion?: string
}

export class AnthropicTransport implements AnthropicProviderTransport {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly apiVersion: string

  constructor(deps: AnthropicTransportDeps = {}) {
    this.baseUrl = (deps.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.apiVersion = deps.apiVersion ?? "2023-06-01"
  }

  async messages(input: MessagesTransportInput): Promise<ProviderTransportResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": this.apiVersion,
        ...createAnthropicAuthHeaders(input.upstreamAuth),
      },
      body: JSON.stringify(input.body),
    })

    return parseAnthropicResponse(response)
  }
}

function createAnthropicAuthHeaders(upstreamAuth: UpstreamAuth): Record<string, string> {
  if (upstreamAuth.kind === "api-key") {
    return {
      "x-api-key": upstreamAuth.value,
    }
  }

  return {
    authorization: `Bearer ${upstreamAuth.value}`,
  }
}

async function parseAnthropicResponse(response: Response): Promise<ProviderTransportResponse> {
  const body = await readProviderResponseBody(response)
  const headers = headersToRecord(response.headers)

  if (!response.ok) {
    throw new ProviderTransportError(
      getAnthropicErrorMessage(body) ?? `anthropic_upstream_${response.status}`,
      {
        statusCode: response.status,
        code: getAnthropicErrorCode(body, response.status),
        body,
        headers,
      },
    )
  }

  return {
    status: response.status,
    body,
    headers,
  }
}

function getAnthropicErrorCode(body: unknown, statusCode: number): string | undefined {
  const providerError = getNestedRecord(body, "error")
  const errorType = providerError?.type
  if (typeof errorType !== "string") {
    return undefined
  }

  if (errorType === "authentication_error" && (statusCode === 401 || statusCode === 403)) {
    return "invalid_api_key"
  }

  if (errorType === "permission_error" && statusCode === 403) {
    return "insufficient_quota"
  }

  return errorType
}

function getAnthropicErrorMessage(body: unknown): string | undefined {
  const providerError = getNestedRecord(body, "error")
  const message = providerError?.message
  return typeof message === "string" ? message : undefined
}

function getNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const nested = (value as Record<string, unknown>)[key]
  if (!nested || typeof nested !== "object") {
    return null
  }

  return nested as Record<string, unknown>
}
