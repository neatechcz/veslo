import assert from "node:assert/strict"
import test from "node:test"

import {
  downloadGmailAttachment,
  GoogleGmailAttachmentError,
} from "../src/google-workspace/gmail-attachments.js"

test("Gmail attachment client downloads and decodes exact base64url bytes", async () => {
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10])
  const calls: Array<{ url: string; authorization: string | null; accept: string | null }> = []

  const result = await downloadGmailAttachment({
    accessToken: "google_access",
    messageId: "message/1",
    attachmentId: "attachment+1",
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(url),
        authorization: headers.get("authorization"),
        accept: headers.get("accept"),
      })
      return Response.json({
        size: zipBytes.byteLength,
        data: zipBytes.toString("base64url"),
      })
    },
  })

  assert.deepEqual([...result.bytes], [...zipBytes])
  assert.equal(result.size, zipBytes.byteLength)
  assert.deepEqual(calls, [{
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/message%2F1/attachments/attachment%2B1",
    authorization: "Bearer google_access",
    accept: "application/json",
  }])
})

test("Gmail attachment client maps upstream failures to stable errors", async () => {
  const cases = [
    [401, "google_gmail_unauthorized"],
    [403, "google_gmail_insufficient_permission"],
    [404, "google_gmail_attachment_not_found"],
    [429, "google_gmail_rate_limited"],
    [503, "google_gmail_unavailable"],
  ] as const

  for (const [status, code] of cases) {
    await assert.rejects(
      downloadGmailAttachment({
        accessToken: "google_access",
        messageId: "message_1",
        attachmentId: "attachment_1",
        fetchImpl: async () => new Response(JSON.stringify({
          error: { message: "secret upstream details" },
        }), { status, headers: { "content-type": "application/json" } }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof GoogleGmailAttachmentError)
        assert.equal(error.code, code)
        assert.equal(error.status, status)
        assert.doesNotMatch(error.message, /secret upstream details/)
        return true
      },
    )
  }
})

test("Gmail attachment client rejects malformed response data", async () => {
  const payloads = [
    { size: 1 },
    { size: 1, data: "%%%" },
    { size: 2, data: Buffer.from([1]).toString("base64url") },
    { size: -1, data: "" },
  ]

  for (const payload of payloads) {
    await assert.rejects(
      downloadGmailAttachment({
        accessToken: "google_access",
        messageId: "message_1",
        attachmentId: "attachment_1",
        fetchImpl: async () => Response.json(payload),
      }),
      (error: unknown) => {
        assert.ok(error instanceof GoogleGmailAttachmentError)
        assert.equal(error.code, "google_gmail_attachment_invalid_response")
        assert.equal(error.status, 502)
        return true
      },
    )
  }
})

test("Gmail attachment client rejects declared and decoded bodies above the byte limit", async () => {
  for (const payload of [
    { size: 5, data: Buffer.from([1]).toString("base64url") },
    { size: 5, data: Buffer.from([1, 2, 3, 4, 5]).toString("base64url") },
  ]) {
    await assert.rejects(
      downloadGmailAttachment({
        accessToken: "google_access",
        messageId: "message_1",
        attachmentId: "attachment_1",
        maxBytes: 4,
        fetchImpl: async () => Response.json(payload),
      }),
      (error: unknown) => {
        assert.ok(error instanceof GoogleGmailAttachmentError)
        assert.equal(error.code, "google_gmail_attachment_too_large")
        assert.equal(error.status, 413)
        assert.equal(error.maxBytes, 4)
        return true
      },
    )
  }
})
