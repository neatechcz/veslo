import type { UpstreamAuth } from "../credentials/token-broker.js"

export type ChatCompletionsTransportInput = {
  upstreamAuth: UpstreamAuth
  body: unknown
}

export type MessagesTransportInput = {
  upstreamAuth: UpstreamAuth
  body: unknown
}

export type CodexChatCompletionsTransportInput = {
  body: unknown
}

export type ProviderTransportResponse = {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export type ProviderTransportErrorOptions = {
  statusCode?: number
  code?: string
  body?: unknown
  headers?: Record<string, string>
}

export class ProviderTransportError extends Error {
  readonly statusCode?: number
  readonly code?: string
  readonly body?: unknown
  readonly headers?: Record<string, string>

  constructor(message: string, options: ProviderTransportErrorOptions = {}) {
    super(message)
    this.name = "ProviderTransportError"
    this.statusCode = options.statusCode
    this.code = options.code
    this.body = options.body
    this.headers = options.headers
  }
}

export interface OpenAiProviderTransport {
  chatCompletions(input: ChatCompletionsTransportInput): Promise<ProviderTransportResponse>
}

export interface AnthropicProviderTransport {
  messages(input: MessagesTransportInput): Promise<ProviderTransportResponse>
}

export interface CodexOAuthProviderTransport {
  chatCompletions(input: CodexChatCompletionsTransportInput): Promise<ProviderTransportResponse>
}

export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

export async function readProviderResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) {
    return response.json()
  }

  return response.text()
}
