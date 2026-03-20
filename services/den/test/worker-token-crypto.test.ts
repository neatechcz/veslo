import assert from "node:assert/strict"
import test from "node:test"

function setupEnv() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
}

async function loadCrypto() {
  setupEnv()
  return import("../src/security/token-crypto.js")
}

test("worker token crypto - roundtrips encrypted tokens", () => {
  return (async () => {
    const { decryptWorkerToken, encryptWorkerToken } = await loadCrypto()

    const raw = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    const encrypted = encryptWorkerToken(raw)

    assert.notEqual(encrypted, raw)
    assert.ok(encrypted.startsWith("enc:v1:"))
    assert.equal(decryptWorkerToken(encrypted), raw)
  })()
})

test("worker token crypto - keeps backward compatibility for plaintext rows", () => {
  return (async () => {
    const { decryptWorkerToken } = await loadCrypto()
    const legacy = "legacy-plain-token-value"
    assert.equal(decryptWorkerToken(legacy), legacy)
  })()
})
