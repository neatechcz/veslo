import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import mysql from "mysql2/promise"

const denBaseUrl = requiredEnv("VESLO_TEST_DEN_BASE_URL").replace(/\/+$/, "")
const captureBaseUrl = requiredEnv("VESLO_TEST_EMAIL_CAPTURE_URL").replace(/\/+$/, "")
const databaseUrl = requiredEnv("VESLO_TEST_DEN_DATABASE_URL")
const outputPath = requiredEnv("VESLO_TEST_EMAIL_VERIFICATION_PILOT_FIXTURE_PATH")
const nonce = randomUUID().replaceAll("-", "")
const password = "VesloPilotVerification123!"

const unverified = await createBlockedUnverifiedTransaction()
const verified = await createVerifiedTransaction()

await writeFile(outputPath, `${JSON.stringify({
  schema: "veslo-email-verification-handoff-fixture/v1",
  denBaseUrl,
  unverified,
  verified,
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })

async function createBlockedUnverifiedTransaction() {
  const email = `pilot-unverified-${nonce}@company-${nonce}.veslo.test`
  const state = `unverified-state-${nonce}`
  const codeVerifier = `unverified-verifier-${nonce}-0123456789abcdefghijklmnopqrstuvwxyz`
  const transactionId = await startTransaction("signup", state, codeVerifier)

  const signup = await postJson("/api/auth/sign-up/email", {
    name: "Pilot Unverified",
    email,
    password,
    callbackURL: verificationCallback(transactionId, state),
  })
  assert.equal(signup.response.status, 200, signup.text)
  assert.equal(signup.body.token, null)
  await waitForMessage(email)

  const legacyToken = await createLegacyUnverifiedSession(email)
  const authorize = await postJson(
    "/v2/desktop-auth/authorize",
    { transactionId, state },
    legacyToken,
  )
  assert.equal(authorize.response.status, 403, authorize.text)
  assert.equal(authorize.body.error, "email_verification_required")

  const status = await getJson(`/v2/desktop-auth/status?transactionId=${encodeURIComponent(transactionId)}`)
  assert.equal(status.response.status, 200, status.text)
  assert.equal(status.body.status, "pending")
  assert.equal(status.body.code ?? null, null)

  return {
    email,
    transactionId,
    status: "pending",
    code: null,
    authorizeStatus: 403,
    authorizeError: "email_verification_required",
  }
}

async function createVerifiedTransaction() {
  const email = `pilot-verified-${nonce}@company-verified-${nonce}.veslo.test`
  const state = `verified-state-${nonce}`
  const codeVerifier = `verified-verifier-${nonce}-0123456789abcdefghijklmnopqrstuvwxyz`
  const transactionId = await startTransaction("signup", state, codeVerifier)

  const signup = await postJson("/api/auth/sign-up/email", {
    name: "Pilot Verified",
    email,
    password,
    callbackURL: verificationCallback(transactionId, state),
  })
  assert.equal(signup.response.status, 200, signup.text)
  assert.equal(signup.body.token, null)

  const message = await waitForMessage(email)
  const verification = await fetch(message.verificationUrl, { redirect: "manual" })
  assert.equal(verification.status, 302)

  const signIn = await postJson("/api/auth/sign-in/email", { email, password })
  assert.equal(signIn.response.status, 200, signIn.text)
  const token = requiredString(signIn.body.token, "verified sign-in token")

  const me = await getJson("/v1/me", token)
  assert.equal(me.response.status, 200, me.text)
  assert.equal((me.body.user as Record<string, unknown> | undefined)?.emailVerified, true)
  const userId = requiredString((me.body.user as Record<string, unknown> | undefined)?.id, "verified user id")

  const authorize = await postJson(
    "/v2/desktop-auth/authorize",
    { transactionId, state },
    token,
  )
  assert.equal(authorize.response.status, 200, authorize.text)
  const deepLink = requiredString(authorize.body.redirectUrl, "verified redirectUrl")
  const parsedDeepLink = new URL(deepLink)
  assert.equal(parsedDeepLink.protocol, "veslo:")
  assert.equal(parsedDeepLink.hostname, "auth-complete")
  assert.equal(parsedDeepLink.searchParams.get("transactionId"), transactionId)
  assert.equal(parsedDeepLink.searchParams.get("state"), state)
  assert.ok(parsedDeepLink.searchParams.get("code"))

  return { email, userId, transactionId, state, codeVerifier, deepLink }
}

async function startTransaction(intent: "signup" | "signin", state: string, codeVerifier: string) {
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
  const start = await postJson("/v2/desktop-auth/start", {
    intent,
    redirectUri: "veslo://auth-complete",
    state,
    codeChallenge,
    codeChallengeMethod: "S256",
  })
  assert.equal(start.response.status, 201, start.text)
  return requiredString(start.body.transactionId, "transactionId")
}

function verificationCallback(transactionId: string, state: string) {
  return `${denBaseUrl}/?desktopOnboarding=1&tid=${encodeURIComponent(transactionId)}&state=${encodeURIComponent(state)}&intent=signup&view=verify-email`
}

async function createLegacyUnverifiedSession(email: string) {
  const connection = await mysql.createConnection(databaseUrl)
  try {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT id, email_verified FROM `user` WHERE email = ? LIMIT 1",
      [email],
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.email_verified, 0)
    const token = `legacy_pilot_${randomUUID().replaceAll("-", "")}`
    await connection.execute(
      "INSERT INTO `session` (id, user_id, token, expires_at, ip_address, user_agent) VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL 1 HOUR), ?, ?)",
      [randomUUID(), rows[0]!.id, token, "127.0.0.1", "veslo-email-verification-pilot"],
    )
    return token
  } finally {
    await connection.end()
  }
}

type CapturedMessage = { to: string; verificationUrl: string }

async function waitForMessage(email: string): Promise<CapturedMessage> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const response = await fetch(`${captureBaseUrl}/messages`)
    assert.equal(response.status, 200)
    const messages = await response.json() as CapturedMessage[]
    const message = messages.find((candidate) => candidate.to === email)
    if (message) return message
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`Verification email was not captured for ${email}`)
}

async function getJson(path: string, bearerToken?: string) {
  const headers = new Headers({ Accept: "application/json" })
  if (bearerToken) headers.set("Authorization", `Bearer ${bearerToken}`)
  const response = await fetch(`${denBaseUrl}${path}`, { headers })
  const text = await response.text()
  return { response, text, body: parseJson(text) }
}

async function postJson(path: string, body: Record<string, unknown>, bearerToken?: string) {
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json", Origin: denBaseUrl })
  if (bearerToken) {
    headers.set("Authorization", `Bearer ${bearerToken}`)
    headers.set("x-veslo-desktop-auth-transport", "json")
  }
  const response = await fetch(`${denBaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  })
  const text = await response.text()
  return { response, text, body: parseJson(text) }
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return value ? JSON.parse(value) as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function requiredString(value: unknown, label: string) {
  assert.equal(typeof value, "string", `${label} must be a string`)
  assert.ok(value.trim(), `${label} must not be empty`)
  return value.trim()
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
