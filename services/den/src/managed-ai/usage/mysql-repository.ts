import { and, eq, isNull } from "drizzle-orm"

import { credentialUsageEventTable } from "../schema.js"
import type {
  AggregateUsageInput,
  RecordUsageInput,
  UsageAggregateLabel,
  UsageAggregateResponse,
  UsageAggregateSeries,
  UsageRepository,
} from "./repository.js"

type UsageEventRow = {
  credentialId: string
  userId: string
  orgId: string | null
  totalTokens: number
  totalRequests: number
}

export class MySqlUsageRepository implements UsageRepository {
  constructor(private readonly db: any) {}

  async recordUsage(input: RecordUsageInput): Promise<void> {
    const createdAt = new Date()
    const inputTokens = input.inputTokens ?? 0
    const outputTokens = input.outputTokens ?? 0
    const cachedTokens = input.cachedTokens ?? 0
    const totalTokens = input.totalTokens ?? inputTokens + outputTokens

    await this.db.insert(credentialUsageEventTable).values({
      id: input.requestId,
      owner_user_id: input.ownerUserId,
      org_id: input.orgId ?? null,
      provider: input.provider,
      credential_record_id: input.credentialId,
      credential_binding_id: input.bindingId,
      session_id: input.sessionId,
      request_id: input.requestId,
      model: input.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
      total_tokens: totalTokens,
      created_at: createdAt,
    })
  }

  async aggregateUsage(input: AggregateUsageInput): Promise<UsageAggregateResponse> {
    const rows = await this.db
      .select()
      .from(credentialUsageEventTable)
      .where(buildUsageFilters(input))

    const events = rows.map((row: typeof credentialUsageEventTable.$inferSelect) => ({
      credentialId: row.credential_record_id,
      userId: row.owner_user_id,
      orgId: row.org_id,
      totalTokens: row.total_tokens ?? row.input_tokens + row.output_tokens,
      totalRequests: 1,
    }))

    const summary = events.reduce(
      (acc: UsageEventRow, event: UsageEventRow) => ({
        totalTokens: acc.totalTokens + event.totalTokens,
        totalRequests: acc.totalRequests + event.totalRequests,
      }),
      { totalTokens: 0, totalRequests: 0 },
    )

    const series = aggregateSeries(events, input.groupBy)

    return {
      summary,
      groupBy: input.groupBy,
      filters: {
        credentials: uniqueLabels(events.map((event: UsageEventRow) => ({ id: event.credentialId, label: event.credentialId }))),
        users: uniqueLabels(events.map((event: UsageEventRow) => ({ id: event.userId, label: event.userId }))),
        orgs: uniqueLabels(events.map((event: UsageEventRow) => orgLabel(event))),
      },
      series,
      topCredentials: aggregateTop(events, (event: UsageEventRow) => ({ id: event.credentialId, label: event.credentialId })),
      topUsers: aggregateTop(events, (event: UsageEventRow) => ({ id: event.userId, label: event.userId })),
      topOrgs: aggregateTop(events, orgLabel),
    }
  }
}

function buildUsageFilters(input: AggregateUsageInput) {
  const filters = []

  if (input.credentialId) {
    filters.push(eq(credentialUsageEventTable.credential_record_id, input.credentialId))
  }

  if (input.userId) {
    filters.push(eq(credentialUsageEventTable.owner_user_id, input.userId))
  }

  if (input.orgId) {
    filters.push(
      input.orgId === "unknown-org"
        ? isNull(credentialUsageEventTable.org_id)
        : eq(credentialUsageEventTable.org_id, input.orgId),
    )
  }

  if (filters.length === 0) {
    return undefined
  }

  return filters.length === 1 ? filters[0] : and(...filters)
}

function aggregateSeries(events: UsageEventRow[], groupBy: AggregateUsageInput["groupBy"]): UsageAggregateSeries[] {
  const buckets = new Map<string, UsageAggregateSeries>()

  for (const event of events) {
    const bucket = groupForEvent(event, groupBy)
    const existing = buckets.get(bucket.key) ?? {
      key: bucket.key,
      label: bucket.label,
      totalTokens: 0,
      totalRequests: 0,
    }
    existing.totalTokens += event.totalTokens
    existing.totalRequests += event.totalRequests
    buckets.set(bucket.key, existing)
  }

  return Array.from(buckets.values())
}

function groupForEvent(event: UsageEventRow, groupBy: AggregateUsageInput["groupBy"]) {
  if (groupBy === "credential") {
    return { key: event.credentialId, label: event.credentialId }
  }

  if (groupBy === "user") {
    return { key: event.userId, label: event.userId }
  }

  if (groupBy === "org") {
    const org = orgLabel(event)
    return { key: org.id, label: org.label }
  }

  return { key: "total", label: "Total usage" }
}

function orgLabel(event: UsageEventRow): UsageAggregateLabel {
  const id = event.orgId ?? "unknown-org"
  return { id, label: event.orgId ?? "Unknown org" }
}

function uniqueLabels(entries: UsageAggregateLabel[]) {
  const seen = new Map<string, string>()
  for (const entry of entries) {
    if (!seen.has(entry.id)) {
      seen.set(entry.id, entry.label)
    }
  }
  return Array.from(seen.entries()).map(([id, label]) => ({ id, label }))
}

function aggregateTop(
  events: UsageEventRow[],
  pick: (event: UsageEventRow) => UsageAggregateLabel,
) {
  const buckets = new Map<string, { label: string; totalTokens: number }>()

  for (const event of events) {
    const bucket = pick(event)
    const existing = buckets.get(bucket.id) ?? { label: bucket.label, totalTokens: 0 }
    existing.totalTokens += event.totalTokens
    buckets.set(bucket.id, existing)
  }

  return Array.from(buckets.entries())
    .map(([id, value]) => ({ id, label: value.label, totalTokens: value.totalTokens }))
    .sort((left, right) => right.totalTokens - left.totalTokens)
}
