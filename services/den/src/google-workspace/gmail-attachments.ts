const DEFAULT_GMAIL_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1"

export type GoogleGmailAttachmentDownload = {
  bytes: Uint8Array
  size: number
}

export class GoogleGmailAttachmentError extends Error {
  readonly code: string
  readonly status: number
  readonly maxBytes: number | null

  constructor(input: {
    code: string
    status: number
    maxBytes?: number | null
  }) {
    super(input.code)
    this.name = "GoogleGmailAttachmentError"
    this.code = input.code
    this.status = input.status
    this.maxBytes = input.maxBytes ?? null
  }
}

export async function downloadGmailAttachment(input: {
  accessToken: string
  messageId: string
  attachmentId: string
  fetchImpl?: typeof fetch
  maxBytes?: number
  baseUrl?: string
}): Promise<GoogleGmailAttachmentDownload> {
  const maxBytes = input.maxBytes ?? DEFAULT_GMAIL_ATTACHMENT_MAX_BYTES
  const baseUrl = (input.baseUrl?.trim() || DEFAULT_GMAIL_API_BASE_URL).replace(/\/+$/, "")
  const url = `${baseUrl}/users/me/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`

  let response: Response
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.accessToken}`,
      },
    })
  } catch {
    throw new GoogleGmailAttachmentError({
      code: "google_gmail_unavailable",
      status: 503,
    })
  }

  if (!response.ok) {
    throw googleGmailResponseError(response.status)
  }

  const payload = await response.json().catch(() => null) as {
    size?: unknown
    data?: unknown
  } | null
  if (
    !payload ||
    !Number.isInteger(payload.size) ||
    (payload.size as number) < 0 ||
    typeof payload.data !== "string"
  ) {
    throw invalidAttachmentResponse()
  }

  const declaredSize = payload.size as number
  if (declaredSize > maxBytes) {
    throw attachmentTooLarge(maxBytes)
  }

  const compactData = payload.data.replace(/=+$/, "")
  if (
    !/^[A-Za-z0-9_-]*={0,2}$/.test(payload.data) ||
    compactData.length % 4 === 1
  ) {
    throw invalidAttachmentResponse()
  }

  const bytes = Buffer.from(compactData, "base64url")
  if (bytes.toString("base64url") !== compactData) {
    throw invalidAttachmentResponse()
  }
  if (bytes.byteLength > maxBytes) {
    throw attachmentTooLarge(maxBytes)
  }
  if (bytes.byteLength !== declaredSize) {
    throw invalidAttachmentResponse()
  }

  return {
    bytes: new Uint8Array(bytes),
    size: bytes.byteLength,
  }
}

function googleGmailResponseError(status: number) {
  if (status === 401) {
    return new GoogleGmailAttachmentError({ code: "google_gmail_unauthorized", status })
  }
  if (status === 403) {
    return new GoogleGmailAttachmentError({ code: "google_gmail_insufficient_permission", status })
  }
  if (status === 404) {
    return new GoogleGmailAttachmentError({ code: "google_gmail_attachment_not_found", status })
  }
  if (status === 429) {
    return new GoogleGmailAttachmentError({ code: "google_gmail_rate_limited", status })
  }
  if (status >= 500) {
    return new GoogleGmailAttachmentError({ code: "google_gmail_unavailable", status })
  }
  return new GoogleGmailAttachmentError({ code: "google_gmail_request_failed", status })
}

function invalidAttachmentResponse() {
  return new GoogleGmailAttachmentError({
    code: "google_gmail_attachment_invalid_response",
    status: 502,
  })
}

function attachmentTooLarge(maxBytes: number) {
  return new GoogleGmailAttachmentError({
    code: "google_gmail_attachment_too_large",
    status: 413,
    maxBytes,
  })
}
