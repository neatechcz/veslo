import type { UpstreamAuth } from "../credentials/token-broker.js"
import {
  headersToRecord,
  ProviderTransportError,
  readProviderResponseBody,
  type ChatCompletionsTransportInput,
  type OpenAiProviderTransport,
  type ProviderTransportResponse,
} from "./transport.js"

export type OpenAiTransportDeps = {
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export class OpenAiTransport implements OpenAiProviderTransport {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(deps: OpenAiTransportDeps = {}) {
    this.baseUrl = (deps.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "")
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  async chatCompletions(input: ChatCompletionsTransportInput): Promise<ProviderTransportResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createOpenAiAuthHeaders(input.upstreamAuth),
      },
      body: JSON.stringify(input.body),
    })

    return parseOpenAiResponse(response)
  }
}

function createOpenAiAuthHeaders(upstreamAuth: UpstreamAuth): Record<string, string> {
  return {
    authorization: `Bearer ${upstreamAuth.value}`,
  }
}

async function parseOpenAiResponse(response: Response): Promise<ProviderTransportResponse> {
  const body = await readProviderResponseBody(response)
  const headers = headersToRecord(response.headers)

  if (!response.ok) {
    throw new ProviderTransportError(getOpenAiErrorMessage(body) ?? `openai_upstream_${response.status}`, {
      statusCode: response.status,
      code: getOpenAiErrorCode(body),
      body,
      headers,
    })
  }

  return {
    status: response.status,
    body,
    headers,
  }
}

function getOpenAiErrorCode(body: unknown): string | undefined {
  const providerError = getNestedRecord(body, "error")
  const code = providerError?.code
  return typeof code === "string" ? code : undefined
}

function getOpenAiErrorMessage(body: unknown): string | undefined {
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
