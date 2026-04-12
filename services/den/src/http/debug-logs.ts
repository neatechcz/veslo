import express from "express"
import { z } from "zod"

type DebugLogSession = {
  user: {
    id: string
  }
}

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
  userId: string | null
}
export type DebugLogRecentResult = {
  ok: true
  rows: unknown[]
}

function parseBearerToken(headerValue: string): string | null {
  const match = headerValue.trim().match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

function collectErrorDetails(error: unknown): string[] {
  const details: string[] = []
  let current = error
  while (current && typeof current === "object" && "cause" in current) {
    const cause = current.cause
    if (!(cause instanceof Error)) {
      break
    }
    if (cause.message && !details.includes(cause.message)) {
      details.push(cause.message)
    }
    current = cause
  }
  return details
}

export function createDebugLogsRouter(input: {
  ingestToken: string
  storeBatch: (batch: DebugLogIngestBatch) => Promise<DebugLogStoreBatchResult>
  readRecent?: (query: DebugLogRecentQuery) => Promise<DebugLogRecentResult>
  requireSession?: (req: express.Request, res: express.Response) => Promise<DebugLogSession | null>
}) {
  const router = express.Router()

  const requireAuthorization = async (req: express.Request, res: express.Response) => {
    const providedToken = parseBearerToken(req.header("authorization") ?? "")
    if (providedToken && providedToken === input.ingestToken) {
      return { kind: "internal" as const }
    }
    if (input.requireSession) {
      const session = await input.requireSession(req, res)
      if (session?.user?.id) {
        return { kind: "user" as const, userId: session.user.id }
      }
      if (res.headersSent) {
        return null
      }
    }
    if (!res.headersSent) {
      res.status(401).json({ error: "unauthorized" })
    }
    return null
  }

  router.post("/", async (req, res) => {
    try {
      const auth = await requireAuthorization(req, res)
      if (!auth) {
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

      const batch = auth.kind === "user"
        ? {
            ...parsed.data,
            events: parsed.data.events.map((event) => ({
              ...event,
              userId: auth.userId,
            })),
          }
        : parsed.data

      const result = await input.storeBatch(batch)
      res.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : "debug_log_ingest_failed"
      const details = collectErrorDetails(error)
      console.error("[den] debug log ingest failed", error)
      res.status(500).json(details.length > 0 ? { error: "internal_error", message, details } : { error: "internal_error", message })
    }
  })

  router.get("/recent", async (req, res) => {
    try {
      const auth = await requireAuthorization(req, res)
      if (!auth) {
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
        userId: auth.kind === "user" ? auth.userId : null,
      })
      res.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : "debug_log_query_failed"
      const details = collectErrorDetails(error)
      console.error("[den] debug log query failed", error)
      res.status(500).json(details.length > 0 ? { error: "internal_error", message, details } : { error: "internal_error", message })
    }
  })

  return router
}
