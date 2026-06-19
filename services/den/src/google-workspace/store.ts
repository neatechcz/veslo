import crypto, { type KeyObject } from "node:crypto"
import { and, eq } from "drizzle-orm"

import type { db as denDb } from "../db/index.js"
import { GoogleWorkspaceConnectionTable } from "../db/schema.js"
import type { GoogleWorkspaceConnectorId } from "./connectors.js"
import type { GoogleWorkspaceOAuthGrant } from "./oauth.js"

export type GoogleWorkspaceConnectionState = "connected" | "revoked" | "error"

export type GoogleWorkspaceConnection = {
  id: string
  orgId: string
  userId: string
  connectorId: GoogleWorkspaceConnectorId
  state: GoogleWorkspaceConnectionState
  scopes: string[]
  connectedAt: string
  revokedAt: string | null
  accessTokenExpiresAt: string | null
}

export type EncryptedGoogleWorkspaceGrant = {
  iv: string
  authTag: string
  ciphertext: string
}

export interface GoogleWorkspaceConnectionStore {
  upsertConnection(input: {
    orgId: string
    userId: string
    connectorId: GoogleWorkspaceConnectorId
    scopes: string[]
    grant: GoogleWorkspaceOAuthGrant
  }): Promise<GoogleWorkspaceConnection>
  listConnections(input: { orgId: string; userId: string }): Promise<GoogleWorkspaceConnection[]>
  getGrant(input: {
    orgId: string
    userId: string
    connectorId: GoogleWorkspaceConnectorId
  }): Promise<GoogleWorkspaceOAuthGrant | null>
  disconnectConnection(input: {
    orgId: string
    userId: string
    connectorId: GoogleWorkspaceConnectorId
  }): Promise<boolean>
}

export function createGoogleWorkspaceGrantEncryptionKey(secretKey: string) {
  return crypto.createSecretKey(new Uint8Array(crypto.createHash("sha256").update(secretKey).digest()))
}

