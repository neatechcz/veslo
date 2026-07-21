import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  continueDesktopExchangeAfterUserPolicy,
  type DesktopExchangePolicySubject,
} from "../src/http/desktop-auth-exchange-policy.js"

const v1Source = readFileSync(new URL("../src/http/desktop-auth.ts", import.meta.url), "utf8")
const v2Source = readFileSync(new URL("../src/http/desktop-auth-v2.ts", import.meta.url), "utf8")

type ExchangeState = {
  codeConsumed: boolean
  transactionStatus: "browser_authed" | "exchanged"
  insertedSessions: number
}

function createExchangeAttempt(subject: DesktopExchangePolicySubject, state: ExchangeState) {
  return () => continueDesktopExchangeAfterUserPolicy(
    {
      requireEmailVerification: true,
      loadSubject: async () => subject,
    },
    async () => {
      state.codeConsumed = true
      state.transactionStatus = "exchanged"
      state.insertedSessions += 1
      return { ok: true as const, token: "new-session" }
    },
  )
}

for (const generation of ["v1", "v2"] as const) {
  test(`${generation} exchange keeps an authorized code retryable when its user is unverified`, async () => {
    const state: ExchangeState = {
      codeConsumed: false,
      transactionStatus: "browser_authed",
      insertedSessions: 0,
    }
    const attempt = createExchangeAttempt({
      user: {
        id: "user_unverified",
        email: "pending@example.com",
        emailVerified: false,
        name: "Pending User",
      },
      disabled: false,
    }, state)

    const first = await attempt()
    assert.deepEqual(first, {
      ok: false,
      kind: "policy",
      status: 403,
      body: {
        error: "email_verification_required",
        message: "Verify your email to continue.",
        email: "pending@example.com",
      },
    })
    assert.deepEqual(state, {
      codeConsumed: false,
      transactionStatus: "browser_authed",
      insertedSessions: 0,
    })

    const retry = await attempt()
    assert.deepEqual(retry, first)
    assert.deepEqual(state, {
      codeConsumed: false,
      transactionStatus: "browser_authed",
      insertedSessions: 0,
    })
  })
}

test("disabled exchange user takes precedence over unverified email", async () => {
  const state: ExchangeState = {
    codeConsumed: false,
    transactionStatus: "browser_authed",
    insertedSessions: 0,
  }
  const attempt = createExchangeAttempt({
    user: {
      id: "user_disabled",
      email: "disabled@example.com",
      emailVerified: false,
      name: "Disabled User",
    },
    disabled: true,
  }, state)

  assert.deepEqual(await attempt(), {
    ok: false,
    kind: "policy",
    status: 403,
    body: { error: "user_disabled" },
  })
  assert.deepEqual(state, {
    codeConsumed: false,
    transactionStatus: "browser_authed",
    insertedSessions: 0,
  })
})

test("both exchange transactions re-read policy before consuming a code or inserting a session", () => {
  for (const [generation, source] of [["v1", v1Source], ["v2", v2Source]] as const) {
    const exchange = source.slice(source.indexOf('Router.post("/exchange"'))
    const policyIndex = exchange.indexOf("continueDesktopExchangeAfterUserPolicy(")
    const consumeIndex = exchange.indexOf(".update(DesktopAuthHandoffTable)")
    const insertSessionIndex = exchange.indexOf(".insert(AuthSessionTable)")

    assert.notEqual(policyIndex, -1, `${generation} must evaluate stored-user policy during exchange`)
    assert.equal(policyIndex < consumeIndex, true, `${generation} must gate code consumption`)
    assert.equal(policyIndex < insertSessionIndex, true, `${generation} must gate session insertion`)
  }
})
