export type DebugLogLevel = "info" | "warn" | "error"

export type DebugLogEvent = {
  id: string
  userId: string
  orgId: string
  workspaceId: string
  workerId?: string | null
  sessionId?: string | null
  runId?: string | null
  source: string
  stream: string
  level?: DebugLogLevel | null
  timestamp: number
  sequenceNo: number
  payload: Record<string, unknown>
}

export type DebugLogUploadRequest = {
  batchId: string
  events: DebugLogEvent[]
}

export type DebugLogSearchFilters = {
  userId?: string
  orgId?: string
  workspaceId?: string
  sessionId?: string
  runId?: string
  source?: string
  stream?: string
  level?: DebugLogLevel
  from?: Date
  to?: Date
  limit?: number
}

export type StoredDebugLogBatch = {
  id: string
  batchId: string
  idempotencyKey: string
  eventCount: number
  createdAt: Date
  expiresAt: Date
}

export type StoredDebugLogEvent = {
  id: string
  batchId: string
  eventId: string
  userId: string
  orgId: string
  workspaceId: string
  workerId: string | null
  sessionId: string | null
  runId: string | null
  source: string
  stream: string
  level: DebugLogLevel | null
  eventTimestamp: Date
  sequenceNo: number
  payloadSha256: string
  payloadBytes: number
  encryptionKeyVersion: string
  payloadCiphertext: string
  payloadIv: string
  payloadAuthTag: string
  createdAt: Date
  expiresAt: Date
}

export type DebugLogListEntry = {
  id: string
  batchId: string
  eventId: string
  userId: string
  orgId: string
  workspaceId: string
  workerId: string | null
  sessionId: string | null
  runId: string | null
  source: string
  stream: string
  level: DebugLogLevel | null
  eventTimestamp: string
  sequenceNo: number
  payloadSha256: string
  payloadBytes: number
  payloadPreview: string
}

export type DebugLogDetail = DebugLogListEntry & {
  payload: unknown
}
