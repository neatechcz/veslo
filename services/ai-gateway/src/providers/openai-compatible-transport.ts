import {
  headersToRecord,
  ProviderTransportError,
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
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify(input.body),
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
