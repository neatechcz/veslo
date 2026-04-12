import assert from "node:assert/strict"
import test from "node:test"

function setupEnv() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
  process.env.DEN_LOG_MASTER_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  process.env.DEN_LOG_MASTER_KEY_VERSION ??= "v1"
}

async function loadCrypto() {
  setupEnv()
  return import("../src/security/debug-log-crypto.js")
}

test("debug log crypto roundtrips payloads with key version metadata", () => {
  return (async () => {
    const { encryptDebugLogPayload, decryptDebugLogPayload } = await loadCrypto()
    const encrypted = encryptDebugLogPayload(Buffer.from("{\"text\":\"hello\"}", "utf8"))
    assert.equal(encrypted.keyVersion, "v1")
    assert.notEqual(encrypted.ciphertext, "{\"text\":\"hello\"}")
    const decrypted = decryptDebugLogPayload(encrypted)
    assert.equal(decrypted.toString("utf8"), "{\"text\":\"hello\"}")
  })()
})
