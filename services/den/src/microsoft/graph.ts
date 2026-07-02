const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"
const DEFAULT_MAX_CONTENT_BYTES = 1_000_000

export type MicrosoftGraphClientOptions = {
  accessToken: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  maxContentBytes?: number
}

export type MicrosoftGraphBytes = {
  bytes: Uint8Array
  contentType: string | null
}

export class MicrosoftGraphError extends Error {
  readonly status: number
  readonly graphCode: string | null
  readonly graphMessage: string | null
  readonly maxContentBytes: number | null

  constructor(input: {
    message: string
    status: number
    graphCode?: string | null
    graphMessage?: string | null
    maxContentBytes?: number | null
  }) {
    super(input.message)
    this.name = "MicrosoftGraphError"
    this.status = input.status
    this.graphCode = input.graphCode ?? null
    this.graphMessage = input.graphMessage ?? null
    this.maxContentBytes = input.maxContentBytes ?? null
  }

  static async fromResponse(response: Response) {
    const payload = await response.json().catch(() => null) as {
      error?: {
        code?: unknown
        message?: unknown
      }
    } | null

    return new MicrosoftGraphError({
      message: graphErrorMessage(response.status),
      status: response.status,
      graphCode: typeof payload?.error?.code === "string" ? payload.error.code : null,
      graphMessage: typeof payload?.error?.message === "string" ? payload.error.message : null,
    })
  }

  static responseTooLarge(maxContentBytes: number) {
    return new MicrosoftGraphError({
      message: "microsoft_graph_response_too_large",
      status: 413,
      maxContentBytes,
    })
  }
}

export class MicrosoftGraphClient {
  private readonly accessToken: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly maxContentBytes: number

  constructor(options: MicrosoftGraphClientOptions) {
    this.accessToken = options.accessToken
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, "")
    this.fetchImpl = options.fetchImpl ?? fetch
    this.maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES
  }

  async getJson<T>(path: string): Promise<T> {
    return this.requestJson<T>(path, { method: "GET" })
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  }

  async getBytes(path: string): Promise<MicrosoftGraphBytes> {
    const response = await this.request(path, { method: "GET" })
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10)
    if (Number.isFinite(contentLength) && contentLength > this.maxContentBytes) {
      throw MicrosoftGraphError.responseTooLarge(this.maxContentBytes)
    }

    const bytes = await readResponseBytes(response, this.maxContentBytes)
    return {
      bytes,
      contentType: response.headers.get("content-type"),
    }
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.request(path, init)
    return response.json() as Promise<T>
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set("accept", headers.get("accept") ?? "application/json")
    headers.set("authorization", `Bearer ${this.accessToken}`)

    const response = await this.fetchImpl(this.resolveUrl(path), {
      ...init,
      headers,
    })
    if (!response.ok) {
      throw await MicrosoftGraphError.fromResponse(response)
    }
    return response
  }

  private resolveUrl(path: string) {
    const normalized = path.replace(/^\/+/, "")
    return new URL(normalized, `${this.baseUrl}/`).toString()
  }
}

async function readResponseBytes(response: Response, maxContentBytes: number) {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxContentBytes) {
      throw MicrosoftGraphError.responseTooLarge(maxContentBytes)
    }
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        break
      }
      total += next.value.byteLength
      if (total > maxContentBytes) {
        throw MicrosoftGraphError.responseTooLarge(maxContentBytes)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function graphErrorMessage(status: number) {
  if (status === 401) {
    return "microsoft_graph_unauthorized"
  }
  if (status === 403) {
    return "microsoft_graph_insufficient_permission"
  }
  if (status === 404) {
    return "microsoft_graph_not_found"
  }
  if (status === 413) {
    return "microsoft_graph_payload_too_large"
  }
  if (status === 429) {
    return "microsoft_graph_rate_limited"
  }
  if (status >= 500) {
    return "microsoft_graph_unavailable"
  }
  return "microsoft_graph_request_failed"
}
