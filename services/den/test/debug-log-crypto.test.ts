import assert from "node:assert/strict"
import test from "node:test"

const {
  createDebugLogEncryptionKey,
  decryptDebugLogPayload,
  encryptDebugLogPayload,
} = await import("../src/debug-logs/crypto.js")

test("debug log crypto roundtrips JSON payloads without storing plaintext", () => {
  const key = createDebugLogEncryptionKey("test-master-key")
  const payload = {
    line: "secret prompt text",
    nested: { tool: "shell", exitCode: 0 },
  }

  const encrypted = encryptDebugLogPayload({
    key,
    keyVersion: "v7",
    payload,
  })

  assert.equal(encrypted.keyVersion, "v7")
  assert.notEqual(encrypted.ciphertext, JSON.stringify(payload))
  assert.equal(encrypted.ciphertext.includes("secret prompt text"), false)
  assert.deepEqual(decryptDebugLogPayload({ key, envelope: encrypted }), payload)
})
