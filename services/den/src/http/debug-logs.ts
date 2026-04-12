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

function parseBearerToken(headerValue: string): string | null {
  const match = headerValue.trim().match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

export function createDebugLogsRouter(input: {
  ingestToken: string
  storeBatch: (batch: DebugLogIngestBatch) => Promise<DebugLogStoreBatchResult>
}) {
  const router = express.Router()

  router.post("/", async (req, res) => {
    try {
      const providedToken = parseBearerToken(req.header("authorization") ?? "")
      if (!providedToken || providedToken !== input.ingestToken) {
        res.status(401).json({ error: "unauthorized" })
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

  return router
}
