import express from "express"
import type { DebugLogService } from "../debug-logs/repository.js"
import { parseDebugLogUploadRequest } from "../debug-logs/validation.js"

const DEBUG_LOG_JSON_LIMIT = "10mb"

function readBearerToken(req: express.Request) {
  const header = req.header("authorization")?.trim() ?? ""
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]?.trim() || null
}

export function createDebugLogsIngestRouter(options: {
  ingestToken: string | null
  service: DebugLogService | null
}) {
  const router = express.Router()
  router.use(express.json({ limit: DEBUG_LOG_JSON_LIMIT }))

  router.post("/debug-logs", async (req, res) => {
    if (!options.ingestToken || !options.service) {
      res.status(503).json({ error: "debug_log_ingest_not_configured" })
      return
    }

    const bearerToken = readBearerToken(req)
    if (!bearerToken) {
      res.status(401).json({ error: "debug_log_ingest_unauthorized" })
      return
    }
    if (bearerToken !== options.ingestToken) {
      res.status(403).json({ error: "debug_log_ingest_forbidden" })
      return
    }

    const parsed = parseDebugLogUploadRequest(req.body)
    if (!parsed.ok) {
      res.status(400).json({
        error: "invalid_debug_log_batch",
        issues: parsed.issues,
      })
      return
    }

    const result = await options.service.ingestBatch({
      batchId: parsed.value.batchId,
      idempotencyKey: req.header("idempotency-key"),
      events: parsed.value.events,
    })

    res.status(202).json({ acceptedBatchIds: result.acceptedBatchIds })
  })

  return router
}
