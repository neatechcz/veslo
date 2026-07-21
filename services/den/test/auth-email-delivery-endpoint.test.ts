import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"

const baseUrl = "https://auth.example.test"
const trustedOrigin = "https://app.example.test"
const email = "delivery-failure@example.test"
const password = "correct-horse-battery-staple"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "endpoint-delivery-test-secret-32-chars",
  BETTER_AUTH_URL: baseUrl,
  CORS_ORIGINS: trustedOrigin,
  LETTR_API_KEY: "lettr_endpoint_test_key",
  AUTH_EMAIL_ADDRESS: "auth@example.test",
  DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "true",
})

const { auth: productionAuth, createAuthNodeHandler } = await import("../src/auth.js")

function createEndpointAuth() {
  return betterAuth({
    baseURL: baseUrl,
    secret: "endpoint-delivery-test-secret-32-chars",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    trustedOrigins: [trustedOrigin],
    plugins: productionAuth.options.plugins,
    disabledPaths: productionAuth.options.disabledPaths,
    emailVerification: productionAuth.options.emailVerification,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
    },
    rateLimit: { enabled: false },
    logger: { disabled: true },
  })
}

function createVerificationCallbackAuth(input: {
  afterEmailVerification(user: { email: string; emailVerified: boolean }): Promise<void>
}) {
  let verificationUrl: string | null = null
  const callbackAuth = betterAuth({
    baseURL: baseUrl,
    secret: "endpoint-callback-test-secret-32-chars",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    trustedOrigins: [trustedOrigin],
    emailVerification: {
      sendOnSignUp: true,
      async sendVerificationEmail({ url }) {
        verificationUrl = url
      },
      afterEmailVerification: input.afterEmailVerification,
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
    },
    rateLimit: { enabled: false },
    logger: { disabled: true },
  })

  return {
    auth: callbackAuth,
    readVerificationUrl() {
      return verificationUrl
    },
  }
}

