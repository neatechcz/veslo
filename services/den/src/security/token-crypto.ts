import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto"
import { env } from "../env.js"

const TOKEN_PREFIX = "enc:v1:"
const IV_SIZE = 12
const TAG_SIZE = 16

function toBytes(value: Uint8Array | Buffer) {
  return Uint8Array.from(value)
}

function concatBytes(chunks: Uint8Array[]) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

function deriveEncryptionKey() {
  const material = env.workerTokenEncryptionKey ?? env.betterAuthSecret
  return toBytes(createHash("sha256").update(material).digest())
}

export function encryptWorkerToken(value: string) {
  if (!value) {
    return value
  }

  const iv = toBytes(randomBytes(IV_SIZE))
  const cipher = createCipheriv("aes-256-gcm", deriveEncryptionKey(), iv)
  const encrypted = concatBytes([toBytes(cipher.update(value, "utf8")), toBytes(cipher.final())])
  const tag = toBytes(cipher.getAuthTag())
  const payload = Buffer.from(concatBytes([iv, tag, encrypted])).toString("base64url")
  return `${TOKEN_PREFIX}${payload}`
}

export function decryptWorkerToken(value: string) {
  if (!value.startsWith(TOKEN_PREFIX)) {
    return value
  }

  const payload = toBytes(Buffer.from(value.slice(TOKEN_PREFIX.length), "base64url"))
  if (payload.length <= IV_SIZE + TAG_SIZE) {
    throw new Error("invalid_worker_token_payload")
  }

  const iv = payload.subarray(0, IV_SIZE)
  const tag = payload.subarray(IV_SIZE, IV_SIZE + TAG_SIZE)
  const encrypted = payload.subarray(IV_SIZE + TAG_SIZE)
  const decipher = createDecipheriv("aes-256-gcm", deriveEncryptionKey(), iv)
  decipher.setAuthTag(tag)
  const decrypted = concatBytes([toBytes(decipher.update(encrypted)), toBytes(decipher.final())])
  return Buffer.from(decrypted).toString("utf8")
}
