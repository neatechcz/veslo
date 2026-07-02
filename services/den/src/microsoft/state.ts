import crypto from "node:crypto"

import type { MicrosoftConnectorId } from "./connectors.js"
import { isMicrosoftConnectorId } from "./connectors.js"

export type MicrosoftOAuthStatePayload = {
  v: 1
  nonce: string
  orgId: string
  userId: string
  connectorId: MicrosoftConnectorId
  redirectUri: string
  issuedAt: number
  expiresAt: number
}

export type MicrosoftRuntimeTokenPayload = {
  v: 1
  kind: "microsoft-runtime"
  nonce: string
  orgId: string
  userId: string
  connectorId: MicrosoftConnectorId
  issuedAt: number
  expiresAt: number
}

export type CreateMicrosoftOAuthStateInput = {
  orgId: string
  userId: string
  connectorId: MicrosoftConnectorId
  redirectUri: string
  secret: string
  now?: () => number
  randomUUID?: () => string
}

export function createSignedMicrosoftOAuthState(input: CreateMicrosoftOAuthStateInput) {
  const now = input.now?.() ?? Date.now()
  const payload: MicrosoftOAuthStatePayload = {
    v: 1,
    nonce: input.randomUUID?.() ?? crypto.randomUUID(),
    orgId: input.orgId,
    userId: input.userId,
    connectorId: input.connectorId,
    redirectUri: input.redirectUri,
    issuedAt: now,
    expiresAt: now + 15 * 60 * 1000,
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const signature = signState(encoded, input.secret)
  return `${encoded}.${signature}`
}

export function verifySignedMicrosoftOAuthState(
  state: string,
  input: {
    secret: string
    now?: () => number
  },
): MicrosoftOAuthStatePayload | null {
  const parts = state.split(".")
  if (parts.length !== 2) {
    return null
  }

  const [encoded, signature] = parts
  if (!encoded || !signature) {
    return null
  }

  const expected = signState(encoded, input.secret)
  const signatureBuffer = new Uint8Array(Buffer.from(signature))
  const expectedBuffer = new Uint8Array(Buffer.from(expected))
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>
    const now = input.now?.() ?? Date.now()
    if (
      parsed.v !== 1 ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.orgId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.connectorId !== "string" ||
      !isMicrosoftConnectorId(parsed.connectorId) ||
      typeof parsed.redirectUri !== "string" ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= now
    ) {
      return null
    }

    return {
      v: 1,
      nonce: parsed.nonce,
      orgId: parsed.orgId,
      userId: parsed.userId,
      connectorId: parsed.connectorId,
      redirectUri: parsed.redirectUri,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    }
  } catch {
    return null
  }
}

export function createSignedMicrosoftRuntimeToken(input: {
  orgId: string
  userId: string
  connectorId: MicrosoftConnectorId
  secret: string
  ttlMs?: number
  now?: () => number
  randomUUID?: () => string
}) {
  const now = input.now?.() ?? Date.now()
  const payload: MicrosoftRuntimeTokenPayload = {
    v: 1,
    kind: "microsoft-runtime",
    nonce: input.randomUUID?.() ?? crypto.randomUUID(),
    orgId: input.orgId,
    userId: input.userId,
    connectorId: input.connectorId,
    issuedAt: now,
    expiresAt: now + (input.ttlMs ?? 30 * 24 * 60 * 60 * 1000),
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  const signature = signState(encoded, input.secret)
  return `${encoded}.${signature}`
}

export function verifySignedMicrosoftRuntimeToken(
  token: string,
  input: {
    secret: string
    now?: () => number
  },
): MicrosoftRuntimeTokenPayload | null {
  const parts = token.split(".")
  if (parts.length !== 2) {
    return null
  }

  const [encoded, signature] = parts
  if (!encoded || !signature) {
    return null
  }

  const expected = signState(encoded, input.secret)
  const signatureBuffer = new Uint8Array(Buffer.from(signature))
  const expectedBuffer = new Uint8Array(Buffer.from(expected))
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>
    const now = input.now?.() ?? Date.now()
    if (
      parsed.v !== 1 ||
      parsed.kind !== "microsoft-runtime" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.orgId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.connectorId !== "string" ||
      !isMicrosoftConnectorId(parsed.connectorId) ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= now
    ) {
      return null
    }

    return {
      v: 1,
      kind: "microsoft-runtime",
      nonce: parsed.nonce,
      orgId: parsed.orgId,
      userId: parsed.userId,
      connectorId: parsed.connectorId,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    }
  } catch {
    return null
  }
}

function signState(encodedPayload: string, secret: string) {
  return crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url")
}
