import { and, desc, eq } from "drizzle-orm"

import { credentialBindingTable, sessionLeaseTable } from "../schema.js"
import type {
  AdminSessionRecord,
  CreateSessionLeaseInput,
  LeaseProvider,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "./repository.js"

export class MySqlLeaseRepository implements LeaseRepository {
  constructor(private readonly db: any) {}

  async getActiveLease(input: ResolveLeaseInput): Promise<SessionLease | null> {
    const rows = await this.db
      .select()
      .from(sessionLeaseTable)
      .where(
        and(
          eq(sessionLeaseTable.owner_user_id, input.ownerUserId),
          eq(sessionLeaseTable.provider, input.provider),
          eq(sessionLeaseTable.session_id, input.sessionId),
        ),
      )
      .limit(1)

    const row = rows[0]
    return row ? mapSessionLease(row) : null
  }

  async createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease> {
    const existing = await this.getActiveLease(input)
    if (existing) {
      return existing
    }

    const createdAt = new Date()
    await this.db.insert(sessionLeaseTable).values({
      id: createLeaseId(input),
      owner_user_id: input.ownerUserId,
      provider: input.provider,
      session_id: input.sessionId,
      active_binding_id: input.activeBindingId,
      created_at: createdAt,
      updated_at: createdAt,
    })

    return (
      (await this.getActiveLease(input)) ?? {
        id: createLeaseId(input),
        ownerUserId: input.ownerUserId,
        provider: input.provider,
        sessionId: input.sessionId,
        activeBindingId: input.activeBindingId,
      }
    )
  }

  async rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    const current = await this.getActiveLease(input)
    if (!current || current.activeBindingId !== input.expectedCurrentBindingId) {
      return null
    }

    await this.db
      .update(sessionLeaseTable)
      .set({
        active_binding_id: input.nextBindingId,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(sessionLeaseTable.owner_user_id, input.ownerUserId),
          eq(sessionLeaseTable.provider, input.provider),
          eq(sessionLeaseTable.session_id, input.sessionId),
        ),
      )

    return this.getActiveLease(input)
  }

  async listAdminSessions(): Promise<AdminSessionRecord[]> {
    const rows = await this.db
      .select({
        id: sessionLeaseTable.id,
        sessionId: sessionLeaseTable.session_id,
        provider: sessionLeaseTable.provider,
        ownerUserId: sessionLeaseTable.owner_user_id,
        activeBindingId: sessionLeaseTable.active_binding_id,
        credentialRecordId: credentialBindingTable.credential_record_id,
        updatedAt: sessionLeaseTable.updated_at,
      })
      .from(sessionLeaseTable)
      .leftJoin(credentialBindingTable, eq(sessionLeaseTable.active_binding_id, credentialBindingTable.id))
      .orderBy(desc(sessionLeaseTable.updated_at))

    return rows.map((row: {
      id: string
      sessionId: string
      provider: string
      ownerUserId: string
      activeBindingId: string
      credentialRecordId: string | null
      updatedAt: Date | string
    }) => ({
      id: row.id,
      sessionId: row.sessionId,
      provider: row.provider as LeaseProvider,
      userLabel: row.ownerUserId,
      orgLabel: "Personal",
      projectLabel: row.sessionId,
      workerLabel: "local-runtime",
      credentialId: row.credentialRecordId ?? row.activeBindingId,
      state: "healthy",
      retries: 0,
      lastSeenAt: asDate(row.updatedAt).toISOString(),
      lastFailoverAt: null,
    }))
  }
}

function mapSessionLease(row: typeof sessionLeaseTable.$inferSelect): SessionLease {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    provider: row.provider as LeaseProvider,
    sessionId: row.session_id,
    activeBindingId: row.active_binding_id,
  }
}

function createLeaseId(input: ResolveLeaseInput): string {
  return `lease_${input.ownerUserId}_${input.provider}_${input.sessionId}`
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
