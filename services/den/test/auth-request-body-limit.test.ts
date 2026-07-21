import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import test from "node:test"

const requiredEnv = {
  DATABASE_URL: "mysql://root:root@localhost:3306/den",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:8788",
  DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "false",
}

test("declared oversized auth bodies return 413 immediately while safely draining the partial request", async () => {
  for (const [key, value] of Object.entries(requiredEnv)) process.env[key] = value

  try {
    const { AUTH_REQUEST_BODY_LIMIT_BYTES, createAuthNodeHandler } = await import(
      `../src/auth.js?body-limit=${Date.now()}-${Math.random()}`
    )
    const request = new PassThrough() as PassThrough & {
      method: string
      url: string
      originalUrl: string
      headers: Record<string, string>
    }
    request.method = "POST"
    request.url = "/api/auth/sign-up/email"
    request.originalUrl = request.url
    request.headers = {
      "content-type": "application/json",
      "content-length": String(AUTH_REQUEST_BODY_LIMIT_BYTES + 1),
    }

    let resumed = false
    const resume = request.resume.bind(request)
    request.resume = () => {
      resumed = true
      return resume()
    }
    request.write('{"email":"partial@example.test",')

    let baseHandlerCalls = 0
    let guardCalls = 0
    const response = new FakeResponse()
    const handler = createAuthNodeHandler(
      async () => {
        baseHandlerCalls += 1
      },
      async () => {
        guardCalls += 1
        return { ok: true as const }
      },
    )

    await Promise.race([
      handler(request as never, response as never),
      new Promise((_, reject) => setTimeout(() => reject(new Error("413 waited for the declared body")), 100)),
    ])

    assert.equal(response.statusCode, 413)
    assert.deepEqual(JSON.parse(response.body), {
      code: "AUTH_REQUEST_TOO_LARGE",
      message: "Authentication request body is too large.",
    })
    assert.equal(resumed, true, "the unread partial request must enter flowing drain mode")
    assert.equal(baseHandlerCalls, 0, "Better Auth must not run for a declared oversized body")
    assert.equal(guardCalls, 0, "the signup guard and its database work must not run")
    assert.doesNotThrow(
      () => request.emit("error", new Error("client disconnected while the rejected body was draining")),
      "a late drain error must not become an unhandled stream error",
    )
    request.destroy()
  } finally {
    for (const key of Object.keys(requiredEnv)) delete process.env[key]
  }
})

class FakeResponse {
  statusCode = 200
  body = ""
  readonly headers = new Map<string, string>()

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value)
  }

  end(body = "") {
    this.body = String(body)
  }
}
