import assert from "node:assert/strict"
import crypto from "node:crypto"
import test from "node:test"

import {
  createSignedGoogleWorkspaceAttachmentToken,
  verifySignedGoogleWorkspaceAttachmentToken,
} from "../src/google-workspace/state.js"

const secret = "google_attachment_secret_0123456789"

test("Google Workspace attachment token binds one Gmail attachment and expires after five minutes", () => {
  const token = createSignedGoogleWorkspaceAttachmentToken({
    orgId: "org_1",
    userId: "user_1",
    messageId: "message_1",
    attachmentId: "attachment_1",
    filename: "archive.zip",
    mimeType: "application/zip",
    secret,
    now: () => 1_000,
    randomUUID: () => "nonce_1",
  })

  assert.deepEqual(verifySignedGoogleWorkspaceAttachmentToken(token, {
    secret,
    now: () => 1_001,
  }), {
    v: 1,
    kind: "google-gmail-attachment",
    nonce: "nonce_1",
    orgId: "org_1",
    userId: "user_1",
    connectorId: "google-gmail",
    messageId: "message_1",
    attachmentId: "attachment_1",
    filename: "archive.zip",
    mimeType: "application/zip",
    issuedAt: 1_000,
    expiresAt: 301_000,
  })
})

test("Google Workspace attachment token rejects tampering, trailing segments, and exact expiry", () => {
  const token = createSignedGoogleWorkspaceAttachmentToken({
    orgId: "org_1",
    userId: "user_1",
    messageId: "message_1",
    attachmentId: "attachment_1",
    filename: "archive.zip",
    mimeType: "application/zip",
    secret,
    now: () => 1_000,
    randomUUID: () => "nonce_1",
  })

  assert.equal(verifySignedGoogleWorkspaceAttachmentToken(`${token}tampered`, {
    secret,
    now: () => 1_001,
  }), null)
  assert.equal(verifySignedGoogleWorkspaceAttachmentToken(`${token}.extra`, {
    secret,
    now: () => 1_001,
  }), null)
  assert.equal(verifySignedGoogleWorkspaceAttachmentToken(token, {
    secret,
    now: () => 301_000,
  }), null)
})

test("Google Workspace attachment token rejects blank attachment identity fields", () => {
  const token = createSignedGoogleWorkspaceAttachmentToken({
    orgId: "org_1",
    userId: "user_1",
    messageId: " ",
    attachmentId: "attachment_1",
    filename: "archive.zip",
    mimeType: "application/zip",
    secret,
    now: () => 1_000,
    randomUUID: () => "nonce_1",
  })

  assert.equal(verifySignedGoogleWorkspaceAttachmentToken(token, {
    secret,
    now: () => 1_001,
  }), null)
})

test("Google Workspace attachment token rejects a non-Gmail connector payload", () => {
  const encoded = Buffer.from(JSON.stringify({
    v: 1,
    kind: "google-gmail-attachment",
    nonce: "nonce_1",
    orgId: "org_1",
    userId: "user_1",
    connectorId: "google-drive",
    messageId: "message_1",
    attachmentId: "attachment_1",
    filename: "archive.zip",
    mimeType: "application/zip",
    issuedAt: 1_000,
    expiresAt: 301_000,
  }), "utf8").toString("base64url")
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url")

  assert.equal(verifySignedGoogleWorkspaceAttachmentToken(`${encoded}.${signature}`, {
    secret,
    now: () => 1_001,
  }), null)
})
