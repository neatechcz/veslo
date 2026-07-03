import crypto, { type KeyObject } from "node:crypto"
import { and, eq } from "drizzle-orm"

import type { db as denDb } from "../db/index.js"
import { MicrosoftConnectionTable } from "../db/schema.js"
import type { MicrosoftConnectorId } from "./connectors.js"
import type { MicrosoftOAuthGrant } from "./oauth.js"

export type MicrosoftConnectionState = "connected" | "revoked" | "error"

export type MicrosoftConnection = {
  id: string
  orgId: string
  userId: string
  connectorId: MicrosoftConnectorId
  state: MicrosoftConnectionState
  scopes: string[]
  connectedAt: string
  revokedAt: string | null
  accessTokenExpiresAt: string | null
}

export type EncryptedMicrosoftGrant = {
  iv: string
  authTag: string
  ciphertext: string
}

export interface MicrosoftConnectionStore {
  upsertConnection(input: {
    orgId: string
    userId: string
    connectorId: MicrosoftConnectorId
    scopes: string[]
    grant: MicrosoftOAuthGrant
  }): Promise<MicrosoftConnection>
  listConnections(input: { orgId: string; userId: string }): Promise<MicrosoftConnection[]>
  getGrant(input: {
    orgId: string
    userId: string
    connectorId: MicrosoftConnectorId
  }): Promise<MicrosoftOAuthGrant | null>
  disconnectConnection(input: {
    orgId: string
    userId: string
    connectorId: MicrosoftConnectorId
  }): Promise<boolean>
}

export function createMicrosoftGrantEncryptionKey(secretKey: string) {
  return crypto.createSecretKey(new Uint8Array(crypto.createHash("sha256").update(secretKey).digest()))
}

export function encryptMicrosoftGrant(
  key: KeyObject,
  grant: MicrosoftOAuthGrant,
): EncryptedMicrosoftGrant {
  const iv = new Uint8Array(crypto.randomBytes(12))
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const plaintext = JSON.stringify(grant)
  const ciphertext = Buffer.concat([
    new Uint8Array(cipher.update(plaintext, "utf8")),
    new Uint8Array(cipher.final()),
  ])
  const authTag = new Uint8Array(cipher.getAuthTag())

  return {
    iv: Buffer.from(iv).toString("base64"),
    authTag: Buffer.from(authTag).toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }
}

export function decryptMicrosoftGrant(
  key: KeyObject,
  encrypted: EncryptedMicrosoftGrant,
): MicrosoftOAuthGrant {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    new Uint8Array(Buffer.from(encrypted.iv, "base64")),
  )
  decipher.setAuthTag(new Uint8Array(Buffer.from(encrypted.authTag, "base64")))

  const plaintext = Buffer.concat([
    new Uint8Array(decipher.update(new Uint8Array(Buffer.from(encrypted.ciphertext, "base64")))),
    new Uint8Array(decipher.final()),
  ]).toString("utf8")

  return JSON.parse(plaintext) as MicrosoftOAuthGrant
}

export class InMemoryMicrosoftConnectionStore implements MicrosoftConnectionStore {
  private readonly rows = new Map<string, MicrosoftConnection & { grant: MicrosoftOAuthGrant }>()

  async upsertConnection(input: {
    orgId: string
    userId: string
    connectorId: MicrosoftConnectorId
    scopes: string[]
    grant: MicrosoftOAuthGrant
  }): Promise<MicrosoftConnection> {
    const key = this.key(input)
    const existing = this.rows.get(key)
    const now = new Date().toISOString()
    const row: MicrosoftConnection & { grant: MicrosoftOAuthGrant } = {
      id: existing?.id ?? `mc_${crypto.randomUUID()}`,
      orgId: input.orgId,
      userId: input.userId,
      connectorId: input.connectorId,
      state: "connected",
      scopes: input.scopes,
      connectedAt: existing?.connectedAt ?? now,
      revokedAt: null,
      accessTokenExpiresAt: input.grant.expiresAt,
      grant: input.grant,
    }
    this.rows.set(key, row)
    return toPublicConnection(row)
  }

