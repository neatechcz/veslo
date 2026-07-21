import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"
import test from "node:test"
import mysql from "mysql2/promise"

const fixtureEnvironment = [
  process.env.VESLO_TEST_DEN_BASE_URL?.trim(),
  process.env.VESLO_TEST_EMAIL_CAPTURE_URL?.trim(),
  process.env.VESLO_TEST_DEN_DATABASE_URL?.trim(),
]
const configuredFixtureValues = fixtureEnvironment.filter(Boolean)
if (configuredFixtureValues.length > 0 && configuredFixtureValues.length !== fixtureEnvironment.length) {
  throw new Error("The email verification acceptance runner must provide every fixture URL")
}
const acceptanceEnabled = configuredFixtureValues.length === fixtureEnvironment.length
const denBaseUrl = fixtureEnvironment[0]?.replace(/\/+$/, "") ?? "http://127.0.0.1:0"
const captureBaseUrl = fixtureEnvironment[1]?.replace(/\/+$/, "") ?? "http://127.0.0.1:0"
const databaseUrl = fixtureEnvironment[2] ?? "mysql://invalid:invalid@127.0.0.1:0/invalid"

type JsonRecord = Record<string, unknown>
type CapturedMessage = {
  to: string
  subject: string
  verificationUrl: string
}

