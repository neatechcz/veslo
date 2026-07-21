import assert from "node:assert/strict"
import test from "node:test"

const requiredEnv = {
  DATABASE_URL: "mysql://root:root@localhost:3306/den",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:8788",
  LETTR_API_KEY: "lettr_test_key",
  AUTH_EMAIL_ADDRESS: "auth@example.com",
  AUTH_EMAIL_FROM_NAME: "Veslo",
}

function withRequiredEnv() {
  for (const [key, value] of Object.entries(requiredEnv)) {
    process.env[key] = value
  }
}

function importAuthMailer() {
  return import(`../src/email/auth-mailer.js?case=${Date.now()}-${Math.random()}`)
}

test("verification auth email uses Lettr send-email payload", async () => {
  withRequiredEnv()

  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return new Response(JSON.stringify({ message: "queued" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  try {
    const { sendVerificationAuthEmail } = await importAuthMailer()

    await sendVerificationAuthEmail({ to: "user@example.com", url: "https://example.com/verify" })

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, "https://app.lettr.com/api/emails")
    assert.equal(requests[0]?.init?.method, "POST")
    assert.equal(requests[0]?.init?.headers?.["Authorization"], "Bearer lettr_test_key")
    assert.equal(requests[0]?.init?.headers?.["Content-Type"], "application/json")

    const body = JSON.parse(String(requests[0]?.init?.body))
    assert.equal(body.from, "auth@example.com")
    assert.equal(body.from_name, "Veslo")
    assert.deepEqual(body.to, ["user@example.com"])
    assert.equal(body.subject, "Verify your Veslo email")
    assert.match(body.html, /https:\/\/example\.com\/verify/)
    assert.match(body.text, /https:\/\/example\.com\/verify/)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(requiredEnv)) {
      delete process.env[key]
    }
  }
})

test("verification auth email uses branded button copy without a visible raw url", async () => {
  withRequiredEnv()

  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return new Response(JSON.stringify({ message: "queued" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  try {
    const { sendVerificationAuthEmail } = await importAuthMailer()
    const verificationUrl = "https://example.com/verify?token=abc123"

    await sendVerificationAuthEmail({ to: "user@example.com", url: verificationUrl })

    const body = JSON.parse(String(requests[0]?.init?.body))
    const html = String(body.html)
    const visibleHtml = html.replace(/\shref="[^"]*"/g, "")

    assert.match(html, /https:\/\/veslo\.work\/assets\/veslo-logo-square\.svg/)
    assert.doesNotMatch(html, /hero-skill-screenshot|hero-connected-systems/)
    assert.match(html, />\s*Verify email\s*</)
    assert.match(html, /href="https:\/\/example\.com\/verify\?token=abc123"/)
    assert.doesNotMatch(visibleHtml, /https:\/\/example\.com\/verify\?token=abc123/)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(requiredEnv)) {
      delete process.env[key]
    }
  }
})

test("organization invitation auth email uses a branded registration payload", async () => {
  withRequiredEnv()

  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return new Response(JSON.stringify({ message: "queued" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  try {
    const { sendOrganizationInvitationAuthEmail } = await importAuthMailer()
    const invitationUrl = "https://app.veslo.work/?inviteToken=raw-token%2B%2F%3D"

    await sendOrganizationInvitationAuthEmail({
      to: "invited.user@example.com",
      url: invitationUrl,
    })

    assert.equal(requests.length, 1)
    const body = JSON.parse(String(requests[0]?.init?.body))
    const html = String(body.html)
    const text = String(body.text)
    const visibleHtml = html.replace(/\shref="[^"]*"/g, "")

    assert.deepEqual(body.to, ["invited.user@example.com"])
    assert.match(String(body.subject), /invited.*Veslo/i)
    assert.match(html, /https:\/\/veslo\.work\/assets\/veslo-logo-square\.svg/)
    assert.match(html, />\s*(Register|Join Veslo)\s*</i)
    assert.match(html, /href="https:\/\/app\.veslo\.work\/\?inviteToken=raw-token%2B%2F%3D"/)
    assert.doesNotMatch(visibleHtml, /raw-token/)
    assert.match(text, /register|join Veslo/i)
    assert.match(text, /https:\/\/app\.veslo\.work\/\?inviteToken=raw-token%2B%2F%3D/)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(requiredEnv)) {
      delete process.env[key]
    }
  }
})

test("background auth email helper absorbs rejected Lettr sends", async () => {
  withRequiredEnv()

  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(" "))
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("lettr unavailable")
  }

  try {
    const { fireAndForgetAuthEmail, sendVerificationAuthEmail } = await importAuthMailer()

    await fireAndForgetAuthEmail(sendVerificationAuthEmail({ to: "user@example.com", url: "https://example.com/verify" }), "verification email")

    assert.equal(errors.some((entry) => entry.includes("verification email")), true)
    assert.equal(errors.some((entry) => entry.includes("lettr unavailable")), true)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
    for (const key of Object.keys(requiredEnv)) {
      delete process.env[key]
    }
  }
})