  async listConnections(input: { orgId: string; userId: string }): Promise<MicrosoftConnection[]> {
    return Array.from(this.rows.values())
      .filter((row) => row.orgId === input.orgId && row.userId === input.userId)
      .map(toPublicConnection)
  }

  async getGrant(input: {
    orgId: string
    userId: string
    connectorId: MicrosoftConnectorId
  }): Promise<MicrosoftOAuthGrant | null> {
    const row = this.rows.get(this.key(input))
    return row?.state === "connected" ? row.grant : null
  }

  async disconnectConnection(input: {
    orgId: string
    userId: string
    connectorId: MicrosoftConnectorId
  }): Promise<boolean> {
    const row = this.rows.get(this.key(input))
    if (!row) {
      return false
    }
    row.state = "revoked"
    row.revokedAt = new Date().toISOString()
    row.accessTokenExpiresAt = null
    row.grant = emptyRevokedGrant()
    this.rows.set(this.key(input), row)
    return true
  }

  private key(input: { orgId: string; userId: string; connectorId: MicrosoftConnectorId }) {
    return `${input.orgId}:${input.userId}:${input.connectorId}`
  }
}

export class UnavailableMicrosoftConnectionStore implements MicrosoftConnectionStore {
  async upsertConnection(): Promise<MicrosoftConnection> {
    throw new Error("microsoft_token_secret_not_configured")
  }

  async listConnections(): Promise<MicrosoftConnection[]> {
    throw new Error("microsoft_token_secret_not_configured")
  }

  async getGrant(): Promise<MicrosoftOAuthGrant | null> {
    throw new Error("microsoft_token_secret_not_configured")
  }

  async disconnectConnection(): Promise<boolean> {
    throw new Error("microsoft_token_secret_not_configured")
  }
}

export class DbMicrosoftConnectionStore implements MicrosoftConnectionStore {
  private readonly key: KeyObject
  private readonly now: () => Date

  constructor(private readonly input: {
    db: typeof denDb
    secretKey: string
    now?: () => Date
  }) {
    this.key = createMicrosoftGrantEncryptionKey(input.secretKey)
    this.now = input.now ?? (() => new Date())
  }

  async upsertConnection(input: {
    orgId: string
    userId: string
    connectorId: MicrosoftConnectorId
    scopes: string[]
    grant: MicrosoftOAuthGrant
  }): Promise<MicrosoftConnection> {
    const now = this.now()
    const encrypted = encryptMicrosoftGrant(this.key, input.grant)
    const accessTokenExpiresAt = input.grant.expiresAt ? new Date(input.grant.expiresAt) : null

    await this.input.db.insert(MicrosoftConnectionTable).values({
      id: `mc_${crypto.randomUUID()}`,
      org_id: input.orgId,
      user_id: input.userId,
      connector_id: input.connectorId,
      state: "connected",
      scopes: input.scopes.join(" "),
      access_token_expires_at: accessTokenExpiresAt,
      grant_iv: encrypted.iv,
      grant_auth_tag: encrypted.authTag,
      grant_ciphertext: encrypted.ciphertext,
      connected_at: now,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    }).onDuplicateKeyUpdate({
      set: {
        state: "connected",
        scopes: input.scopes.join(" "),
        access_token_expires_at: accessTokenExpiresAt,
        grant_iv: encrypted.iv,
        grant_auth_tag: encrypted.authTag,
        grant_ciphertext: encrypted.ciphertext,
        revoked_at: null,
        updated_at: now,
      },
    })

    const rows = await this.input.db
      .select()
      .from(MicrosoftConnectionTable)
      .where(and(
        eq(MicrosoftConnectionTable.org_id, input.orgId),
        eq(MicrosoftConnectionTable.user_id, input.userId),
        eq(MicrosoftConnectionTable.connector_id, input.connectorId),
      ))
      .limit(1)

    if (!rows[0]) {
      throw new Error("microsoft_connection_missing_after_upsert")
    }
    return rowToConnection(rows[0])
  }

