import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

import type { AiGatewayDb } from "../db/index.js";
import { sessionLeaseTable } from "../db/schema.js";
import type {
  CreateSessionLeaseInput,
  LeaseProvider,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "./repository.js";

export class MySqlLeaseRepository implements LeaseRepository {
  constructor(private readonly db: AiGatewayDb) {}

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
      .limit(1);

    const row = rows[0];
    return row ? mapSessionLease(row) : null;
  }

  async createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease> {
    const existing = await this.getActiveLease(input);
    if (existing) {
      return existing;
    }

    const createdAt = new Date();
    try {
      await this.db.insert(sessionLeaseTable).values({
        id: createLeaseId(input),
        owner_user_id: input.ownerUserId,
        provider: input.provider,
        session_id: input.sessionId,
        active_binding_id: input.activeBindingId,
        created_at: createdAt,
        updated_at: createdAt,
      });
    } catch (error) {
      if (!isDuplicateEntryError(error)) {
        throw error;
      }

      const winningLease = await this.getActiveLease(input);
      if (winningLease) {
        return winningLease;
      }

      throw error;
    }

    return (await this.getActiveLease(input)) ?? {
      id: createLeaseId(input),
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      sessionId: input.sessionId,
      activeBindingId: input.activeBindingId,
    };
  }

  async rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    const current = await this.getActiveLease(input);
    if (!current || current.activeBindingId !== input.expectedCurrentBindingId) {
      return null;
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
      );

    return this.getActiveLease(input);
  }
}

function mapSessionLease(row: typeof sessionLeaseTable.$inferSelect): SessionLease {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    provider: row.provider as LeaseProvider,
    sessionId: row.session_id,
    activeBindingId: row.active_binding_id,
  };
}

function createLeaseId(input: ResolveLeaseInput): string {
  const digest = createHash("sha256")
    .update(input.ownerUserId)
    .update("\0")
    .update(input.provider)
    .update("\0")
    .update(input.sessionId)
    .digest("base64url")
    .slice(0, 32);

  return `lease_${input.provider}_${digest}`;
}

function isDuplicateEntryError(error: unknown): boolean {
  let candidate = error;
  const seen = new Set<unknown>();

  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : "";
    if (record.code === "ER_DUP_ENTRY" || record.errno === 1062 || message.includes("Duplicate entry")) {
      return true;
    }
    candidate = record.cause;
  }

  return false;
}
