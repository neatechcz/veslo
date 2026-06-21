import express from "express"
import { z } from "zod"
import type { DebugLogService } from "../debug-logs/repository.js"
import { parseDebugLogUploadRequest } from "../debug-logs/validation.js"
import type { ResolvedOrganizationContext } from "./org-auth.js"

const DESKTOP_DIAGNOSTICS_JSON_LIMIT = "10mb"
const ALLOWED_BOOTSTRAP_EVENT_PREFIXES = [
  "desktop-auth:",
  "new-session:",
  "veslo-server-launch:",
  "debug-log-delivery:",
] as const

type DesktopDiagnosticsAuthorize = (
  req: express.Request,
  res: express.Response,
  options: { orgId: string },
) => Promise<ResolvedOrganizationContext | null>

const desktopDiagnosticsEnvelopeSchema = z.object({
  batchId: z.string().trim().min(1).max(128),
  events: z.array(z.unknown()).min(1).max(1000),
  installId: z.string().trim().min(1).max(128),
  bootId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(128),
  orgId: z.string().trim().min(1).max(128),
  workspaceId: z.string().trim().max(128).nullish(),
  deliveryPath: z.literal("desktop-direct-fallback"),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isDesktopDiagnosticsEvent(event: unknown): boolean {
  if (!isRecord(event)) return false
  const source = typeof event.source === "string" ? event.source.trim() : ""
  const stream = typeof event.stream === "string" ? event.stream.trim() : ""
  if (source === "veslo-server-shell" && (stream === "stdout" || stream === "stderr")) {
    return true
  }
  if (source !== "Veslo bootstrap" || stream !== "diagnostic") {
    return false
  }
  const payload = isRecord(event.payload) ? event.payload : null
  const eventType = typeof payload?.eventType === "string" ? payload.eventType.trim() : ""
  return ALLOWED_BOOTSTRAP_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))
}

function validationIssues(error: z.ZodError) {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""
    return `${path}${issue.message}`
  })
}

export function createDesktopDiagnosticsRouter(options: {
  service: DebugLogService | null
  authorize?: DesktopDiagnosticsAuthorize
}) {
  const router = express.Router()
  const authorize = options.authorize
    ?? (async (req, res, input) => {
      const { requireOrganizationAccess } = await import("./org-auth.js")
      return requireOrganizationAccess(req, res, {
      minimumRole: "member",
      orgId: input.orgId,
      allowPlatformAdmin: true,
      })
    })

  router.use(express.json({ limit: DESKTOP_DIAGNOSTICS_JSON_LIMIT }))

  router.post("/desktop-diagnostics", async (req, res) => {
    if (!options.service) {
      res.status(503).json({ error: "desktop_diagnostics_not_configured" })
      return
    }

    const envelope = desktopDiagnosticsEnvelopeSchema.safeParse(req.body)
    if (!envelope.success) {
      res.status(400).json({
        error: "invalid_desktop_diagnostics_batch",
        issues: validationIssues(envelope.error),
      })
      return
    }

    const context = await authorize(req, res, { orgId: envelope.data.orgId })
    if (!context) {
      return
    }

    if (envelope.data.userId !== context.session.user.id) {
      res.status(403).json({ error: "desktop_diagnostics_user_mismatch" })
      return
    }
    if (envelope.data.orgId !== context.organization.id) {
      res.status(403).json({ error: "desktop_diagnostics_org_mismatch" })
      return
    }

    const parsed = parseDebugLogUploadRequest({
      batchId: envelope.data.batchId,
      events: envelope.data.events,
    })
    if (!parsed.ok) {
      res.status(400).json({
        error: "invalid_debug_log_batch",
        issues: parsed.issues,
      })
      return
    }

    const invalidEvent = parsed.value.events.find((event) =>
      event.userId !== context.session.user.id ||
      event.orgId !== context.organization.id ||
      !isDesktopDiagnosticsEvent(event)
    )
    if (invalidEvent) {
      res.status(400).json({
        error: "invalid_desktop_diagnostics_event",
        eventId: invalidEvent.id,
      })
      return
    }

    const result = await options.service.ingestBatch({
      batchId: parsed.value.batchId,
      idempotencyKey: req.header("idempotency-key") ?? `desktop:${envelope.data.bootId}:${parsed.value.batchId}`,
      events: parsed.value.events,
    })

    res.status(202).json({ ok: true, acceptedBatchIds: result.acceptedBatchIds })
  })

  return router
}
