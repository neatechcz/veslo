import { randomUUID } from "node:crypto"
import { expect, test, type APIRequestContext } from "@playwright/test"

const fixtureEnvironment = [
  process.env.VESLO_TEST_DEN_BASE_URL?.trim(),
  process.env.VESLO_TEST_EMAIL_CAPTURE_URL?.trim(),
]
const configuredFixtureValues = fixtureEnvironment.filter(Boolean)
if (configuredFixtureValues.length > 0 && configuredFixtureValues.length !== fixtureEnvironment.length) {
  throw new Error("The email verification browser runner must provide every fixture URL")
}
const acceptanceEnabled = configuredFixtureValues.length === fixtureEnvironment.length
const denBaseUrl = fixtureEnvironment[0]?.replace(/\/+$/, "") ?? "http://127.0.0.1:0"
const captureBaseUrl = fixtureEnvironment[1]?.replace(/\/+$/, "") ?? "http://127.0.0.1:0"

test.skip(!acceptanceEnabled, "run with pnpm test:email-verification:browser")

type CapturedMessage = {
  to: string
  subject: string
  verificationUrl: string
}

test("hosted onboarding recovers from resend failure and authorizes only after verification", async ({ page, request }) => {
  const nonce = randomUUID().replaceAll("-", "")
  const email = `browser-${nonce}@company-${nonce}.veslo.test`
  const password = "VesloBrowserVerification123!"
  const state = `state-${nonce}`

  const startResponse = await request.post(`${denBaseUrl}/v2/desktop-auth/start`, {
    data: {
      intent: "signup",
      redirectUri: "veslo://auth-complete",
      state,
      codeChallenge: `challenge-${nonce}-0123456789abcdefghijklmnopqrstuvwxyz`,
      codeChallengeMethod: "S256",
    },
  })
  expect(startResponse.status()).toBe(201)
  const start = await startResponse.json() as { transactionId: string; authorizeUrl: string }

  await page.goto(start.authorizeUrl, { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Create your Veslo account" })).toBeVisible()
  await page.locator("#auth-name").fill("Verification Browser")
  await page.locator("#auth-email").fill(email)
  await page.locator("#auth-password").fill(password)
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Continue to Veslo" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Resend verification email" })).toBeVisible()
  await expect(page.getByLabel("Confirm password", { exact: true })).toBeVisible()
  expect(await waitForMessages(request, 1)).toHaveLength(1)
  await expectTransactionStatus(request, start.transactionId, "pending")

  await setCaptureAcceptance(request, false)
  await page.locator("#verify-required-password").fill(password)
  await page.getByRole("button", { name: "Resend verification email" }).click()
  await expect(page.locator("#verify-required-error")).toContainText("could not resend")
  expect(await readMessages(request)).toHaveLength(1)

  await setCaptureAcceptance(request, true)
  await page.locator("#verify-required-password").fill(password)
  await page.getByRole("button", { name: "Resend verification email" }).click()
  await expect(page.locator("#verify-required-status")).toContainText("Verification email sent")
  const messages = await waitForMessages(request, 2)
  expect(messages).toHaveLength(2)
  expect(messages[1]?.to).toBe(email)

  await page.goto(messages[1]!.verificationUrl, { waitUntil: "domcontentloaded" })
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible()
  await page.getByRole("button", { name: "Return to sign in" }).click()

  await expect(page.getByRole("heading", { name: "Sign in to Veslo" })).toBeVisible()
  await page.locator("#auth-email").fill(email)
  await page.locator("#auth-password").fill(password)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()

  await expect.poll(async () => readTransactionStatus(request, start.transactionId)).toBe("authorized")
})

async function setCaptureAcceptance(request: APIRequestContext, accept: boolean) {
  const response = await request.post(`${captureBaseUrl}/control`, { data: { accept } })
  expect(response.status()).toBe(204)
}

async function readMessages(request: APIRequestContext): Promise<CapturedMessage[]> {
  const response = await request.get(`${captureBaseUrl}/messages`)
  expect(response.status()).toBe(200)
  return response.json()
}

async function waitForMessages(request: APIRequestContext, minimum: number) {
  let messages: CapturedMessage[] = []
  await expect.poll(async () => {
    messages = await readMessages(request)
    return messages.length
  }).toBeGreaterThanOrEqual(minimum)
  return messages
}

async function readTransactionStatus(request: APIRequestContext, transactionId: string) {
  const response = await request.get(
    `${denBaseUrl}/v2/desktop-auth/status?transactionId=${encodeURIComponent(transactionId)}`,
  )
  expect(response.status()).toBe(200)
  return (await response.json() as { status: string }).status
}

async function expectTransactionStatus(request: APIRequestContext, transactionId: string, status: string) {
  expect(await readTransactionStatus(request, transactionId)).toBe(status)
}
