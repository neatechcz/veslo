import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes } from "node:crypto"

export type DebugLogEncryptionKey = ReturnType<typeof createSecretKey>

export type DebugLogPayloadEnvelope = {
  keyVersion: string
  iv: string
  authTag: string
  ciphertext: string
}

export function createDebugLogEncryptionKey(masterKey: string): DebugLogEncryptionKey {
  return createSecretKey(new Uint8Array(createHash("sha256").update(masterKey).digest()))
}

export function encryptDebugLogPayload(input: {
  key: DebugLogEncryptionKey
  keyVersion: string
  payload: unknown
}): DebugLogPayloadEnvelope {
  const iv = new Uint8Array(randomBytes(12))
  const cipher = createCipheriv("aes-256-gcm", input.key, iv)
  const plaintext = JSON.stringify(input.payload)
  const ciphertext = Buffer.concat([
    new Uint8Array(cipher.update(plaintext, "utf8")),
    new Uint8Array(cipher.final()),
  ])
  const authTag = new Uint8Array(cipher.getAuthTag())

  return {
    keyVersion: input.keyVersion,
    iv: Buffer.from(iv).toString("base64"),
    authTag: Buffer.from(authTag).toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }
}

export function decryptDebugLogPayload(input: {
  key: DebugLogEncryptionKey
  envelope: DebugLogPayloadEnvelope
}): unknown {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    input.key,
    new Uint8Array(Buffer.from(input.envelope.iv, "base64")),
  )
  decipher.setAuthTag(new Uint8Array(Buffer.from(input.envelope.authTag, "base64")))

  const plaintext = Buffer.concat([
    new Uint8Array(decipher.update(new Uint8Array(Buffer.from(input.envelope.ciphertext, "base64")))),
    new Uint8Array(decipher.final()),
  ]).toString("utf8")

  return JSON.parse(plaintext)
}
