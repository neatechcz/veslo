import crypto from "node:crypto"
import express from "express"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "../db/index.js"
import { FeedbackReportTable, FeedbackScreenshotStatus } from "../db/schema.js"
import { asyncRoute } from "./errors.js"
import { requireOrganizationAccess } from "./org-auth.js"

export const FEEDBACK_MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024

export type FeedbackRouterAuthorize = typeof requireOrganizationAccess

type FeedbackInsertDb = {
  insert: (table: typeof FeedbackReportTable) => {
    values: (value: typeof FeedbackReportTable.$inferInsert) => Promise<unknown> | unknown
  }
}

export type FeedbackRouterOptions = {
  authorize?: FeedbackRouterAuthorize
  db?: FeedbackInsertDb
  findFeedbackSubmission?: (input: {
    submissionId: string
    userId: string
    orgId: string
  }) => Promise<{ feedbackId: string; requestHash: string } | null>
  findFeedbackByDiagnosticCapture?: (input: {
    captureId: string
    userId: string
    orgId: string
  }) => Promise<string | null>
  generateId?: () => string
  now?: () => Date
}

const feedbackContextSchema = z.object({
  view: z.string().trim().min(1).max(64),
  pathname: z.string().trim().max(1024).nullable().optional(),
  tab: z.string().trim().max(64).nullable().optional(),
  settingsTab: z.string().trim().max(64).nullable().optional(),
  selectedSessionId: z.string().trim().max(64).nullable().optional(),
  activeWorkspaceId: z.string().trim().max(64).nullable().optional(),
  vesloServerWorkspaceId: z.string().trim().max(64).nullable().optional(),
  activeWorkspaceType: z.string().trim().max(64).nullable().optional(),
  activeWorkspaceRoot: z.string().trim().max(1024).nullable().optional(),
  locale: z.string().trim().max(64).nullable().optional(),
  appVersion: z.string().trim().max(64).nullable().optional(),
  platform: z.string().trim().max(64).nullable().optional(),
})

const feedbackBodySchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(255),
  description: z.string().trim().min(1, "Description is required.").max(20_000),
  userId: z.string().trim().max(64).nullable().optional(),
  userEmail: z.string().trim().max(255).nullable().optional(),
  orgId: z.string().trim().max(64).nullable().optional(),
  orgName: z.string().trim().max(255).nullable().optional(),
  context: feedbackContextSchema,
  screenshotStatus: z.enum(FeedbackScreenshotStatus),
  screenshotDataUrl: z.string().trim().max(8 * 1024 * 1024).nullable().optional(),
  screenshotMimeType: z.string().trim().max(255).nullable().optional(),
  diagnosticCaptureId: z.string().uuid().nullable().optional(),
  submissionId: z.string().uuid().nullable().optional(),
})

function normalizeOptionalString(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function buildFeedbackId() {
  return `fb_${crypto.randomUUID().replaceAll("-", "")}`
}

function feedbackRequestHash(input: Record<string, unknown>) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex")
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }
  const candidate = error as { code?: unknown; errno?: unknown; cause?: unknown; message?: unknown }
  if (candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062) {
    return true
  }
  if (typeof candidate.message === "string" && candidate.message.toLowerCase().includes("duplicate")) {
    return true
  }
  return isDuplicateKeyError(candidate.cause)
}

function buildFieldErrorResponse(error: z.ZodError) {
  return {
    error: "invalid_feedback_payload",
    fieldErrors: error.flatten().fieldErrors,
  }
}

function deriveOsFamily(platform: string | null) {
  const normalized = platform?.trim() ?? ""
  if (normalized.length === 0) {
    return null
  }

  const lowered = normalized.toLowerCase()
  if (lowered.includes("mac")) {
    return "macOS"
  }
  if (lowered.includes("win")) {
    return "Windows"
  }
  if (lowered.includes("linux")) {
    return "Linux"
  }

  return normalized
}

