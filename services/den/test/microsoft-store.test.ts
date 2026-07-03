import assert from "node:assert/strict"
import test from "node:test"

import {
  createMicrosoftGrantEncryptionKey,
  DbMicrosoftConnectionStore,
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

test("DB Microsoft connection store returns false when disconnect affects no rows", async () => {
  const fakeDb = new FakeMicrosoftConnectionDb()
  const store = new DbMicrosoftConnectionStore({
    db: fakeDb.asDb(),
    secretKey: "microsoft_secret_key_01234567890123456789",
    now: () => new Date("2026-07-02T12:00:00.000Z"),
  })

  assert.equal(await store.disconnectConnection({
    orgId: "org_missing",
    userId: "user_missing",
    connectorId: "microsoft-sharepoint",
  }), false)
})

test("DB Microsoft connection store upserts encrypted grants and hides revoked grants", async () => {
  const fakeDb = new FakeMicrosoftConnectionDb()
  const store = new DbMicrosoftConnectionStore({
    db: fakeDb.asDb(),
    secretKey: "microsoft_secret_key_01234567890123456789",
    now: () => new Date("2026-07-02T12:00:00.000Z"),
  })

  const created = await store.upsertConnection({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    scopes: ["https://graph.microsoft.com/Sites.Read.All"],
    grant,
  })

  assert.equal(created.state, "connected")
  assert.equal(fakeDb.rows.length, 1)
  assert.doesNotMatch(fakeDb.rows[0]?.grant_ciphertext ?? "", /microsoft_access_token/)
  assert.deepEqual(await store.getGrant({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
  }), grant)

  await store.upsertConnection({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
    scopes: ["https://graph.microsoft.com/Files.Read.All"],
    grant: {
      ...grant,
      accessToken: "updated_microsoft_access_token",
      expiresAt: "2030-07-02T13:00:00.000Z",
      scope: "https://graph.microsoft.com/Files.Read.All",
    },
  })

  assert.equal(fakeDb.rows.length, 1)
  assert.deepEqual(await store.getGrant({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
  }), {
    ...grant,
    accessToken: "updated_microsoft_access_token",
    expiresAt: "2030-07-02T13:00:00.000Z",
    scope: "https://graph.microsoft.com/Files.Read.All",
  })

  assert.equal(await store.disconnectConnection({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
  }), true)
  assert.equal(fakeDb.rows[0]?.state, "revoked")
  assert.equal(await store.getGrant({
    orgId: "org_1",
    userId: "user_1",
    connectorId: "microsoft-sharepoint",
  }), null)
})

type FakeMicrosoftConnectionRow = {
  id: string
  org_id: string
  user_id: string
  connector_id: "microsoft-sharepoint"
  state: "connected" | "revoked" | "error"
  scopes: string
  access_token_expires_at: Date | null
  grant_iv: string
  grant_auth_tag: string
  grant_ciphertext: string
  connected_at: Date
  revoked_at: Date | null
  created_at: Date
  updated_at: Date
}

class FakeMicrosoftConnectionDb {
  readonly rows: FakeMicrosoftConnectionRow[] = []

  asDb() {
    return this as unknown as ConstructorParameters<typeof DbMicrosoftConnectionStore>[0]["db"]
  }

  insert() {
    return {
      values: (row: FakeMicrosoftConnectionRow) => ({
        onDuplicateKeyUpdate: async ({ set }: { set: Partial<FakeMicrosoftConnectionRow> }) => {
          const existing = this.findRow(row)
          if (existing) {
            Object.assign(existing, set)
          } else {
            this.rows.push({ ...row })
          }
          return [{ affectedRows: 1 }]
        },
      }),
    }
  }

  update() {
    return {
      set: (patch: Partial<FakeMicrosoftConnectionRow>) => ({
        where: async () => {
          if (this.rows.length === 0) {
            return [{ affectedRows: 0 }]
          }

          for (const row of this.rows) {
            Object.assign(row, patch)
          }
          return [{ affectedRows: this.rows.length }]
        },
      }),
    }
  }

  select(selection?: Record<string, unknown>) {
    return {
      from: () => ({
        where: () => this.queryResult(Boolean(selection && "grant_iv" in selection)),
      }),
    }
  }

  private queryResult(grantOnly: boolean) {
    const rows = grantOnly
      ? this.rows
        .filter((row) => row.state === "connected")
        .map((row) => ({
          grant_iv: row.grant_iv,
          grant_auth_tag: row.grant_auth_tag,
          grant_ciphertext: row.grant_ciphertext,
        }))
      : this.rows
    return Object.assign([...rows], {
      limit: async (count: number) => rows.slice(0, count),
    })
  }

  private findRow(row: Pick<FakeMicrosoftConnectionRow, "org_id" | "user_id" | "connector_id">) {
    return this.rows.find((candidate) =>
      candidate.org_id === row.org_id &&
      candidate.user_id === row.user_id &&
      candidate.connector_id === row.connector_id
    )
  }
}
