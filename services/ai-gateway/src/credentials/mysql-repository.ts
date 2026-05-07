import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import type { AiGatewayDb } from "../db/index.js";
import {
  credentialBindingTable,
  credentialHealthEventTable,
  credentialRecordTable,
  credentialUsageEventTable,
  sessionLeaseTable,
} from "../db/schema.js";
import type {
  ActiveCredentialLeaseRecord,
  AdminCredentialRecord,
  CreatePlatformCredentialInput,
  CreateUserCredentialInput,
  CredentialBinding,
  CredentialRecord,
  CredentialRepository,
  ListEligibleBindingsInput,
  ListRecentCredentialUsageInput,
  ListUserCredentialsInput,
  MarkCredentialStateInput,
  RecentCredentialUsageRecord,
  RevokeUserCredentialInput,
} from "./repository.js";
import { formatAiGatewayProviderLabel } from "../providers/ids.js";

export class MySqlCredentialRepository implements CredentialRepository {
  constructor(private readonly db: AiGatewayDb) {}

  async getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null> {
    const rows = await this.db
      .select()
      .from(credentialRecordTable)
      .where(eq(credentialRecordTable.id, credentialRecordId))
      .limit(1);
    const row = rows[0];

    return row ? mapCredentialRecord(row) : null;
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: credentialRecordTable.id })
      .from(credentialRecordTable)
      .where(eq(credentialRecordTable.state, "healthy"));

    return rows.map((row) => row.id);
  }

  async listEligibleBindings(input: ListEligibleBindingsInput): Promise<CredentialBinding[]> {
    const filters = [
      eq(credentialBindingTable.owner_user_id, input.ownerUserId),
      eq(credentialBindingTable.provider, input.provider),
      eq(credentialRecordTable.state, "healthy"),
    ];

    if (input.excludeBindingId) {
      filters.push(ne(credentialBindingTable.id, input.excludeBindingId));
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
      .orderBy(credentialBindingTable.created_at);

    return rows.map(mapCredentialBinding);
  }

  async listActiveLeasesByCredential(credentialIds: string[]): Promise<ActiveCredentialLeaseRecord[]> {
    if (credentialIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({
        credentialId: credentialBindingTable.credential_record_id,
        activeLeases: sql<number>`count(*)`,
      })
      .from(sessionLeaseTable)
      .innerJoin(credentialBindingTable, eq(sessionLeaseTable.active_binding_id, credentialBindingTable.id))
      .where(inArray(credentialBindingTable.credential_record_id, credentialIds))
      .groupBy(credentialBindingTable.credential_record_id);

    return rows.map((row) => ({
      credentialId: row.credentialId,
      activeLeases: Number(row.activeLeases ?? 0),
    }));
  }

  async listRecentCredentialUsage(input: ListRecentCredentialUsageInput): Promise<RecentCredentialUsageRecord[]> {
    if (input.credentialIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select({
        credentialId: credentialUsageEventTable.credential_record_id,
        totalTokens: sql<number>`coalesce(sum(${credentialUsageEventTable.total_tokens}), 0)`,
        requestCount: sql<number>`count(*)`,
      })
      .from(credentialUsageEventTable)
      .where(
        and(
          inArray(credentialUsageEventTable.credential_record_id, input.credentialIds),
          gte(credentialUsageEventTable.created_at, input.since),
        ),
      )
      .groupBy(credentialUsageEventTable.credential_record_id);

    return rows.map((row) => ({
      credentialId: row.credentialId,
      totalTokens: Number(row.totalTokens ?? 0),
      requestCount: Number(row.requestCount ?? 0),
    }));
  }

  async getCredentialRecordByBindingId(bindingId: string): Promise<CredentialRecord | null> {
    const rows = await this.db
      .select({
        record: credentialRecordTable,
      })
      .from(credentialBindingTable)
      .innerJoin(credentialRecordTable, eq(credentialBindingTable.credential_record_id, credentialRecordTable.id))
      .where(eq(credentialBindingTable.id, bindingId))
      .limit(1);
    const row = rows[0];

    return row ? mapCredentialRecord(row.record) : null;
  }

  async getBindingByCredentialId(credentialId: string): Promise<CredentialBinding | null> {
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
      .where(
        and(
          eq(credentialBindingTable.credential_record_id, credentialId),
          eq(credentialRecordTable.state, "healthy"),
        ),
      )
      .orderBy(credentialBindingTable.created_at)
      .limit(1);
    const row = rows[0];

    return row ? mapCredentialBinding(row) : null;
  }

  async listAdminCredentials(): Promise<AdminCredentialRecord[]> {
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
          cachedTokens: sql<number>`coalesce(sum(${credentialUsageEventTable.cached_tokens}), 0)`,
          totalTokens: sql<number>`coalesce(sum(${credentialUsageEventTable.total_tokens}), 0)`,
        })
        .from(credentialUsageEventTable)
        .groupBy(credentialUsageEventTable.credential_record_id),
    ]);

    const activeLeasesByCredential = new Map(
      activeLeaseRows.map((row: { credentialRecordId: string; activeLeases: number }) => [
        row.credentialRecordId,
        Number(row.activeLeases ?? 0),
      ]),
    );
    const cachedTokensByCredential = new Map(
      usageRows.map((row: { credentialRecordId: string; cachedTokens: number }) => [
        row.credentialRecordId,
        Number(row.cachedTokens ?? 0),
      ]),
    );
    const totalTokensByCredential = new Map(
      usageRows.map((row: { credentialRecordId: string; totalTokens: number }) => [
        row.credentialRecordId,
        Number(row.totalTokens ?? 0),
      ]),
    );

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
      cachedTokens: cachedTokensByCredential.get(row.id) ?? 0,
      totalTokens: totalTokensByCredential.get(row.id) ?? 0,
      nextRotationAt: null,
      linkedAlertIds: [],
    }));
  }

  async createUserCredential(input: CreateUserCredentialInput): Promise<CredentialRecord> {
    return this.createCredentialRecordAndBinding({
      ownerUserId: input.ownerUserId,
      name: input.name ?? null,
      provider: input.provider,
      credentialType: input.credentialType,
      secretRef: input.secretRef,
    });
  }

  async createPlatformCredential(input: CreatePlatformCredentialInput): Promise<CredentialRecord> {
    return this.createCredentialRecordAndBinding({
      ownerUserId: input.ownerUserId,
      name: input.name,
      provider: input.provider,
      credentialType: input.credentialType,
      secretRef: input.secretRef,
    });
  }

  private async createCredentialRecordAndBinding(input: {
    ownerUserId: string;
    name: string | null;
    provider: string;
    credentialType: "api_key" | "oauth";
    secretRef: string;
  }): Promise<CredentialRecord> {
    const createdAt = new Date();
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
    };
    const binding: CredentialBinding = {
      id: `binding_${randomUUID()}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      credentialRecordId: record.id,
      createdAt,
      updatedAt: createdAt,
    };

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
    });
    await this.db.insert(credentialBindingTable).values({
      id: binding.id,
      owner_user_id: binding.ownerUserId,
      provider: binding.provider,
      credential_record_id: binding.credentialRecordId,
      created_at: createdAt,
      updated_at: createdAt,
    });

    return record;
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
      .orderBy(desc(credentialRecordTable.created_at));

    return rows.map(mapCredentialRecord);
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
      .limit(1);
    const row = existing[0];

    if (!row) {
      return null;
    }

    const updatedAt = new Date();
    await this.db
      .update(credentialRecordTable)
      .set({
        state: "revoked",
        updated_at: updatedAt,
      })
      .where(eq(credentialRecordTable.id, input.credentialId));

    return mapCredentialRecord({
      ...row,
      state: "revoked",
      updated_at: updatedAt,
    });
  }

  async markCredentialState(input: MarkCredentialStateInput): Promise<void> {
    const current = await this.getCredentialRecordById(input.credentialRecordId);
    if (!current) {
      return;
    }

    const updatedAt = new Date();
    await this.db
      .update(credentialRecordTable)
      .set({
        state: input.state,
        updated_at: updatedAt,
      })
      .where(eq(credentialRecordTable.id, input.credentialRecordId));
    await this.db.insert(credentialHealthEventTable).values({
      id: `health_${randomUUID()}`,
      credential_record_id: input.credentialRecordId,
      from_state: current.state,
      to_state: input.state,
      reason: input.reason ?? null,
      created_at: updatedAt,
    });
  }
}

function mapCredentialRecord(row: typeof credentialRecordTable.$inferSelect): CredentialRecord {
  const updatedAt = asDate(row.updated_at);

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
  };
}

function mapCredentialBinding(row: {
  id: string;
  owner_user_id: string;
  provider: string;
  credential_record_id: string;
  created_at: Date | string;
  updated_at: Date | string;
}): CredentialBinding {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    provider: row.provider,
    credentialRecordId: row.credential_record_id,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatProviderLabel(provider: string) {
  return formatAiGatewayProviderLabel(provider);
}
