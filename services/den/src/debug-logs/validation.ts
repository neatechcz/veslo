import { z } from "zod"
import type { DebugLogUploadRequest } from "./types.js"

const debugLogLevelSchema = z.enum(["info", "warn", "error"])

const debugLogEventSchema = z.object({
  id: z.string().trim().min(1).max(128),
  userId: z.string().max(128),
  orgId: z.string().max(128),
  workspaceId: z.string().max(128),
  workerId: z.string().max(128).nullish(),
  sessionId: z.string().max(128).nullish(),
  runId: z.string().max(128).nullish(),
  captureId: z.string().uuid().nullish(),
  source: z.string().trim().min(1).max(64),
  stream: z.string().trim().min(1).max(32),
  level: debugLogLevelSchema.nullish(),
  timestamp: z.number().finite(),
  sequenceNo: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
})

const debugLogUploadRequestSchema = z.object({
  batchId: z.string().trim().min(1).max(128),
  events: z.array(debugLogEventSchema).min(1).max(1000),
})

export type DebugLogValidationResult =
  | { ok: true; value: DebugLogUploadRequest }
  | { ok: false; issues: string[] }

export function parseDebugLogUploadRequest(value: unknown): DebugLogValidationResult {
  const parsed = debugLogUploadRequestSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
        return `${path}${issue.message}`
      }),
    }
  }

  return { ok: true, value: parsed.data }
}
