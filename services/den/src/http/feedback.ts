import crypto from "node:crypto"
import express from "express"
import { z } from "zod"
import { db } from "../db/index.js"
import { FeedbackReportTable, FeedbackScreenshotStatus } from "../db/schema.js"
import type { createFeedbackProjector } from "../feedback/projector.js"
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
  generateId?: () => string
  now?: () => Date
  projector?: Pick<ReturnType<typeof createFeedbackProjector>, "projectFeedback">
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
  const projector = options.projector ?? null
  const router = express.Router()
  const feedbackJsonParser = express.json({ limit: "10mb" })

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

    const feedbackId = generateId()
    const normalizedPlatform = normalizeOptionalString(parsed.data.context.platform)
    await feedbackDb.insert(FeedbackReportTable).values({
      id: feedbackId,
      type: "bug",
      status: "pending",
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
      youtrack_issue_id: null,
      youtrack_issue_url: null,
      last_projector_error: null,
      next_projector_attempt_at: null,
    })
    const projection = projector ? await projector.projectFeedback(feedbackId) : null
    if (projector && !projection?.issueId) {
      res.status(502).json({
        error: "feedback_youtrack_projection_failed",
        feedbackId,
        status: "pending",
      })
      return
    }

    res.status(201).json(projection ? {
      feedbackId,
      status: "projected",
      youtrackIssueId: projection.issueId,
      youtrackIssueUrl: projection.issueUrl,
    } : {
      feedbackId,
      status: "pending",
    })
  }))

  return router
}

export const feedbackRouter = createFeedbackRouter()
