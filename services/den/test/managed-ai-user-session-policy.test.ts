import assert from "node:assert/strict"
import test from "node:test"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

const { DenUserSessionResolver } = await import("../src/managed-ai/auth/user-session.js")
const { DenGatewaySessionResolver } = await import("../src/managed-ai/auth/gateway-session.js")
const { SessionPolicyRejectionError } = await import("../src/http/email-verification.js")

function createResolver(options: {
  emailVerified: boolean
  disabled?: boolean
  requireEmailVerification: boolean
}) {
  return new DenUserSessionResolver({
    async getSession(token: string) {
      assert.equal(token, "legacy-session-token")
      return {
        user: {
          id: "user_legacy",
          email: "user@example.com",
          emailVerified: options.emailVerified,
          name: "User",
        },
      }
    },
    async isUserDisabled(userId: string) {
      assert.equal(userId, "user_legacy")
      return options.disabled === true
    },
    requireEmailVerification: options.requireEmailVerification,
  })
}

test("legacy bearer resolver rejects an unverified session with the stable policy rejection", async () => {
  const resolver = createResolver({ emailVerified: false, requireEmailVerification: true })

  await assert.rejects(
    resolver.resolveSession(" legacy-session-token "),
    (error: unknown) => {
      assert.equal(error instanceof SessionPolicyRejectionError, true)
      assert.deepEqual((error as InstanceType<typeof SessionPolicyRejectionError>).rejection, {
        status: 403,
        body: {
          error: "email_verification_required",
          message: "Verify your email to continue.",
          email: "user@example.com",
        },
      })
      return true
    },
  )
})

test("legacy bearer resolver permits an unverified session when verification is disabled", async () => {
  const resolver = createResolver({ emailVerified: false, requireEmailVerification: false })

  assert.deepEqual(await resolver.resolveSession("legacy-session-token"), {
    token: "legacy-session-token",
    user: {
      id: "user_legacy",
      email: "user@example.com",
      name: "User",
    },
  })
})

test("legacy bearer resolver preserves disabled-user precedence over verification rejection", async () => {
  const resolver = createResolver({
    emailVerified: false,
    disabled: true,
    requireEmailVerification: true,
  })

  assert.equal(await resolver.resolveSession("legacy-session-token"), null)
})

test("legacy gateway resolver delegates the same verification rejection", async () => {
  const resolver = new DenGatewaySessionResolver(
    createResolver({ emailVerified: false, requireEmailVerification: true }),
  )

  await assert.rejects(
    resolver.resolveSession("legacy-session-token"),
    (error: unknown) => error instanceof SessionPolicyRejectionError,
  )
})
