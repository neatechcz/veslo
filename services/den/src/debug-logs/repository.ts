import { createHash, randomUUID } from "node:crypto"
import { and, desc, eq, gte, lt, lte, or, type SQL } from "drizzle-orm"

import { DebugLogBatchTable, DebugLogEventTable } from "../db/schema.js"
import {
  createDebugLogEncryptionKey,
  decryptDebugLogPayload,
  encryptDebugLogPayload,
} from "./crypto.js"
import type {
  DebugLogDetail,
  DebugLogEvent,
  DebugLogListEntry,
  DebugLogSearchFilters,
  StoredDebugLogBatch,
  StoredDebugLogEvent,
} from "./types.js"

type DenDb = typeof import("../db/index.js").db

export type DebugLogStore = {
  findBatch(input: { batchId: string; idempotencyKey: string }): Promise<StoredDebugLogBatch | null>
  insertBatchWithEvents(input: { batch: StoredDebugLogBatch; events: StoredDebugLogEvent[] }): Promise<void>
  searchEvents(filters: DebugLogSearchFilters): Promise<StoredDebugLogEvent[]>
  getEvent(eventId: string): Promise<StoredDebugLogEvent | null>
  deleteExpired(now: Date): Promise<{ eventsDeleted: number; batchesDeleted: number }>
}

export type DebugLogService = ReturnType<typeof createDebugLogService>

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function eventTimestampToDate(timestamp: number) {
  return new Date(Math.floor(timestamp / 1_000_000))
}

function stablePayloadText(payload: unknown) {
  return JSON.stringify(payload)
}

function payloadSha256(payloadText: string) {
  return createHash("sha256").update(payloadText).digest("hex")
}

function normalizeLimit(limit: number | undefined) {
  if (!Number.isFinite(limit ?? 0) || !limit || limit <= 0) return 100
  return Math.min(Math.floor(limit), 1000)
}

function toListEntry(event: StoredDebugLogEvent, payload: unknown): DebugLogListEntry {
  const payloadPreview = stablePayloadText(payload).slice(0, 240)
  return {
    id: event.id,
    batchId: event.batchId,
    eventId: event.eventId,
    userId: event.userId,
    orgId: event.orgId,
    workspaceId: event.workspaceId,
    workerId: event.workerId,
    sessionId: event.sessionId,
    runId: event.runId,
    source: event.source,
    stream: event.stream,
    level: event.level,
    eventTimestamp: event.eventTimestamp.toISOString(),
    sequenceNo: event.sequenceNo,
    payloadSha256: event.payloadSha256,
    payloadBytes: event.payloadBytes,
    payloadPreview,
  }
}

