import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { env } from "../env.js"

export interface DebugLogEncryptedPayload {
  keyVersion: string
  ciphertext: string
  nonce: string
  authTag: string
}

function resolveMasterKey(): Uint8Array {
  const raw = env.debugLogs.masterKey?.trim()
  if (!raw) {
    throw new Error("DEN_LOG_MASTER_KEY is required for debug log crypto")
  }

  const hexLike = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0
  const key = Buffer.from(raw, hexLike ? "hex" : "utf8")
  if (key.length !== 32) {
    throw new Error("DEN_LOG_MASTER_KEY must decode to 32 bytes")
  }
  return Uint8Array.from(key)
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"))
}

export function encryptDebugLogPayload(buffer: Buffer): DebugLogEncryptedPayload {
  const key = resolveMasterKey()
  const nonce = Uint8Array.from(randomBytes(12))
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const ciphertext = new Uint8Array([...cipher.update(Uint8Array.from(buffer)), ...cipher.final()])
  const authTag = Uint8Array.from(cipher.getAuthTag())

  return {
    keyVersion: env.debugLogs.masterKeyVersion,
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    authTag: Buffer.from(authTag).toString("base64"),
  }
}

export function decryptDebugLogPayload(input: DebugLogEncryptedPayload): Buffer {
  const key = resolveMasterKey()
  if (input.keyVersion !== env.debugLogs.masterKeyVersion) {
    throw new Error(`Unsupported debug log key version: ${input.keyVersion}`)
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    decodeBase64(input.nonce),
  )
  decipher.setAuthTag(decodeBase64(input.authTag))
  return Buffer.from(new Uint8Array([...decipher.update(decodeBase64(input.ciphertext)), ...decipher.final()]))
}