function parseScreenshotPayload(payload: {
  screenshotStatus: (typeof FeedbackScreenshotStatus)[number]
  screenshotDataUrl: string | null
  screenshotMimeType: string | null
}) {
  if (payload.screenshotStatus === "failed") {
    return {
      screenshotMimeType: null,
      screenshotBytes: null,
      screenshotData: null,
    }
  }

  if (!payload.screenshotDataUrl) {
    return {
      error: {
        error: "invalid_feedback_payload",
        fieldErrors: {
          screenshotDataUrl: ["Screenshot data is required when screenshotStatus is captured."],
        },
      },
    }
  }

  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(payload.screenshotDataUrl)
  if (!match) {
    return {
      error: {
        error: "invalid_feedback_payload",
        fieldErrors: {
          screenshotDataUrl: ["Screenshot data must be a base64 data URL."],
        },
      },
    }
  }

  const [, mimeTypeFromDataUrl, encodedData] = match
  const screenshotBytes = Buffer.from(encodedData, "base64").length
  if (screenshotBytes > FEEDBACK_MAX_SCREENSHOT_BYTES) {
    return {
      error: {
        error: "feedback_screenshot_too_large",
        maxBytes: FEEDBACK_MAX_SCREENSHOT_BYTES,
      },
    }
  }

  return {
    screenshotMimeType: normalizeOptionalString(payload.screenshotMimeType) ?? mimeTypeFromDataUrl,
    screenshotBytes,
    screenshotData: encodedData,
  }
}