function rowToStoredEvent(row: typeof DebugLogEventTable.$inferSelect): StoredDebugLogEvent {
  return {
    id: row.id,
    batchId: row.batch_id,
    eventId: row.event_id,
    userId: row.user_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    workerId: row.worker_id,
    sessionId: row.session_id,
    runId: row.run_id,
    source: row.source,
    stream: row.stream,
    level: row.level === "info" || row.level === "warn" || row.level === "error" ? row.level : null,
    eventTimestamp: row.event_timestamp,
    sequenceNo: row.sequence_no,
    payloadSha256: row.payload_sha256,
    payloadBytes: row.payload_bytes,
    encryptionKeyVersion: row.encryption_key_version,
    payloadCiphertext: row.payload_ciphertext,
    payloadIv: row.payload_iv,
    payloadAuthTag: row.payload_auth_tag,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

function rowToStoredBatch(row: typeof DebugLogBatchTable.$inferSelect): StoredDebugLogBatch {
  return {
    id: row.id,
    batchId: row.batch_id,
    idempotencyKey: row.idempotency_key,
    eventCount: row.event_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

function matchesFilters(event: StoredDebugLogEvent, filters: DebugLogSearchFilters) {
  if (filters.userId && event.userId !== filters.userId) return false
  if (filters.orgId && event.orgId !== filters.orgId) return false
  if (filters.workspaceId && event.workspaceId !== filters.workspaceId) return false
  if (filters.sessionId && event.sessionId !== filters.sessionId) return false
  if (filters.runId && event.runId !== filters.runId) return false
  if (filters.source && event.source !== filters.source) return false
  if (filters.stream && event.stream !== filters.stream) return false
  if (filters.level && event.level !== filters.level) return false
  if (filters.from && event.eventTimestamp < filters.from) return false
  if (filters.to && event.eventTimestamp > filters.to) return false
  return true
}

function buildWhere(filters: DebugLogSearchFilters): SQL[] {
  const conditions: SQL[] = []
  if (filters.userId) conditions.push(eq(DebugLogEventTable.user_id, filters.userId))
  if (filters.orgId) conditions.push(eq(DebugLogEventTable.org_id, filters.orgId))
  if (filters.workspaceId) conditions.push(eq(DebugLogEventTable.workspace_id, filters.workspaceId))
  if (filters.sessionId) conditions.push(eq(DebugLogEventTable.session_id, filters.sessionId))
  if (filters.runId) conditions.push(eq(DebugLogEventTable.run_id, filters.runId))
  if (filters.source) conditions.push(eq(DebugLogEventTable.source, filters.source))
  if (filters.stream) conditions.push(eq(DebugLogEventTable.stream, filters.stream))
  if (filters.level) conditions.push(eq(DebugLogEventTable.level, filters.level))
  if (filters.from) conditions.push(gte(DebugLogEventTable.event_timestamp, filters.from))
  if (filters.to) conditions.push(lte(DebugLogEventTable.event_timestamp, filters.to))
  return conditions
}

export function createMemoryDebugLogStore(): DebugLogStore & {
  batches: StoredDebugLogBatch[]
  events: StoredDebugLogEvent[]
} {
  const batches: StoredDebugLogBatch[] = []
  const events: StoredDebugLogEvent[] = []

  return {
    batches,
    events,

    async findBatch(input) {
      return batches.find((entry) => entry.batchId === input.batchId || entry.idempotencyKey === input.idempotencyKey) ?? null
    },

    async insertBatchWithEvents(input) {
      batches.push(input.batch)
      events.push(...input.events)
    },

    async searchEvents(filters) {
      return events
        .filter((event) => matchesFilters(event, filters))
        .sort((left, right) => right.eventTimestamp.getTime() - left.eventTimestamp.getTime())
        .slice(0, normalizeLimit(filters.limit))
    },

    async getEvent(eventId) {
      return events.find((entry) => entry.id === eventId) ?? null
    },

    async deleteExpired(now) {
      const initialEvents = events.length
      const initialBatches = batches.length

      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]!.expiresAt < now) events.splice(index, 1)
      }
      for (let index = batches.length - 1; index >= 0; index -= 1) {
        if (batches[index]!.expiresAt < now) batches.splice(index, 1)
      }

      return {
        eventsDeleted: initialEvents - events.length,
        batchesDeleted: initialBatches - batches.length,
      }
    },
  }
}

export function createDbDebugLogStore(database: DenDb): DebugLogStore {
  return {
    async findBatch(input) {
      const rows = await database
        .select()
        .from(DebugLogBatchTable)
        .where(or(eq(DebugLogBatchTable.batch_id, input.batchId), eq(DebugLogBatchTable.idempotency_key, input.idempotencyKey)))
        .limit(1)
      return rows[0] ? rowToStoredBatch(rows[0]) : null
    },

    async insertBatchWithEvents(input) {
      await database.insert(DebugLogBatchTable).values({
        id: input.batch.id,
        batch_id: input.batch.batchId,
        idempotency_key: input.batch.idempotencyKey,
        event_count: input.batch.eventCount,
        created_at: input.batch.createdAt,
        expires_at: input.batch.expiresAt,
      })

      if (input.events.length === 0) return
      await database.insert(DebugLogEventTable).values(
        input.events.map((event) => ({
          id: event.id,
          batch_id: event.batchId,
          event_id: event.eventId,
          user_id: event.userId,
          org_id: event.orgId,
          workspace_id: event.workspaceId,
          worker_id: event.workerId,
          session_id: event.sessionId,
          run_id: event.runId,
          source: event.source,
          stream: event.stream,
          level: event.level,
          event_timestamp: event.eventTimestamp,
          sequence_no: event.sequenceNo,
          payload_sha256: event.payloadSha256,
          payload_bytes: event.payloadBytes,
          encryption_key_version: event.encryptionKeyVersion,
          payload_ciphertext: event.payloadCiphertext,
          payload_iv: event.payloadIv,
          payload_auth_tag: event.payloadAuthTag,
          created_at: event.createdAt,
          expires_at: event.expiresAt,
        })),
      )
    },

    async searchEvents(filters) {
      const conditions = buildWhere(filters)
      const base = database.select().from(DebugLogEventTable)
      const rows = conditions.length > 0
        ? await base.where(and(...conditions)).orderBy(desc(DebugLogEventTable.event_timestamp)).limit(normalizeLimit(filters.limit))
        : await base.orderBy(desc(DebugLogEventTable.event_timestamp)).limit(normalizeLimit(filters.limit))
      return rows.map(rowToStoredEvent)
    },

    async getEvent(eventId) {
      const rows = await database.select().from(DebugLogEventTable).where(eq(DebugLogEventTable.id, eventId)).limit(1)
      return rows[0] ? rowToStoredEvent(rows[0]) : null
    },

    async deleteExpired(now) {
      const expiredEvents = await database
        .select({ id: DebugLogEventTable.id })
        .from(DebugLogEventTable)
        .where(lt(DebugLogEventTable.expires_at, now))
      const expiredBatches = await database
        .select({ id: DebugLogBatchTable.id })
        .from(DebugLogBatchTable)
        .where(lt(DebugLogBatchTable.expires_at, now))

      if (expiredEvents.length > 0) {
        await database.delete(DebugLogEventTable).where(lt(DebugLogEventTable.expires_at, now))
      }
      if (expiredBatches.length > 0) {
        await database.delete(DebugLogBatchTable).where(lt(DebugLogBatchTable.expires_at, now))
      }

      return {
        eventsDeleted: expiredEvents.length,
        batchesDeleted: expiredBatches.length,
      }
    },
  }
}

export function createDebugLogService(input: {
  store: DebugLogStore
  masterKey: string
  masterKeyVersion: string
  retentionDays: number
  generateId?: () => string
  now?: () => Date
}) {
  const key = createDebugLogEncryptionKey(input.masterKey)
  const generateId = input.generateId ?? (() => `dlg_${randomUUID()}`)
  const now = input.now ?? (() => new Date())

  function decryptEvent(event: StoredDebugLogEvent) {
    return decryptDebugLogPayload({
      key,
      envelope: {
        keyVersion: event.encryptionKeyVersion,
        iv: event.payloadIv,
        authTag: event.payloadAuthTag,
        ciphertext: event.payloadCiphertext,
      },
    })
  }

  function toDetail(event: StoredDebugLogEvent): DebugLogDetail {
    const payload = decryptEvent(event)
    return {
      ...toListEntry(event, payload),
      payload,
    }
  }

  return {
    async ingestBatch(inputBatch: {
      batchId: string
      idempotencyKey?: string | null
      events: DebugLogEvent[]
    }) {
      const idempotencyKey = inputBatch.idempotencyKey?.trim() || inputBatch.batchId
      const existing = await input.store.findBatch({ batchId: inputBatch.batchId, idempotencyKey })
      if (existing) {
        return {
          acceptedBatchIds: [inputBatch.batchId],
          idempotent: true,
          insertedEvents: 0,
        }
      }

      const createdAt = now()
      const expiresAt = addDays(createdAt, input.retentionDays)
      const events = inputBatch.events.map((event): StoredDebugLogEvent => {
        const payloadText = stablePayloadText(event.payload)
        const encrypted = encryptDebugLogPayload({
          key,
          keyVersion: input.masterKeyVersion,
          payload: event.payload,
        })

        return {
          id: generateId(),
          batchId: inputBatch.batchId,
          eventId: event.id,
          userId: event.userId,
          orgId: event.orgId,
          workspaceId: event.workspaceId,
          workerId: event.workerId ?? null,
          sessionId: event.sessionId ?? null,
          runId: event.runId ?? null,
          source: event.source,
          stream: event.stream,
          level: event.level ?? null,
          eventTimestamp: eventTimestampToDate(event.timestamp),
          sequenceNo: event.sequenceNo,
          payloadSha256: payloadSha256(payloadText),
          payloadBytes: Buffer.byteLength(payloadText, "utf8"),
          encryptionKeyVersion: encrypted.keyVersion,
          payloadCiphertext: encrypted.ciphertext,
          payloadIv: encrypted.iv,
          payloadAuthTag: encrypted.authTag,
          createdAt,
          expiresAt,
        }
      })

      await input.store.insertBatchWithEvents({
        batch: {
          id: generateId(),
          batchId: inputBatch.batchId,
          idempotencyKey,
          eventCount: inputBatch.events.length,
          createdAt,
          expiresAt,
        },
        events,
      })

      return {
        acceptedBatchIds: [inputBatch.batchId],
        idempotent: false,
        insertedEvents: events.length,
      }
    },

    async searchLogs(filters: DebugLogSearchFilters) {
      const events = await input.store.searchEvents(filters)
      return {
        events: events.map((event) => toListEntry(event, decryptEvent(event))),
      }
    },

    async getLog(eventId: string) {
      const event = await input.store.getEvent(eventId)
      return event ? toDetail(event) : null
    },

    async exportLogs(filters: DebugLogSearchFilters) {
      const events = await input.store.searchEvents({ ...filters, limit: filters.limit ?? 1000 })
      return events.map((event) => toDetail(event))
    },

    async purgeExpired(purgeNow: Date = now()) {
      return input.store.deleteExpired(purgeNow)
    },
  }
}
