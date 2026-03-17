import assert from "node:assert/strict"
import test from "node:test"
import {
  createHandoffCode,
  consumeHandoffCode,
  createPkceS256Challenge,
  hashState,
  isValidRedirectUri,
  type HandoffRecord,
} from "../src/http/desktop-auth-helpers.js"

function makeHandoff(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    id: "hoff-1",
    code: "test-code-abc123",
    sessionId: null,
    userId: "user-1",
    orgId: "org-1",
    expiresAt: new Date(Date.now() + 5 * 60_000),
    consumedAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

test("desktop auth handoff - createHandoffCode produces a record with code, userId, orgId", () => {
  const record = createHandoffCode("user-1", "org-1")
  assert.ok(record.id, "should have an id")
  assert.ok(record.code, "should have a code")
  assert.equal(record.sessionId, null)
  assert.equal(record.userId, "user-1")
  assert.equal(record.orgId, "org-1")
  assert.ok(record.expiresAt > new Date(), "should expire in the future")
  assert.equal(record.consumedAt, null)
})

test("desktop auth handoff - createHandoffCode stores sessionId when provided", () => {
  const record = createHandoffCode("user-1", "org-1", "das_123")
  assert.equal(record.sessionId, "das_123")
})

test("desktop auth handoff - consumeHandoffCode succeeds for a valid record", () => {
  const record = makeHandoff()
  const result = consumeHandoffCode(record)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.record.userId, "user-1")
  assert.equal(result.record.orgId, "org-1")
  assert.ok(result.record.consumedAt, "should be marked consumed")
})

test("desktop auth handoff - consumeHandoffCode rejects expired codes", () => {
  const record = makeHandoff({
    expiresAt: new Date(Date.now() - 1000),
  })
  const result = consumeHandoffCode(record)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, "code_expired")
})

test("desktop auth handoff - consumeHandoffCode rejects already-consumed codes", () => {
  const record = makeHandoff({
    consumedAt: new Date(),
  })
  const result = consumeHandoffCode(record)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error, "code_already_consumed")
})

test("desktop auth handoff - hashState is deterministic and non-empty", () => {
  const first = hashState("state-value")
  const second = hashState("state-value")
  assert.equal(first, second)
  assert.ok(first.length > 20)
})

test("desktop auth handoff - createPkceS256Challenge returns base64url digest", () => {
  const challenge = createPkceS256Challenge("verifier-value")
  assert.ok(/^[A-Za-z0-9_-]+$/.test(challenge))
  assert.ok(challenge.length > 20)
})

test("desktop auth handoff - redirect URI validator allows veslo/http/https only", () => {
  assert.equal(isValidRedirectUri("veslo://auth-complete"), true)
  assert.equal(isValidRedirectUri("https://example.com/auth-complete"), true)
  assert.equal(isValidRedirectUri("http://localhost:3000/callback"), true)
  assert.equal(isValidRedirectUri("javascript:alert(1)"), false)
})
