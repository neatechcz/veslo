import {
  headersToRecord,
  ProviderTransportError,
  readProviderResponseBody,
  type OpenAiCompatibleProviderTransport,
  type OpenAiCompatibleTransportInput,
  type ProviderTransportResponse,
} from "./transport.js"

export class OpenAiCompatibleTransport implements OpenAiCompatibleProviderTransport {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async chatCompletions(input: OpenAiCompatibleTransportInput): Promise<ProviderTransportResponse> {
    const baseUrl = input.baseUrl.replace(/\/+$/, "")
    const response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(input.body),
    })

    const body = await readProviderResponseBody(response)
    const headers = headersToRecord(response.headers)
    if (!response.ok) {
      throw new ProviderTransportError(`openai_compatible_upstream_${response.status}`, {
        statusCode: response.status,
        body,
        headers,
      })
    }

    return { status: response.status, body, headers }
  }
}
