import assert from "node:assert/strict"
import test from "node:test"
import type { Response } from "express"
import { requireVerifiedEmail } from "../src/http/email-verification.js"
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
