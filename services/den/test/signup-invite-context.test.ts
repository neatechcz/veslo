import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { resolveSignupInviteTokenFromAuthContext } from "../src/auth/signup-invite-context.js"

test("signup invite context preserves email body token aliases", async () => {
  for (const [key, value] of [
    ["inviteToken", "canonical-token"],
    ["invitationToken", "legacy-invitation-token"],
    ["tokenHash", "legacy-hash-token"],
    ["token", "legacy-token"],
  ] as const) {
    assert.equal(await resolveSignupInviteTokenFromAuthContext({
      path: "/sign-up/email",
      body: { [key]: `  ${value}  ` },
    }, {
      getOAuthState: async () => null,
    }), value)
  }
})

test("signup invite context preserves the encoded email signup header", async () => {
  const token = "header-token+/="
  const encodedToken = Buffer.from(token, "utf8").toString("base64url")

  assert.equal(await resolveSignupInviteTokenFromAuthContext({
    path: "/sign-up/email",
    getHeader: (name: string) => name === "x-veslo-signup-invite-token" ? encodedToken : null,
  }, {
    getOAuthState: async () => null,
  }), token)
})

test("signup invite context reads only the exact direct social additionalData key", async () => {
  const resolve = (additionalData: Record<string, unknown>) => resolveSignupInviteTokenFromAuthContext({
    path: "/sign-in/social",
    body: { additionalData },
  }, {
    getOAuthState: async () => null,
  })

  assert.equal(await resolve({ vesloSignupInviteToken: " direct-token " }), "direct-token")
  assert.equal(await resolve({ inviteToken: "alias-must-not-be-read" }), null)
  assert.equal(await resolve({ vesloSignupInviteToken: 123 }), null)
})

test("signup invite context reads exact signed OAuth state only on callback paths", async () => {
  let stateReads = 0
  const getOAuthState = async () => {
    stateReads += 1
    return { vesloSignupInviteToken: " oauth-token " }
  }

  assert.equal(await resolveSignupInviteTokenFromAuthContext({
    path: "/callback/github",
  }, { getOAuthState }), "oauth-token")
  assert.equal(await resolveSignupInviteTokenFromAuthContext({
    path: "/callback/:id",
  }, { getOAuthState }), "oauth-token")
  assert.equal(stateReads, 2)

  assert.equal(await resolveSignupInviteTokenFromAuthContext({
    path: "/sign-in/email",
  }, { getOAuthState }), null)
  assert.equal(stateReads, 2)
})

test("signup invite context treats missing or malformed OAuth state as absent", async () => {
  const context = { path: "/callback/github" }
  const malformedStates: unknown[] = [
    null,
    "not-an-object",
    {},
    { vesloSignupInviteToken: "   " },
    { vesloSignupInviteToken: 42 },
  ]

  for (const state of malformedStates) {
    assert.equal(await resolveSignupInviteTokenFromAuthContext(context, {
      getOAuthState: async () => state,
    }), null)
  }

  assert.equal(await resolveSignupInviteTokenFromAuthContext(context, {
    getOAuthState: async () => {
      throw new Error("request state unavailable")
    },
  }), null)
})

test("signup invite context does not use email token aliases on unrelated paths", async () => {
  assert.equal(await resolveSignupInviteTokenFromAuthContext({
    path: "/sign-in/email",
    body: { token: "unrelated-token" },
  }, {
    getOAuthState: async () => ({ vesloSignupInviteToken: "unrelated-state-token" }),
  }), null)
})

test("auth hooks await the async invite context resolver", async () => {
  const source = await readFile(new URL("../src/auth.ts", import.meta.url), "utf8")

  assert.match(source, /inviteToken:\s*await resolveSignupInviteTokenFromAuthContext\(context\)/g)
  assert.equal(source.match(/inviteToken:\s*await resolveSignupInviteTokenFromAuthContext\(context\)/g)?.length, 2)
})