  async listConnections(input: { orgId: string; userId: string }): Promise<MicrosoftConnection[]> {
    const rows = await this.input.db
      .select()
      .from(MicrosoftConnectionTable)
      .where(and(
        eq(MicrosoftConnectionTable.org_id, input.orgId),
        eq(MicrosoftConnectionTable.user_id, input.userId),
      ))

    return rows.map(rowToConnection)
  }

  async getGrant(input: {
    orgId: string
    userId: string
    connectorId: MicrosoftConnectorId
  }): Promise<MicrosoftOAuthGrant | null> {
    const rows = await this.input.db
      .select({
        grant_iv: MicrosoftConnectionTable.grant_iv,
        grant_auth_tag: MicrosoftConnectionTable.grant_auth_tag,
        grant_ciphertext: MicrosoftConnectionTable.grant_ciphertext,
      })
      .from(MicrosoftConnectionTable)
      .where(and(
        eq(MicrosoftConnectionTable.org_id, input.orgId),
        eq(MicrosoftConnectionTable.user_id, input.userId),
        eq(MicrosoftConnectionTable.connector_id, input.connectorId),
        eq(MicrosoftConnectionTable.state, "connected"),
      ))
      .limit(1)

    if (!rows[0]) {
      return null
    }

    return decryptMicrosoftGrant(this.key, {
      iv: rows[0].grant_iv,
      authTag: rows[0].grant_auth_tag,
      ciphertext: rows[0].grant_ciphertext,
    })
  }

  async disconnectConnection(input: {
    orgId: string
    userId: string
    connectorId: MicrosoftConnectorId
  }): Promise<boolean> {
    const now = this.now()
    const encrypted = encryptMicrosoftGrant(this.key, emptyRevokedGrant())
    const result = await this.input.db
      .update(MicrosoftConnectionTable)
      .set({
        state: "revoked",
        access_token_expires_at: null,
        grant_iv: encrypted.iv,
        grant_auth_tag: encrypted.authTag,
        grant_ciphertext: encrypted.ciphertext,
        revoked_at: now,
        updated_at: now,
      })
      .where(and(
        eq(MicrosoftConnectionTable.org_id, input.orgId),
        eq(MicrosoftConnectionTable.user_id, input.userId),
        eq(MicrosoftConnectionTable.connector_id, input.connectorId),
      ))

    return (getAffectedRows(result) ?? 0) > 0
  }
}

function getAffectedRows(value: unknown): number | null {
  if (Array.isArray(value) && value.length > 0) {
    return getAffectedRows(value[0])
  }

  if (!value || typeof value !== "object" || !("affectedRows" in value)) {
    return null
  }

  return typeof value.affectedRows === "number" ? value.affectedRows : null
}

function emptyRevokedGrant(): MicrosoftOAuthGrant {
  return {
    accessToken: "",
    refreshToken: "",
    expiresAt: "",
  }
}

function toPublicConnection(row: MicrosoftConnection & { grant?: MicrosoftOAuthGrant }) {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    connectorId: row.connectorId,
    state: row.state,
    scopes: row.scopes,
    connectedAt: row.connectedAt,
    revokedAt: row.revokedAt,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
  }
}

function rowToConnection(row: typeof MicrosoftConnectionTable.$inferSelect): MicrosoftConnection {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    connectorId: row.connector_id,
    state: row.state,
    scopes: row.scopes.split(" ").filter(Boolean),
    connectedAt: row.connected_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    accessTokenExpiresAt: row.access_token_expires_at ? row.access_token_expires_at.toISOString() : null,
  }
}
