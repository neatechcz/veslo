import assert from "node:assert/strict"
import test from "node:test"

import {
  createSignedMicrosoftOAuthState,
  createSignedMicrosoftRuntimeToken,
  verifySignedMicrosoftOAuthState,
  verifySignedMicrosoftRuntimeToken,
} from "../src/microsoft/state.js"

test("Microsoft OAuth state verifies organization, user, connector, and redirect URI", () => {
  const state = createSignedMicrosoftOAuthState({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    redirectUri: "https://api.example/v1/integrations/microsoft/oauth/callback",
    secret: "microsoft_state_secret",
    now: () => 1_781_000_000_000,
    randomUUID: () => "nonce-1",
  })

  assert.deepEqual(verifySignedMicrosoftOAuthState(state, {
    secret: "microsoft_state_secret",
    now: () => 1_781_000_001_000,
  }), {
    v: 1,
    nonce: "nonce-1",
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    redirectUri: "https://api.example/v1/integrations/microsoft/oauth/callback",
    issuedAt: 1_781_000_000_000,
    expiresAt: 1_781_000_900_000,
  })
})

test("Microsoft OAuth state fails with the wrong secret", () => {
  const state = createSignedMicrosoftOAuthState({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    redirectUri: "https://api.example/v1/integrations/microsoft/oauth/callback",
    secret: "microsoft_state_secret",
    now: () => 1_781_000_000_000,
    randomUUID: () => "nonce-1",
  })

  assert.equal(verifySignedMicrosoftOAuthState(state, {
    secret: "wrong_secret",
    now: () => 1_781_000_001_000,
  }), null)
})

test("Microsoft OAuth state rejects trailing token segments and exact expiry", () => {
  const state = createSignedMicrosoftOAuthState({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    redirectUri: "https://api.example/v1/integrations/microsoft/oauth/callback",
    secret: "microsoft_state_secret",
    now: () => 1_781_000_000_000,
    randomUUID: () => "nonce-1",
  })

  assert.equal(verifySignedMicrosoftOAuthState(`${state}.extra`, {
    secret: "microsoft_state_secret",
    now: () => 1_781_000_001_000,
  }), null)
  assert.equal(verifySignedMicrosoftOAuthState(state, {
    secret: "microsoft_state_secret",
    now: () => 1_781_000_900_000,
  }), null)
})

test("Microsoft runtime token verifies organization, user, connector, and expiry", () => {
  const token = createSignedMicrosoftRuntimeToken({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    secret: "microsoft_runtime_secret",
    ttlMs: 60_000,
    now: () => 1_781_000_000_000,
    randomUUID: () => "runtime-nonce-1",
  })

  assert.deepEqual(verifySignedMicrosoftRuntimeToken(token, {
    secret: "microsoft_runtime_secret",
    now: () => 1_781_000_030_000,
  }), {
    v: 1,
    kind: "microsoft-runtime",
    nonce: "runtime-nonce-1",
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    issuedAt: 1_781_000_000_000,
    expiresAt: 1_781_000_060_000,
  })
})

test("Microsoft runtime token fails after expiry", () => {
  const token = createSignedMicrosoftRuntimeToken({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    secret: "microsoft_runtime_secret",
    ttlMs: 60_000,
    now: () => 1_781_000_000_000,
    randomUUID: () => "runtime-nonce-1",
  })

  assert.equal(verifySignedMicrosoftRuntimeToken(token, {
    secret: "microsoft_runtime_secret",
    now: () => 1_781_000_060_001,
  }), null)
})

test("Microsoft runtime token rejects trailing token segments and exact expiry", () => {
  const token = createSignedMicrosoftRuntimeToken({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    secret: "microsoft_runtime_secret",
    ttlMs: 60_000,
    now: () => 1_781_000_000_000,
    randomUUID: () => "runtime-nonce-1",
  })

  assert.equal(verifySignedMicrosoftRuntimeToken(`${token}.extra`, {
    secret: "microsoft_runtime_secret",
    now: () => 1_781_000_030_000,
  }), null)
  assert.equal(verifySignedMicrosoftRuntimeToken(token, {
    secret: "microsoft_runtime_secret",
    now: () => 1_781_000_060_000,
  }), null)
})