test("registration remains unauthenticated until the delivered verification link is used", {
  timeout: 60_000,
  skip: acceptanceEnabled ? false : "run with pnpm test:email-verification:integration",
}, async () => {
  const nonce = randomUUID().replaceAll("-", "")
  const email = `verification-${nonce}@company-${nonce}.veslo.test`
  const rejectedEmail = `rejected-${nonce}@rejected-${nonce}.veslo.test`
  const password = "VesloVerification123!"
  const state = `state-${nonce}`
  const codeVerifier = `verifier-${nonce}-0123456789abcdefghijklmnopqrstuvwxyz`
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")

  const start = await postJson("/v2/desktop-auth/start", {
    intent: "signup",
    redirectUri: "veslo://auth-complete",
    state,
    codeChallenge,
    codeChallengeMethod: "S256",
  })
  assert.equal(start.response.status, 201, JSON.stringify(start.body))
  const transactionId = requiredString(start.body.transactionId, "transactionId")

  const signup = await postJson("/api/auth/sign-up/email", {
    name: "Verification Acceptance",
    email,
    password,
    callbackURL: `${denBaseUrl}/?desktopOnboarding=1&tid=${encodeURIComponent(transactionId)}&state=${encodeURIComponent(state)}&intent=signup&view=verify-email`,
  })
  assert.equal(signup.response.status, 200, JSON.stringify(signup.body))
  assert.equal(signup.body.token, null)
  assert.equal(signup.response.headers.has("set-auth-token"), false)
  assert.deepEqual(readSetCookieValues(signup.response.headers), [])
  assert.equal(await countSessionsForEmail(email), 0)

  const anonymousSession = await fetch(`${denBaseUrl}/v1/me`)
  assert.equal(anonymousSession.status, 401)

  const registrationMessages = await waitForMessages(1)
  assert.equal(registrationMessages.length, 1)
  assert.equal(registrationMessages[0]?.to, email)
  assert.equal(registrationMessages[0]?.subject, "Verify your Veslo email")
  assert.match(registrationMessages[0]?.verificationUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/api\/auth\/verify-email\?/)

  await setCaptureControl(false)
  const rejectedSignup = await postJson("/api/auth/sign-up/email", {
    name: "Rejected Verification Acceptance",
    email: rejectedEmail,
    password,
    callbackURL: `${denBaseUrl}/?desktopOnboarding=1&view=verify-email`,
  })
  assertStableDeliveryFailure(rejectedSignup)
  assert.equal(await countSessionsForEmail(rejectedEmail), 0)
  assert.equal((await waitForMessages(1)).length, 1)

  const messagesBeforeAnonymousAttempt = (await waitForMessages(1)).length
  const anonymousResend = await fetch(`${denBaseUrl}/api/auth/send-verification-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: denBaseUrl },
    body: JSON.stringify({ email, callbackURL: `${denBaseUrl}/?desktopOnboarding=1&view=verify-email` }),
  })
  assert.equal(anonymousResend.status, 404)
  assert.equal(await anonymousResend.text(), "Not Found")
  assert.equal((await waitForMessages(messagesBeforeAnonymousAttempt)).length, messagesBeforeAnonymousAttempt)

  await setCaptureControl(true, [rejectedEmail])
  const [acceptedSignIn, rejectedSignIn] = await Promise.all([
    postJson(
      "/api/auth/sign-in/email",
      { email, password, callbackURL: `${denBaseUrl}/?desktopOnboarding=1&view=verify-email` },
      undefined,
      denBaseUrl,
      "198.51.100.10",
    ),
    postJson(
      "/api/auth/sign-in/email",
      { email: rejectedEmail, password, callbackURL: `${denBaseUrl}/?desktopOnboarding=1&view=verify-email` },
      undefined,
      denBaseUrl,
      "198.51.100.11",
    ),
  ])
  assert.equal(acceptedSignIn.response.status, 403, acceptedSignIn.text)
  assert.equal(acceptedSignIn.body.code, "EMAIL_NOT_VERIFIED")
  assertStableDeliveryFailure(rejectedSignIn)
  const concurrentMessages = await waitForMessages(2)
  assert.equal(concurrentMessages.length, 2)
  assert.equal(concurrentMessages[1]?.to, email)
  assert.equal(concurrentMessages.some((message) => message.to === rejectedEmail), false)

  const messageCountBeforeCredentialFailures = concurrentMessages.length
  const wrongPassword = await postJson(
    "/api/auth/sign-in/email",
    { email, password: `${password}-wrong` },
    undefined,
    denBaseUrl,
    "198.51.100.12",
  )
  const unknownAccount = await postJson(
    "/api/auth/sign-in/email",
    { email: `missing-${nonce}@missing-${nonce}.veslo.test`, password },
    undefined,
    denBaseUrl,
    "198.51.100.13",
  )
  assert.equal(wrongPassword.response.status, 401)
  assert.equal(unknownAccount.response.status, wrongPassword.response.status)
  assert.equal(unknownAccount.text, wrongPassword.text)
  assert.equal(unknownAccount.response.headers.get("content-type"), wrongPassword.response.headers.get("content-type"))
  assert.equal((await waitForMessages(messageCountBeforeCredentialFailures)).length, messageCountBeforeCredentialFailures)

  const untrustedOrigin = await postJson(
    "/api/auth/sign-in/email",
    { email, password, callbackURL: `${denBaseUrl}/?desktopOnboarding=1&view=verify-email` },
    undefined,
    "https://untrusted.veslo.test",
  )
  assert.equal(untrustedOrigin.response.status, 403, untrustedOrigin.text)
  const untrustedCallback = await postJson(
    "/api/auth/sign-in/email",
    { email, password, callbackURL: "https://untrusted.veslo.test/verify-email" },
  )
  assert.equal(untrustedCallback.response.status, 403, untrustedCallback.text)
  assert.equal((await waitForMessages(messageCountBeforeCredentialFailures)).length, messageCountBeforeCredentialFailures)

  const rateLimitedResponses = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    rateLimitedResponses.push(await postJson(
      "/api/auth/sign-in/email",
      { email: `rate-limit-${nonce}@missing-${nonce}.veslo.test`, password },
      undefined,
      denBaseUrl,
      "198.51.100.20",
    ))
  }
  assert.deepEqual(rateLimitedResponses.map(({ response }) => response.status), [401, 401, 401, 429])
  assert.equal((await waitForMessages(messageCountBeforeCredentialFailures)).length, messageCountBeforeCredentialFailures)

  const userCountBeforeOversizedRequests = await countUsers()
  const contentLengthEmail = `oversized-length-${nonce}@oversized-${nonce}.veslo.test`
  const oversizedContentLengthBody = JSON.stringify({
    name: "Oversized Content Length",
    email: contentLengthEmail,
    password,
    padding: "x".repeat(64 * 1024),
  })
  const contentLengthResponse = await rawAuthRequest({
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(oversizedContentLengthBody)),
      Origin: denBaseUrl,
    },
    chunks: [oversizedContentLengthBody],
  })
  assertStableTooLarge(contentLengthResponse)
  assert.equal(await countUsersForEmail(contentLengthEmail), 0)
  assert.equal(await countUsers(), userCountBeforeOversizedRequests)

  const chunkedEmail = `oversized-chunked-${nonce}@oversized-${nonce}.veslo.test`
  const oversizedChunkedBody = JSON.stringify({
    name: "Oversized Chunked",
    email: chunkedEmail,
    password,
    padding: "x".repeat(64 * 1024),
  })
  const chunkedResponse = await rawAuthRequest({
    headers: { "Content-Type": "application/json", Origin: denBaseUrl },
    chunks: [oversizedChunkedBody.slice(0, 32_768), oversizedChunkedBody.slice(32_768)],
  })
  assertStableTooLarge(chunkedResponse)
  assert.equal(await countUsersForEmail(chunkedEmail), 0)
  assert.equal(await countUsers(), userCountBeforeOversizedRequests)
  assert.equal((await waitForMessages(messageCountBeforeCredentialFailures)).length, messageCountBeforeCredentialFailures)

  const legacyBearer = await createLegacyUnverifiedSession(email)
  const blockedAuthorize = await postJson(
    "/v2/desktop-auth/authorize",
    { transactionId, state },
    legacyBearer,
  )
  assert.equal(blockedAuthorize.response.status, 403, JSON.stringify(blockedAuthorize.body))
  assert.deepEqual(blockedAuthorize.body, {
    error: "email_verification_required",
    message: "Verify your email to continue.",
    email,
  })

  const beforeStatus = await getJson(`/v2/desktop-auth/status?transactionId=${encodeURIComponent(transactionId)}`)
  assert.equal(beforeStatus.response.status, 200, JSON.stringify(beforeStatus.body))
  assert.equal(beforeStatus.body.status, "pending")

  const verificationResponse = await fetch(registrationMessages[0]!.verificationUrl, { redirect: "manual" })
  assert.equal(verificationResponse.status, 302)

  const signedIn = await postJson("/api/auth/sign-in/email", { email, password })
  assert.equal(signedIn.response.status, 200, JSON.stringify(signedIn.body))
  const bearerToken = requiredString(signedIn.body.token, "sign-in token")

  const authenticatedSession = await getJson("/v1/me", bearerToken)
  assert.equal(authenticatedSession.response.status, 200, JSON.stringify(authenticatedSession.body))
  assert.equal((authenticatedSession.body.user as JsonRecord | undefined)?.emailVerified, true)

  const authorized = await postJson(
    "/v2/desktop-auth/authorize",
    { transactionId, state },
    bearerToken,
  )
  assert.equal(authorized.response.status, 200, JSON.stringify(authorized.body))
  assert.match(requiredString(authorized.body.redirectUrl, "redirectUrl"), /^veslo:\/\/auth-complete\?/)

  const afterStatus = await getJson(`/v2/desktop-auth/status?transactionId=${encodeURIComponent(transactionId)}`)
  assert.equal(afterStatus.response.status, 200, JSON.stringify(afterStatus.body))
  assert.equal(afterStatus.body.status, "authorized")
})

async function createLegacyUnverifiedSession(email: string) {
  const connection = await mysql.createConnection(databaseUrl)
  try {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT id, email_verified FROM `user` WHERE email = ? LIMIT 1",
      [email],
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.email_verified, 0)

    const token = `legacy_${randomUUID().replaceAll("-", "")}`
    await connection.execute(
      "INSERT INTO `session` (id, user_id, token, expires_at, ip_address, user_agent) VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL 1 HOUR), ?, ?)",
      [randomUUID(), rows[0]!.id, token, "127.0.0.1", "veslo-email-verification-acceptance"],
    )
    return token
  } finally {
    await connection.end()
  }
}

async function countSessionsForEmail(email: string) {
  const connection = await mysql.createConnection(databaseUrl)
  try {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS session_count FROM `session` INNER JOIN `user` ON `session`.user_id = `user`.id WHERE `user`.email = ?",
      [email],
    )
    return Number(rows[0]?.session_count ?? Number.NaN)
  } finally {
    await connection.end()
  }
}

async function countUsersForEmail(email: string) {
  const connection = await mysql.createConnection(databaseUrl)
  try {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS user_count FROM `user` WHERE email = ?",
      [email],
    )
    return Number(rows[0]?.user_count ?? Number.NaN)
  } finally {
    await connection.end()
  }
}

async function countUsers() {
  const connection = await mysql.createConnection(databaseUrl)
  try {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS user_count FROM `user`")
    return Number(rows[0]?.user_count ?? Number.NaN)
  } finally {
    await connection.end()
  }
}

async function setCaptureControl(accept: boolean, rejectRecipients: string[] = []) {
  const response = await fetch(`${captureBaseUrl}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accept, rejectRecipients }),
  })
  assert.equal(response.status, 204)
}

