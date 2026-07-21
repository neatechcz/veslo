import assert from "node:assert/strict"
import test from "node:test"
import type { Response } from "express"
import { enforceSessionPolicy, requireVerifiedEmail } from "../src/http/email-verification.js"
import type { SessionContext } from "../src/http/session.js"

function fakeResponse() {
  const res = {
    statusCode: 200,
    jsonBody: null as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(body: unknown) {
      res.jsonBody = body
      return res
    },
  } as Response & {
    statusCode: number
    jsonBody: unknown
  }

  return res
}

test("requireVerifiedEmail returns true for verified sessions", () => {
  const result = requireVerifiedEmail(fakeResponse(), {
    user: { id: "u_1", email: "user@example.com", emailVerified: true, name: "User" },
  } satisfies SessionContext)

  assert.equal(result, true)
})

test("requireVerifiedEmail responds with a stable 403 payload for unverified sessions", () => {
  const res = fakeResponse()
  const result = requireVerifiedEmail(res, {
    user: { id: "u_1", email: "user@example.com", emailVerified: false, name: "User" },
  } satisfies SessionContext)

  assert.equal(result, false)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.jsonBody, {
    error: "email_verification_required",
    message: "Verify your email to continue.",
    email: "user@example.com",
  })
})

test("enforceSessionPolicy allows unverified sessions when verification is disabled", () => {
  const res = fakeResponse()
  const result = enforceSessionPolicy(res, {
    user: { id: "u_1", email: "user@example.com", emailVerified: false, name: "User" },
  } satisfies SessionContext, {
    disabled: false,
    requireEmailVerification: false,
  })

  assert.equal(result, true)
  assert.equal(res.statusCode, 200)
  assert.equal(res.jsonBody, null)
})

test("enforceSessionPolicy rejects unverified sessions with the stable response when verification is enabled", () => {
  const res = fakeResponse()
  const result = enforceSessionPolicy(res, {
    user: { id: "u_1", email: "user@example.com", emailVerified: false, name: "User" },
  } satisfies SessionContext, {
    disabled: false,
    requireEmailVerification: true,
  })

  assert.equal(result, false)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.jsonBody, {
    error: "email_verification_required",
    message: "Verify your email to continue.",
    email: "user@example.com",
  })
})

test("enforceSessionPolicy preserves disabled-user rejection precedence", () => {
  const res = fakeResponse()
  const result = enforceSessionPolicy(res, {
    user: { id: "u_1", email: "user@example.com", emailVerified: false, name: "User" },
  } satisfies SessionContext, {
    disabled: true,
    requireEmailVerification: true,
  })

  assert.equal(result, false)
  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.jsonBody, { error: "user_disabled" })
})
