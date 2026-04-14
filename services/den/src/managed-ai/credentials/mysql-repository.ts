import { and, desc, eq, inArray, ne, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"

import {
  credentialBindingTable,
  credentialHealthEventTable,
  credentialRecordTable,
  credentialUsageEventTable,
  sessionLeaseTable,
} from "../schema.js"
import type {
  CreatePlatformCredentialInput,
  CreateUserCredentialInput,
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  ListEligibleBindingsInput,
  ListUserCredentialsInput,
  MarkCredentialStateInput,
  RevokeUserCredentialInput,
} from "./repository.js"
import { formatManagedAiProviderLabel } from "../providers/ids.js"

export class MySqlCredentialRepository implements CredentialRepository {
  constructor(private readonly db: any) {}

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    const rows = await this.db
      .select()
      .from(credentialRecordTable)
      .where(eq(credentialRecordTable.id, credentialRecordId))
      .limit(1)
    const row = rows[0]

    return row ? mapCredentialRecord(row) : null
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: credentialRecordTable.id })
      .from(credentialRecordTable)
      .where(eq(credentialRecordTable.state, "healthy"))

    return rows.map((row: { id: string }) => row.id)
  }

  async listEligibleBindings(input: ListEligibleBindingsInput): Promise<CredentialBinding[]> {
    const filters = [
      eq(credentialBindingTable.owner_user_id, input.ownerUserId),
      eq(credentialBindingTable.provider, input.provider),
      eq(credentialRecordTable.state, "healthy"),
    ]

    if (input.excludeBindingId) {
      filters.push(ne(credentialBindingTable.id, input.excludeBindingId))
    }

    const rows = await this.db
      .select({
        id: credentialBindingTable.id,
        owner_user_id: credentialBindingTable.owner_user_id,
        provider: credentialBindingTable.provider,
        credential_record_id: credentialBindingTable.credential_record_id,
        created_at: credentialBindingTable.created_at,
        updated_at: credentialBindingTable.updated_at,
      })
      .from(credentialBindingTable)
      .innerJoin(credentialRecordTable, eq(credentialBindingTable.credential_record_id, credentialRecordTable.id))
      .where(and(...filters))
      .orderBy(credentialBindingTable.created_at)

    return rows.map(mapCredentialBinding)
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    const rows = await this.db
      .select({
        record: credentialRecordTable,
      })
      .from(credentialBindingTable)
      .innerJoin(credentialRecordTable, eq(credentialBindingTable.credential_record_id, credentialRecordTable.id))
      .where(eq(credentialBindingTable.id, bindingId))
      .limit(1)
    const row = rows[0]

    return row ? mapCredentialRecord(row.record) : null
  }

  async listAdminCredentials() {
    const [credentialRows, activeLeaseRows, usageRows] = await Promise.all([
      this.db.select().from(credentialRecordTable).orderBy(desc(credentialRecordTable.updated_at)),
      this.db
        .select({
          credentialRecordId: credentialBindingTable.credential_record_id,
          activeLeases: sql<number>`count(*)`,
        })
        .from(sessionLeaseTable)
        .innerJoin(credentialBindingTable, eq(sessionLeaseTable.active_binding_id, credentialBindingTable.id))
        .groupBy(credentialBindingTable.credential_record_id),
      this.db
        .select({
          credentialRecordId: credentialUsageEventTable.credential_record_id,
          totalTokens: sql<number>`coalesce(sum(${credentialUsageEventTable.input_tokens} + ${credentialUsageEventTable.output_tokens}), 0)`,
        })
        .from(credentialUsageEventTable)
        .groupBy(credentialUsageEventTable.credential_record_id),
    ])

    const activeLeasesByCredential = new Map(
      activeLeaseRows.map((row: { credentialRecordId: string; activeLeases: number }) => [
        row.credentialRecordId,
        Number(row.activeLeases ?? 0),
      ]),
    )
    const totalTokensByCredential = new Map(
      usageRows.map((row: { credentialRecordId: string; totalTokens: number }) => [
        row.credentialRecordId,
        Number(row.totalTokens ?? 0),
      ]),
    )

    return credentialRows.map((row: typeof credentialRecordTable.$inferSelect) => ({
      id: row.id,
      name: row.name?.trim() || `${formatProviderLabel(row.provider)} ${row.id}`,
      provider: row.provider,
      type: row.credential_type,
      state: row.state,
      scope: row.owner_user_id,
      activeLeases: activeLeasesByCredential.get(row.id) ?? 0,
      alertCount: 0,
      lastRefreshAt: asDate(row.updated_at).toISOString(),
      lastFailureAt: row.state === "healthy" ? null : asDate(row.updated_at).toISOString(),
      totalTokens: totalTokensByCredential.get(row.id) ?? 0,
      nextRotationAt: null,
      linkedAlertIds: [],
    }))
  }

  async createUserCredential(input: CreateUserCredentialInput): Promise<CredentialRecord> {
    return this.createCredentialRecordAndBinding({
      ownerUserId: input.ownerUserId,
      name: input.name ?? null,
      provider: input.provider,
      credentialType: input.credentialType,
      secretRef: input.secretRef,
    })
  }

  async createPlatformCredential(input: CreatePlatformCredentialInput): Promise<CredentialRecord> {
    return this.createCredentialRecordAndBinding({
      ownerUserId: input.ownerUserId,
      name: input.name,
      provider: input.provider,
      credentialType: input.credentialType,
      secretRef: input.secretRef,
    })
  }

  private async createCredentialRecordAndBinding(input: {
    ownerUserId: string
    name: string | null
    provider: string
    credentialType: "api_key" | "oauth"
    secretRef: string
  }): Promise<CredentialRecord> {
    const createdAt = new Date()
    const record: CredentialRecord = {
      id: `cred_${randomUUID()}`,
      name: input.name,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      credentialType: input.credentialType,
      state: "healthy",
      secretRef: input.secretRef,
      createdAt,
      updatedAt: createdAt,
      lastFailureAt: null,
    }
    const binding: CredentialBinding = {
      id: `binding_${randomUUID()}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      credentialRecordId: record.id,
      createdAt,
      updatedAt: createdAt,
    }

    await this.db.insert(credentialRecordTable).values({
      id: record.id,
      name: record.name,
      owner_user_id: record.ownerUserId,
      provider: record.provider,
      credential_type: record.credentialType,
      state: record.state,
      secret_ref: record.secretRef,
      created_at: createdAt,
      updated_at: createdAt,
    })
    await this.db.insert(credentialBindingTable).values({
      id: binding.id,
      owner_user_id: binding.ownerUserId,
      provider: binding.provider,
      credential_record_id: binding.credentialRecordId,
      created_at: createdAt,
      updated_at: createdAt,
    })

    return record
  }

  async listUserCredentials(input: ListUserCredentialsInput): Promise<CredentialRecord[]> {
    const rows = await this.db
      .select()
      .from(credentialRecordTable)
      .where(
        and(
          eq(credentialRecordTable.owner_user_id, input.ownerUserId),
          eq(credentialRecordTable.provider, input.provider),
        ),
      )
      .orderBy(desc(credentialRecordTable.created_at))

    return rows.map(mapCredentialRecord)
  }

  async revokeUserCredential(input: RevokeUserCredentialInput): Promise<CredentialRecord | null> {
    const existing = await this.db
      .select()
      .from(credentialRecordTable)
      .where(
        and(
          eq(credentialRecordTable.id, input.credentialId),
          eq(credentialRecordTable.owner_user_id, input.ownerUserId),
          eq(credentialRecordTable.provider, input.provider),
        ),
      )
      .limit(1)
    const row = existing[0]

    if (!row) {
      return null
    }

    const updatedAt = new Date()
    await this.db
      .update(credentialRecordTable)
      .set({
        state: "revoked",
        updated_at: updatedAt,
      })
      .where(eq(credentialRecordTable.id, input.credentialId))

    return mapCredentialRecord({
      ...row,
      state: "revoked",
      updated_at: updatedAt,
    })
  }

  async revokeCredential(credentialId: string): Promise<boolean> {
    return this.transitionCredentialState(credentialId, "revoked", "admin_revoke")
  }

  async drainCredential(credentialId: string): Promise<boolean> {
    return this.transitionCredentialState(credentialId, "draining", "admin_drain")
  }

  async rotateCredential(credentialId: string): Promise<boolean> {
    const credential = await this.getCredential(credentialId)
    if (!credential) {
      return false
    }

    const targetBindings = await this.db
      .select({ id: credentialBindingTable.id })
      .from(credentialBindingTable)
      .where(eq(credentialBindingTable.credential_record_id, credentialId))
      .orderBy(credentialBindingTable.created_at)
    const targetBindingIds = targetBindings.map((binding: { id: string }) => binding.id)

    if (targetBindingIds.length > 0) {
      const replacements = await this.db
        .select({ id: credentialBindingTable.id })
        .from(credentialBindingTable)
        .innerJoin(credentialRecordTable, eq(credentialBindingTable.credential_record_id, credentialRecordTable.id))
        .where(
          and(
            eq(credentialBindingTable.owner_user_id, credential.owner_user_id),
            eq(credentialBindingTable.provider, credential.provider),
            ne(credentialBindingTable.credential_record_id, credentialId),
            eq(credentialRecordTable.state, "healthy"),
          ),
        )
        .orderBy(credentialBindingTable.created_at)

      if (replacements.length > 0) {
        const activeLeases = await this.db
          .select({ id: sessionLeaseTable.id })
          .from(sessionLeaseTable)
          .where(inArray(sessionLeaseTable.active_binding_id, targetBindingIds))
          .orderBy(sessionLeaseTable.session_id)

        await Promise.all(
          activeLeases.map((lease: { id: string }, index: number) =>
            this.db
              .update(sessionLeaseTable)
              .set({
                active_binding_id: replacements[index % replacements.length]!.id,
                updated_at: new Date(),
              })
              .where(eq(sessionLeaseTable.id, lease.id)),
          ),
        )
      }
    }

    return this.transitionCredentialState(credentialId, "draining", "admin_rotate", credential)
  }

  async markCredentialState(input: MarkCredentialStateInput): Promise<void> {
    const current = await this.getCredentialRecordById(input.credentialRecordId)
    if (!current) {
      return
    }

    const updatedAt = new Date()
    await this.db
      .update(credentialRecordTable)
      .set({
        state: input.state,
        updated_at: updatedAt,
      })
      .where(eq(credentialRecordTable.id, input.credentialRecordId))
    await this.db.insert(credentialHealthEventTable).values({
      id: `health_${randomUUID()}`,
      credential_record_id: input.credentialRecordId,
      from_state: current.state,
      to_state: input.state,
      reason: input.reason ?? null,
      created_at: updatedAt,
    })
  }

  private async transitionCredentialState(
    credentialId: string,
    nextState: CredentialRecord["state"],
    reason: string,
    loadedCredential: typeof credentialRecordTable.$inferSelect | null = null,
  ): Promise<boolean> {
    const credential = loadedCredential ?? await this.getCredential(credentialId)
    if (!credential) {
      return false
    }

    const previousState = credential.state
    const now = new Date()

    await this.db
      .update(credentialRecordTable)
      .set({
        state: nextState,
        updated_at: now,
      })
      .where(eq(credentialRecordTable.id, credentialId))

    await this.db.insert(credentialHealthEventTable).values({
      id: `health_${randomUUID()}`,
      credential_record_id: credentialId,
      from_state: previousState,
      to_state: nextState,
      reason,
      created_at: now,
    })

    return true
  }

  private async getCredential(credentialId: string) {
    const rows = await this.db
      .select()
      .from(credentialRecordTable)
      .where(eq(credentialRecordTable.id, credentialId))
      .limit(1)

    return rows[0] ?? null
  }
}

function mapCredentialRecord(row: typeof credentialRecordTable.$inferSelect): CredentialRecord {
  const updatedAt = asDate(row.updated_at)

  return {
    id: row.id,
    name: row.name ?? null,
    ownerUserId: row.owner_user_id,
    provider: row.provider,
    credentialType: row.credential_type,
    state: row.state,
    secretRef: row.secret_ref,
    createdAt: asDate(row.created_at),
    updatedAt,
    lastFailureAt: row.state === "healthy" ? null : updatedAt,
  }
}

function mapCredentialBinding(row: {
  id: string
  owner_user_id: string
  provider: string
  credential_record_id: string
  created_at: Date | string
  updated_at: Date | string
}): CredentialBinding {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    provider: row.provider,
    credentialRecordId: row.credential_record_id,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function formatProviderLabel(provider: string) {
  return formatManagedAiProviderLabel(provider)
}