async function waitForMessages(minimum: number) {
  const deadline = Date.now() + 10_000
  let messages: CapturedMessage[] = []
  while (Date.now() < deadline) {
    const response = await fetch(`${captureBaseUrl}/messages`)
    assert.equal(response.status, 200)
    messages = (await response.json()) as CapturedMessage[]
    if (messages.length >= minimum) return messages
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`Expected at least ${minimum} captured messages, received ${messages.length}`)
}

async function postJson(
  path: string,
  body: JsonRecord,
  bearerToken?: string,
  origin: string | null = denBaseUrl,
  forwardedFor?: string,
) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json",
  })
  if (origin) {
    headers.set("Origin", origin)
  }
  if (bearerToken) {
    headers.set("Authorization", `Bearer ${bearerToken}`)
    headers.set("x-veslo-desktop-auth-transport", "json")
  }
  if (forwardedFor) {
    headers.set("x-forwarded-for", forwardedFor)
  }

  const response = await fetch(`${denBaseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  })
  const text = await response.text()
  return { response, text, body: parseJson(text, response) }
}

function rawAuthRequest(input: { headers: Record<string, string>; chunks?: string[] }) {
  const url = new URL("/api/auth/sign-up/email", denBaseUrl)
  return new Promise<{ status: number; text: string; headers: Headers }>((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: input.headers,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString("utf8"),
        headers: new Headers(Object.entries(response.headers).flatMap(([key, value]) =>
          Array.isArray(value) ? value.map((entry) => [key, entry] as [string, string]) : value ? [[key, String(value)]] : [])),
      }))
    })
    request.on("error", reject)
    for (const chunk of input.chunks ?? []) request.write(chunk)
    request.end()
  })
}

function assertStableDeliveryFailure(result: { response: Response; body: JsonRecord; text: string }) {
  assert.equal(result.response.status, 502, result.text)
  assert.deepEqual(result.body, {
    code: "VERIFICATION_EMAIL_DELIVERY_FAILED",
    message: "We could not send the verification email. Please try again.",
  })
}

function assertStableTooLarge(result: { status: number; text: string }) {
  assert.equal(result.status, 413, result.text)
  assert.deepEqual(JSON.parse(result.text), {
    code: "AUTH_REQUEST_TOO_LARGE",
    message: "Authentication request body is too large.",
  })
}

function readSetCookieValues(headers: Headers) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers)
  }
  const combined = headers.get("set-cookie")
  return combined ? [combined] : []
}

async function getJson(path: string, bearerToken?: string) {
  const response = await fetch(`${denBaseUrl}${path}`, {
    headers: {
      Accept: "application/json",
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    },
  })
  return { response, body: await readJson(response) }
}

async function readJson(response: Response): Promise<JsonRecord> {
  const text = await response.text()
  return parseJson(text, response)
}

function parseJson(text: string, response: Response): JsonRecord {
  try {
    return JSON.parse(text) as JsonRecord
  } catch {
    assert.fail(`Expected JSON from ${response.url} (${response.status}), received: ${text}`)
  }
}

function requiredString(value: unknown, label: string) {
  assert.equal(typeof value, "string", `Expected ${label} to be a string`)
  assert.notEqual(value.trim(), "", `Expected ${label} to be non-empty`)
  return value
}
