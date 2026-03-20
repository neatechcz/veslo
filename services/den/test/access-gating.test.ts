import assert from "node:assert/strict"
import test from "node:test"
import { shouldUseEmailCustomerFallback } from "../src/billing/access-gating.js"

test("access gating - requires verified email for email fallback", () => {
  assert.equal(shouldUseEmailCustomerFallback({
    email: "user@example.com",
    emailVerified: true,
  }), true)

  assert.equal(shouldUseEmailCustomerFallback({
    email: "user@example.com",
    emailVerified: false,
  }), false)
})

test("access gating - rejects empty email values", () => {
  assert.equal(shouldUseEmailCustomerFallback({
    email: "   ",
    emailVerified: true,
  }), false)
})
