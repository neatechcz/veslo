import assert from "node:assert/strict"
import test from "node:test"

const requiredEnv = {
  DATABASE_URL: "mysql://root:root@localhost:3306/den",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:8788",
  RESEND_API_KEY: "resend_test_key",
  AUTH_EMAIL_FROM: "Veslo <auth@example.com>",
}

function withRequiredEnv() {
  for (const [key, value] of Object.entries(requiredEnv)) {
    process.env[key] = value
  }
}

test("background auth email helper absorbs rejected sends", async () => {
  withRequiredEnv()

  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(" "))
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("resend unavailable")
  }

  try {
    const { fireAndForgetAuthEmail, sendVerificationAuthEmail } = await import("../src/email/auth-mailer.js")

    await fireAndForgetAuthEmail(sendVerificationAuthEmail({ to: "user@example.com", url: "https://example.com/verify" }), "verification email")

    assert.equal(errors.some((entry) => entry.includes("verification email")), true)
    assert.equal(errors.some((entry) => entry.includes("resend unavailable")), true)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    for (const key of Object.keys(requiredEnv)) {
      delete process.env[key]
    }
  }
})
