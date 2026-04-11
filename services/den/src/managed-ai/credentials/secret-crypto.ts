import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes } from "node:crypto"

import type { StoredSecret } from "./secret-store.js"

export type EncryptedSecretEnvelope = {
  iv: string
  authTag: string
  ciphertext: string
}

export function createSecretEncryptionKey(secretKey: string) {
  return createSecretKey(new Uint8Array(createHash("sha256").update(secretKey).digest()))
}

export function encryptStoredSecret(
  key: ReturnType<typeof createSecretEncryptionKey>,
  secret: StoredSecret,
): EncryptedSecretEnvelope {
  const iv = new Uint8Array(randomBytes(12))
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const plaintext = JSON.stringify(secret)
  const ciphertext = Buffer.concat([
    new Uint8Array(cipher.update(plaintext, "utf8")),
    new Uint8Array(cipher.final()),
  ])
  const authTag = new Uint8Array(cipher.getAuthTag())

  return {
    iv: Buffer.from(iv).toString("base64"),
    authTag: Buffer.from(authTag).toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }
}

export function decryptStoredSecret(
  key: ReturnType<typeof createSecretEncryptionKey>,
  encrypted: EncryptedSecretEnvelope,
): StoredSecret {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    new Uint8Array(Buffer.from(encrypted.iv, "base64")),
  )
  decipher.setAuthTag(new Uint8Array(Buffer.from(encrypted.authTag, "base64")))

  const plaintext = Buffer.concat([
    new Uint8Array(decipher.update(new Uint8Array(Buffer.from(encrypted.ciphertext, "base64")))),
    new Uint8Array(decipher.final()),
  ]).toString("utf8")

  return JSON.parse(plaintext) as StoredSecret
}