export function encryptGoogleWorkspaceGrant(
  key: KeyObject,
  grant: GoogleWorkspaceOAuthGrant,
): EncryptedGoogleWorkspaceGrant {
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

export function decryptGoogleWorkspaceGrant(
  key: KeyObject,
  encrypted: EncryptedGoogleWorkspaceGrant,
): GoogleWorkspaceOAuthGrant {
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

  return JSON.parse(plaintext) as GoogleWorkspaceOAuthGrant
}

export class InMemoryGoogleWorkspaceConnectionStore implements GoogleWorkspaceConnectionStore {
  private readonly rows = new Map<string, GoogleWorkspaceConnection & { grant: GoogleWorkspaceOAuthGrant }>()

  async upsertConnection(input: {
    orgId: string
    userId: string
    connectorId: GoogleWorkspaceConnectorId
    scopes: string[]
    grant: GoogleWorkspaceOAuthGrant
  }): Promise<GoogleWorkspaceConnection> {
    const key = this.key(input)
    const existing = this.rows.get(key)
    const now = new Date().toISOString()
    const row: GoogleWorkspaceConnection & { grant: GoogleWorkspaceOAuthGrant } = {
      id: existing?.id ?? `gwc_${crypto.randomUUID()}`,
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

  async listConnections(input: { orgId: string; userId: string }): Promise<GoogleWorkspaceConnection[]> {
    return Array.from(this.rows.values())
      .filter((row) => row.orgId === input.orgId && row.userId === input.userId)
      .map(toPublicConnection)
  }

  async getGrant(input: {
    orgId: string
    userId: string
    connectorId: GoogleWorkspaceConnectorId
  }): Promise<GoogleWorkspaceOAuthGrant | null> {
    const row = this.rows.get(this.key(input))
    return row?.grant ?? null
  }

  async disconnectConnection(input: {
    orgId: string
    userId: string
    connectorId: GoogleWorkspaceConnectorId
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

  private key(input: { orgId: string; userId: string; connectorId: GoogleWorkspaceConnectorId }) {
    return `${input.orgId}:${input.userId}:${input.connectorId}`
  }
}

export class UnavailableGoogleWorkspaceConnectionStore implements GoogleWorkspaceConnectionStore {
  async upsertConnection(): Promise<GoogleWorkspaceConnection> {
    throw new Error("google_workspace_token_secret_not_configured")
  }

  async listConnections(): Promise<GoogleWorkspaceConnection[]> {
    return []
  }

  async getGrant(): Promise<GoogleWorkspaceOAuthGrant | null> {
    return null
  }

  async disconnectConnection(): Promise<boolean> {
    return false
  }
}

export class DbGoogleWorkspaceConnectionStore implements GoogleWorkspaceConnectionStore {
  private readonly key: KeyObject
  private readonly now: () => Date

  constructor(private readonly input: {
    db: typeof denDb
    secretKey: string
    now?: () => Date
  }) {
    this.key = createGoogleWorkspaceGrantEncryptionKey(input.secretKey)
    this.now = input.now ?? (() => new Date())
  }

  async upsertConnection(input: {
    orgId: string
    userId: string
    connectorId: GoogleWorkspaceConnectorId
    scopes: string[]
    grant: GoogleWorkspaceOAuthGrant
  }): Promise<GoogleWorkspaceConnection> {
    const now = this.now()
    const encrypted = encryptGoogleWorkspaceGrant(this.key, input.grant)
    const accessTokenExpiresAt = input.grant.expiresAt ? new Date(input.grant.expiresAt) : null

    await this.input.db.insert(GoogleWorkspaceConnectionTable).values({
      id: `gwc_${crypto.randomUUID()}`,
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
      .from(GoogleWorkspaceConnectionTable)
      .where(and(
        eq(GoogleWorkspaceConnectionTable.org_id, input.orgId),
        eq(GoogleWorkspaceConnectionTable.user_id, input.userId),
        eq(GoogleWorkspaceConnectionTable.connector_id, input.connectorId),
      ))
      .limit(1)

    if (!rows[0]) {
      throw new Error("google_workspace_connection_missing_after_upsert")
    }
    return rowToConnection(rows[0])
  }

  async listConnections(input: { orgId: string; userId: string }): Promise<GoogleWorkspaceConnection[]> {
    const rows = await this.input.db
      .select()
      .from(GoogleWorkspaceConnectionTable)
      .where(and(
        eq(GoogleWorkspaceConnectionTable.org_id, input.orgId),
        eq(GoogleWorkspaceConnectionTable.user_id, input.userId),
      ))

    return rows.map(rowToConnection)
  }

  async getGrant(input: {
    orgId: string
    userId: string
    connectorId: GoogleWorkspaceConnectorId
  }): Promise<GoogleWorkspaceOAuthGrant | null> {
    const rows = await this.input.db
      .select({
        grant_iv: GoogleWorkspaceConnectionTable.grant_iv,
        grant_auth_tag: GoogleWorkspaceConnectionTable.grant_auth_tag,
        grant_ciphertext: GoogleWorkspaceConnectionTable.grant_ciphertext,
      })
      .from(GoogleWorkspaceConnectionTable)
      .where(and(
        eq(GoogleWorkspaceConnectionTable.org_id, input.orgId),
        eq(GoogleWorkspaceConnectionTable.user_id, input.userId),
        eq(GoogleWorkspaceConnectionTable.connector_id, input.connectorId),
        eq(GoogleWorkspaceConnectionTable.state, "connected"),
      ))
      .limit(1)

    if (!rows[0]) {
      return null
    }

    return decryptGoogleWorkspaceGrant(this.key, {
      iv: rows[0].grant_iv,
      authTag: rows[0].grant_auth_tag,
      ciphertext: rows[0].grant_ciphertext,
    })
  }

  async disconnectConnection(input: {
    orgId: string
    userId: string
    connectorId: GoogleWorkspaceConnectorId
  }): Promise<boolean> {
    const now = this.now()
    const encrypted = encryptGoogleWorkspaceGrant(this.key, emptyRevokedGrant())
    await this.input.db
      .update(GoogleWorkspaceConnectionTable)
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
        eq(GoogleWorkspaceConnectionTable.org_id, input.orgId),
        eq(GoogleWorkspaceConnectionTable.user_id, input.userId),
        eq(GoogleWorkspaceConnectionTable.connector_id, input.connectorId),
      ))

    return true
  }
}

function emptyRevokedGrant(): GoogleWorkspaceOAuthGrant {
  return {
    accessToken: "",
    refreshToken: "",
    expiresAt: "",
  }
}

function toPublicConnection(row: GoogleWorkspaceConnection & { grant?: GoogleWorkspaceOAuthGrant }) {
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

function rowToConnection(row: typeof GoogleWorkspaceConnectionTable.$inferSelect): GoogleWorkspaceConnection {
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