async function post(auth: ReturnType<typeof createEndpointAuth>, path: string, body: Record<string, unknown>) {
  return auth.handler(new Request(`${baseUrl}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: trustedOrigin,
    },
    body: JSON.stringify(body),
  }))
}

async function assertDeliveryFailure(response: Response) {
  assert.equal(response.status, 502)
  assert.equal(response.headers.get("set-cookie"), null)
  const payload = await response.json() as Record<string, unknown>
  assert.deepEqual(payload, {
    code: "VERIFICATION_EMAIL_DELIVERY_FAILED",
    message: "We could not send the verification email. Please try again.",
  })
  assert.equal("token" in payload, false)
  assert.doesNotMatch(JSON.stringify(payload), /lettr_endpoint_test_key|sensitive provider response/i)
}

test("real auth endpoints never report successful verification delivery after Lettr rejects it", async () => {
  const endpointAuth = createEndpointAuth()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response("sensitive provider response lettr_endpoint_test_key", {
    status: 503,
    statusText: "Service Unavailable",
  })

  try {
    await assertDeliveryFailure(await post(endpointAuth, "/sign-up/email", {
      name: "Delivery Failure",
      email,
      password,
      callbackURL: trustedOrigin,
    }))

    await assertDeliveryFailure(await post(endpointAuth, "/sign-in/email", {
      email,
      password,
      callbackURL: trustedOrigin,
    }))

  } finally {
    globalThis.fetch = originalFetch
  }
})

test("real auth endpoints preserve accepted verification delivery", async () => {
  const endpointAuth = createEndpointAuth()
  const originalFetch = globalThis.fetch
  let deliveries = 0
  globalThis.fetch = async () => {
    deliveries += 1
    return new Response(JSON.stringify({ status: "queued" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  try {
    const successfulSignup = await post(endpointAuth, "/sign-up/email", {
      name: "Accepted Delivery",
      email: "accepted-delivery@example.test",
      password,
      callbackURL: trustedOrigin,
    })
    assert.equal(successfulSignup.status, 200)
    const signupPayload = await successfulSignup.json() as Record<string, unknown>
    assert.equal(signupPayload.token, null)
    assert.equal((signupPayload.user as { email?: string }).email, "accepted-delivery@example.test")
    assert.equal(deliveries, 1)

    const successfulResend = await post(endpointAuth, "/sign-in/email", {
      email: "accepted-delivery@example.test",
      password,
      callbackURL: trustedOrigin,
    })
    assert.equal(successfulResend.status, 403)
    const resendPayload = await successfulResend.json() as Record<string, unknown>
    assert.equal(resendPayload.code, "EMAIL_NOT_VERIFIED")
    assert.equal("token" in resendPayload, false)
    assert.equal(deliveries, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("Better Auth awaits afterEmailVerification with the committed verified user", async () => {
  const callbackUsers: Array<{ email: string; emailVerified: boolean }> = []
  const successful = createVerificationCallbackAuth({
    async afterEmailVerification(user) {
      callbackUsers.push({ email: user.email, emailVerified: user.emailVerified })
    },
  })
  const successfulEmail = "callback-success@example.test"
  const signup = await post(successful.auth, "/sign-up/email", {
    name: "Callback Success",
    email: successfulEmail,
    password,
    callbackURL: trustedOrigin,
  })
  assert.equal(signup.status, 200)
  const verificationUrl = successful.readVerificationUrl()
  assert.ok(verificationUrl)
  const verification = await successful.auth.handler(new Request(verificationUrl))
  assert.ok(verification.status === 200 || verification.status === 302)
  assert.deepEqual(callbackUsers, [{ email: successfulEmail, emailVerified: true }])

  const rejected = createVerificationCallbackAuth({
    async afterEmailVerification(user) {
      assert.equal(user.emailVerified, true)
      throw new Error("provisioning failed after verification commit")
    },
  })
  const rejectedEmail = "callback-rejected@example.test"
  assert.equal((await post(rejected.auth, "/sign-up/email", {
    name: "Callback Rejected",
    email: rejectedEmail,
    password,
    callbackURL: trustedOrigin,
  })).status, 200)
  const rejectedVerificationUrl = rejected.readVerificationUrl()
  assert.ok(rejectedVerificationUrl)
  const originalConsoleError = console.error
  const callbackErrors: unknown[][] = []
  console.error = (...args: unknown[]) => {
    callbackErrors.push(args)
  }
  let rejectedVerification: Response
  try {
    rejectedVerification = await rejected.auth.handler(new Request(rejectedVerificationUrl))
  } finally {
    console.error = originalConsoleError
  }
  assert.equal(rejectedVerification.status, 500)
  assert.equal(callbackErrors.length, 1)

  const signInAfterRejectedCallback = await post(rejected.auth, "/sign-in/email", {
    email: rejectedEmail,
    password,
    callbackURL: trustedOrigin,
  })
  assert.equal(signInAfterRejectedCallback.status, 200)
  const signInPayload = await signInAfterRejectedCallback.json() as Record<string, unknown>
  assert.equal(typeof signInPayload.token, "string")
})

test("public verification resend is disabled identically for known and unknown emails", async () => {
  const endpointAuth = createEndpointAuth()
  const originalFetch = globalThis.fetch
  let deliveries = 0
  globalThis.fetch = async () => {
    deliveries += 1
    return new Response(JSON.stringify({ status: "queued" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  try {
    const knownEmail = "known-resend@example.test"
    const signup = await post(endpointAuth, "/sign-up/email", {
      name: "Known Resend",
      email: knownEmail,
      password,
      callbackURL: trustedOrigin,
    })
    assert.equal(signup.status, 200)
    assert.equal(deliveries, 1)

    const unknownResend = await post(endpointAuth, "/send-verification-email", {
      email: "unknown@example.test",
      callbackURL: trustedOrigin,
    })
    const knownResend = await post(endpointAuth, "/send-verification-email", {
      email: knownEmail,
      callbackURL: trustedOrigin,
    })

    assert.equal(unknownResend.status, 404)
    assert.equal(knownResend.status, unknownResend.status)
    assert.equal(await knownResend.text(), await unknownResend.text())
    assert.equal(deliveries, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("password-backed resend preserves Better Auth credential and origin protections", async () => {
  const endpointAuth = createEndpointAuth()
  const originalFetch = globalThis.fetch
  let deliveries = 0
  globalThis.fetch = async () => {
    deliveries += 1
    return new Response(JSON.stringify({ status: "queued" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  try {
    const protectedEmail = "origin-protected@example.test"
    const signup = await post(endpointAuth, "/sign-up/email", {
      name: "Origin Protected",
      email: protectedEmail,
      password,
      callbackURL: trustedOrigin,
    })
    assert.equal(signup.status, 200)
    assert.equal(deliveries, 1)

    const wrongPassword = await post(endpointAuth, "/sign-in/email", {
      email: protectedEmail,
      password: "incorrect-password",
      callbackURL: trustedOrigin,
    })
    assert.equal(wrongPassword.status, 401)
    assert.equal(wrongPassword.headers.get("set-cookie"), null)
    assert.equal(deliveries, 1)

    const untrusted = await endpointAuth.handler(new Request(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({
        email: protectedEmail,
        password,
        callbackURL: trustedOrigin,
      }),
    }))

    assert.equal(untrusted.status, 403)
    assert.equal(untrusted.headers.get("set-cookie"), null)
    assert.equal(deliveries, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("DEN auth wrapper bounds request bodies before delegating to Better Auth", async () => {
  let delegated = false
  const handler = createAuthNodeHandler(async (_req, res) => {
    delegated = true
    res.statusCode = 200
    res.end("delegated")
  }, async () => ({ ok: true }))
  const server = createServer((req, res) => void handler(req, res))
  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: trustedOrigin,
      },
      body: JSON.stringify({ email, padding: "x".repeat(70 * 1024) }),
    })

    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), {
      code: "AUTH_REQUEST_TOO_LARGE",
      message: "Authentication request body is too large.",
    })
    assert.equal(delegated, false)
  } finally {
    server.close()
    await once(server, "close")
  }
})
