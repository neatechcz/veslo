import test from "node:test"
import assert from "node:assert/strict"

import { DefaultMicrosoftOAuthClient } from "../src/microsoft/oauth.js"

test("Microsoft OAuth startAuthorization builds an organizations authorize URL", async () => {
  const client = new DefaultMicrosoftOAuthClient({
    clientId: "client-id",
    clientSecret: "client-secret",
  })

  const result = await client.startAuthorization({
    state: "state-123",
    scopes: ["openid", "offline_access", "https://graph.microsoft.com/Sites.Read.All"],
    redirectUri: "https://api.example/v1/integrations/microsoft/oauth/callback",
    connectorId: "microsoft-sharepoint",
  })

  const url = new URL(result.authorizeUrl)
  assert.equal(url.origin, "https://login.microsoftonline.com")
  assert.equal(url.pathname, "/organizations/oauth2/v2.0/authorize")
  assert.equal(url.searchParams.get("client_id"), "client-id")
  assert.equal(url.searchParams.get("response_type"), "code")
  assert.equal(url.searchParams.get("redirect_uri"), "https://api.example/v1/integrations/microsoft/oauth/callback")
  assert.equal(url.searchParams.get("state"), "state-123")
  assert.equal(url.searchParams.get("response_mode"), "query")
  assert.equal(url.searchParams.get("prompt"), "consent")
  assert.equal(url.searchParams.get("scope"), "openid offline_access https://graph.microsoft.com/Sites.Read.All")
})

test("Microsoft OAuth exchangeCode parses token responses", async () => {
  const client = new DefaultMicrosoftOAuthClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    now: () => new Date("2026-07-02T12:00:00.000Z"),
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://login.microsoftonline.com/organizations/oauth2/v2.0/token")
      assert.equal(init?.method, "POST")
      const body = init?.body as URLSearchParams
      assert.equal(body.get("grant_type"), "authorization_code")
      assert.equal(body.get("client_id"), "client-id")
      assert.equal(body.get("client_secret"), "client-secret")
      assert.equal(body.get("code"), "code-123")
      return new Response(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "Sites.Read.All Files.Read.All",
      }), { status: 200, headers: { "content-type": "application/json" } })
    },
  })

  const grant = await client.exchangeCode({
    code: "code-123",
    redirectUri: "https://api.example/callback",
    connectorId: "microsoft-sharepoint",
    scopes: ["https://graph.microsoft.com/Sites.Read.All"],
  })

  assert.deepEqual(grant, {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: "2026-07-02T13:00:00.000Z",
    scope: "Sites.Read.All Files.Read.All",
  })
})

test("Microsoft OAuth refresh preserves existing refresh token when response omits one", async () => {
  const client = new DefaultMicrosoftOAuthClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    now: () => new Date("2026-07-02T12:00:00.000Z"),
    fetchImpl: async () => new Response(JSON.stringify({
      access_token: "new-access-token",
      expires_in: 1800,
    }), { status: 200, headers: { "content-type": "application/json" } }),
  })

  const grant = await client.refreshToken({
    refreshToken: "existing-refresh-token",
    connectorId: "microsoft-sharepoint",
  })

  assert.equal(grant.accessToken, "new-access-token")
  assert.equal(grant.refreshToken, "existing-refresh-token")
  assert.equal(grant.expiresAt, "2026-07-02T12:30:00.000Z")
})
