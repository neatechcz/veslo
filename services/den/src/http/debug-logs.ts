import express from "express"
import { z } from "zod"

const debugLogEventSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  workerId: z.string().trim().min(1).optional().nullable(),
  sessionId: z.string().trim().min(1).optional().nullable(),
  runId: z.string().trim().min(1).optional().nullable(),
  source: z.string().min(1),
  stream: z.string().min(1),
  level: z.enum(["info", "warn", "error"]).optional().nullable(),
  timestamp: z.number().finite(),
  sequenceNo: z.number().int(),
  payload: z.unknown(),
})

const debugLogBatchSchema = z.object({
  batchId: z.string().min(1),
  events: z.array(debugLogEventSchema),
})

export type DebugLogIngestEvent = z.infer<typeof debugLogEventSchema>
export type DebugLogIngestBatch = z.infer<typeof debugLogBatchSchema>
export type DebugLogStoreBatchResult = {
  ok: true
  acceptedBatchIds: string[]
}
export type DebugLogRecentQuery = {
  limit: number
  source: string | null
  workspaceId: string | null
}
export type DebugLogRecentResult = {
  ok: true
  rows: unknown[]
}

function parseBearerToken(headerValue: string): string | null {
  const match = headerValue.trim().match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

export function createDebugLogsRouter(input: {
  ingestToken: string
  storeBatch: (batch: DebugLogIngestBatch) => Promise<DebugLogStoreBatchResult>
  readRecent?: (query: DebugLogRecentQuery) => Promise<DebugLogRecentResult>
}) {
  const router = express.Router()

  const requireIngestToken = (req: express.Request, res: express.Response) => {
    const providedToken = parseBearerToken(req.header("authorization") ?? "")
    if (!providedToken || providedToken !== input.ingestToken) {
      res.status(401).json({ error: "unauthorized" })
      return false
    }
    return true
  }

  router.post("/", async (req, res) => {
    try {
      if (!requireIngestToken(req, res)) {
        return
      }

      const parsed = debugLogBatchSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_payload",
          message: "batchId and events are required",
        })
        return
      }

      const result = await input.storeBatch(parsed.data)
      res.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : "debug_log_ingest_failed"
      res.status(500).json({ error: "internal_error", message })
    }
  })

  router.get("/recent", async (req, res) => {
    try {
      if (!requireIngestToken(req, res)) {
        return
      }

      if (!input.readRecent) {
        res.status(501).json({ error: "not_implemented" })
        return
      }

      const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit
      const parsedLimit = Number.parseInt(String(rawLimit ?? "10"), 10)
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 10
      const rawSource = Array.isArray(req.query.source) ? req.query.source[0] : req.query.source
      const rawWorkspaceId = Array.isArray(req.query.workspaceId) ? req.query.workspaceId[0] : req.query.workspaceId

      const result = await input.readRecent({
        limit,
        source: typeof rawSource === "string" && rawSource.trim() ? rawSource.trim() : null,
        workspaceId: typeof rawWorkspaceId === "string" && rawWorkspaceId.trim() ? rawWorkspaceId.trim() : null,
      })
      res.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : "debug_log_query_failed"
      res.status(500).json({ error: "internal_error", message })
    }
  })

  return router
}