export function createFeedbackRouter(options: FeedbackRouterOptions = {}) {
  const authorize = options.authorize ?? requireOrganizationAccess
  const feedbackDb = options.db ?? db
  const generateId = options.generateId ?? buildFeedbackId
  const now = options.now ?? (() => new Date())
  const findFeedbackSubmission = options.findFeedbackSubmission ?? (async (input) => {
    const rows = await db
      .select({
        feedbackId: FeedbackReportTable.id,
        requestHash: FeedbackReportTable.request_hash,
      })
      .from(FeedbackReportTable)
      .where(and(
        eq(FeedbackReportTable.submission_id, input.submissionId),
        eq(FeedbackReportTable.user_id, input.userId),
        eq(FeedbackReportTable.org_id, input.orgId),
      ))
      .limit(1)
    const row = rows[0]
    return row?.requestHash ? { feedbackId: row.feedbackId, requestHash: row.requestHash } : null
  })
  const findFeedbackByDiagnosticCapture = options.findFeedbackByDiagnosticCapture ?? (async (input) => {
    const rows = await db
      .select({ feedbackId: FeedbackReportTable.id })
      .from(FeedbackReportTable)
      .where(and(
        eq(FeedbackReportTable.diagnostic_capture_id, input.captureId),
        eq(FeedbackReportTable.user_id, input.userId),
        eq(FeedbackReportTable.org_id, input.orgId),
      ))
      .limit(1)
    return rows[0]?.feedbackId ?? null
  })
  const router = express.Router()
  const feedbackJsonParser = express.json({ limit: "10mb" })

  router.get("/feedback/diagnostic-captures/:captureId", asyncRoute(async (req, res) => {
    const context = await authorize(req, res, {
      minimumRole: "member",
    })
    if (!context) {
      return
    }

    const captureId = z.string().uuid().safeParse(req.params.captureId)
    if (!captureId.success) {
      res.status(400).json({ error: "invalid_diagnostic_capture_id" })
      return
    }

    const feedbackId = await findFeedbackByDiagnosticCapture({
      captureId: captureId.data,
      userId: context.session.user.id,
      orgId: context.organization.id,
    })
    res.status(200).json(feedbackId
      ? { linked: true, feedbackId }
      : { linked: false })
  }))

  router.post("/feedback", feedbackJsonParser, asyncRoute(async (req, res) => {
    const context = await authorize(req, res, {
      minimumRole: "member",
    })

    if (!context) {
      return
    }

    const parsed = feedbackBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json(buildFieldErrorResponse(parsed.error))
      return
    }

    const screenshot = parseScreenshotPayload({
      screenshotStatus: parsed.data.screenshotStatus,
      screenshotDataUrl: normalizeOptionalString(parsed.data.screenshotDataUrl),
      screenshotMimeType: normalizeOptionalString(parsed.data.screenshotMimeType),
    })

    const screenshotError = "error" in screenshot ? screenshot.error : null
    if (screenshotError) {
      const statusCode = screenshotError.error === "feedback_screenshot_too_large" ? 413 : 400
      res.status(statusCode).json(screenshotError)
      return
    }

    const submissionId = parsed.data.submissionId ?? null
    const requestHash = submissionId ? feedbackRequestHash({
      title: parsed.data.title.trim(),
      description: parsed.data.description.trim(),
      context: parsed.data.context,
      screenshotStatus: parsed.data.screenshotStatus,
      screenshotDataUrl: normalizeOptionalString(parsed.data.screenshotDataUrl),
      screenshotMimeType: screenshot.screenshotMimeType,
      diagnosticCaptureId: parsed.data.diagnosticCaptureId ?? null,
      userId: context.session.user.id,
      orgId: context.organization.id,
    }) : null
    const existingSubmission = submissionId
      ? await findFeedbackSubmission({
        submissionId,
        userId: context.session.user.id,
        orgId: context.organization.id,
      })
      : null
    if (existingSubmission) {
      if (existingSubmission.requestHash !== requestHash) {
        res.status(409).json({ error: "feedback_submission_conflict" })
        return
      }
      res.status(200).json({
        feedbackId: existingSubmission.feedbackId,
        status: "stored",
        idempotent: true,
      })
      return
    }

    const feedbackId = generateId()
    const normalizedPlatform = normalizeOptionalString(parsed.data.context.platform)
    const insert = {
      id: feedbackId,
      type: "bug",
      status: "stored",
      title: parsed.data.title.trim(),
      description: parsed.data.description.trim(),
      user_id: context.session.user.id,
      user_email: normalizeOptionalString(context.session.user.email)
        ?? normalizeOptionalString(parsed.data.userEmail),
      org_id: context.organization.id,
      context: parsed.data.context,
      view: parsed.data.context.view.trim(),
      pathname: normalizeOptionalString(parsed.data.context.pathname),
      dashboard_tab: normalizeOptionalString(parsed.data.context.tab),
      settings_tab: normalizeOptionalString(parsed.data.context.settingsTab),
      session_id: normalizeOptionalString(parsed.data.context.selectedSessionId),
      workspace_id: normalizeOptionalString(parsed.data.context.activeWorkspaceId),
      veslo_server_workspace_id: normalizeOptionalString(parsed.data.context.vesloServerWorkspaceId),
      workspace_type: normalizeOptionalString(parsed.data.context.activeWorkspaceType),
      workspace_path: normalizeOptionalString(parsed.data.context.activeWorkspaceRoot),
      worker_id: null,
      run_id: null,
      app_version: normalizeOptionalString(parsed.data.context.appVersion),
      locale: normalizeOptionalString(parsed.data.context.locale),
      platform: normalizedPlatform,
      os_family: deriveOsFamily(normalizedPlatform),
      submitted_at: now(),
      screenshot_status: parsed.data.screenshotStatus,
      screenshot_mime_type: screenshot.screenshotMimeType,
      screenshot_bytes: screenshot.screenshotBytes,
      screenshot_data: screenshot.screenshotData,
      diagnostic_capture_id: parsed.data.diagnosticCaptureId ?? null,
      submission_id: submissionId,
      request_hash: requestHash,
      youtrack_issue_id: null,
      youtrack_issue_url: null,
      last_projector_error: null,
      next_projector_attempt_at: null,
    } satisfies typeof FeedbackReportTable.$inferInsert
    try {
      await feedbackDb.insert(FeedbackReportTable).values(insert)
    } catch (error) {
      if (!submissionId || !isDuplicateKeyError(error)) {
        throw error
      }
      const concurrentSubmission = await findFeedbackSubmission({
        submissionId,
        userId: context.session.user.id,
        orgId: context.organization.id,
      })
      if (!concurrentSubmission) {
        throw error
      }
      if (concurrentSubmission.requestHash !== requestHash) {
        res.status(409).json({ error: "feedback_submission_conflict" })
        return
      }
      res.status(200).json({
        feedbackId: concurrentSubmission.feedbackId,
        status: "stored",
        idempotent: true,
      })
      return
    }
    // Feedback is the durable MySQL record itself. Diagnostics may now be
    // queued immediately by the desktop without depending on a third-party
    // ticketing integration.
    res.status(201).json({
      feedbackId,
      status: "stored",
    })
  }))

  return router
}

export const feedbackRouter = createFeedbackRouter()
