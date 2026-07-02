import assert from "node:assert/strict"
import test from "node:test"

import {
  createMicrosoftGrantEncryptionKey,
  decryptMicrosoftGrant,
  encryptMicrosoftGrant,
  InMemoryMicrosoftConnectionStore,
} from "../src/microsoft/store.js"

const grant = {
  accessToken: "microsoft_access_token",
  refreshToken: "microsoft_refresh_token",
  expiresAt: "2030-07-02T12:00:00.000Z",
  scope: "https://graph.microsoft.com/Files.Read.All https://graph.microsoft.com/Sites.Read.All",
}

test("in-memory Microsoft connection store upserts, lists, gets grants, and disconnects", async () => {
  const store = new InMemoryMicrosoftConnectionStore()

  const created = await store.upsertConnection({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    scopes: [
      "https://graph.microsoft.com/Files.Read.All",
      "https://graph.microsoft.com/Sites.Read.All",
    ],
    grant,
  })

  assert.equal(created.orgId, "org_1")
  assert.equal(created.userId, "user_1")
  assert.equal(created.connectorId, "microsoft-sharepoint")
  assert.equal(created.state, "connected")
  assert.deepEqual(created.scopes, [
    "https://graph.microsoft.com/Files.Read.All",
    "https://graph.microsoft.com/Sites.Read.All",
  ])
  assert.equal(created.accessTokenExpiresAt, "2030-07-02T12:00:00.000Z")
  assert.equal(created.revokedAt, null)

  const updated = await store.upsertConnection({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    scopes: ["https://graph.microsoft.com/Sites.Read.All"],
    grant: {
      ...grant,
      accessToken: "updated_microsoft_access_token",
      expiresAt: "2030-07-02T13:00:00.000Z",
      scope: "https://graph.microsoft.com/Sites.Read.All",
    },
  })

  assert.equal(updated.id, created.id)
  assert.deepEqual(await store.listConnections({ orgId: "org_1", userId: "user_1" }), [updated])
  assert.deepEqual(await store.getGrant({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
  }), {
    ...grant,
    accessToken: "updated_microsoft_access_token",
    expiresAt: "2030-07-02T13:00:00.000Z",
    scope: "https://graph.microsoft.com/Sites.Read.All",
  })

  assert.equal(await store.disconnectConnection({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
  }), true)

  const [revoked] = await store.listConnections({ orgId: "org_1", userId: "user_1" })
  assert.equal(revoked?.id, created.id)
  assert.equal(revoked?.state, "revoked")
  assert.equal(revoked?.accessTokenExpiresAt, null)
  assert.match(revoked?.revokedAt ?? "", /^\d{4}-\d{2}-\d{2}T/)
})

test("Microsoft grant encryption decrypts back to the original grant without plaintext token storage", () => {
  const key = createMicrosoftGrantEncryptionKey("microsoft_secret_key_01234567890123456789")
  const encrypted = encryptMicrosoftGrant(key, grant)

  const serialized = JSON.stringify(encrypted)
  assert.doesNotMatch(serialized, /microsoft_access_token/)
  assert.doesNotMatch(serialized, /microsoft_refresh_token/)
  assert.deepEqual(decryptMicrosoftGrant(key, encrypted), grant)
})

test("disconnected Microsoft rows are revoked and expose no usable grant", async () => {
  const store = new InMemoryMicrosoftConnectionStore()
  await store.upsertConnection({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    scopes: ["https://graph.microsoft.com/Sites.Read.All"],
    grant,
  })

  await store.disconnectConnection({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
  })

  const [connection] = await store.listConnections({ orgId: "org_1", userId: "user_1" })
  assert.equal(connection?.state, "revoked")
  assert.equal(await store.getGrant({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
  }), null)
})
