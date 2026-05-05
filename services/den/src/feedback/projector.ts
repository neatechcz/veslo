import crypto from "node:crypto"
import { and, asc, desc, eq, isNull, lte } from "drizzle-orm"
import { db } from "../db/index.js"
import { FeedbackProjectorAttemptTable, FeedbackReportTable } from "../db/schema.js"

export const FEEDBACK_PROJECTOR_RETRY_DELAYS_MS = [30_000, 5 * 60_000, 30 * 60_000] as const
export const FEEDBACK_PROJECTOR_DUE_RETRY_LIMIT = 20

export type FeedbackProjectionRecord = {
  id: string
  title: string
  description: string
  status: "pending" | "projected" | "failed"
  userId: string
  userEmail: string | null
  orgId: string
  view: string
  pathname: string | null
  dashboardTab: string | null
  settingsTab: string | null
  sessionId: string | null
  workspaceId: string | null
  workerId: string | null
  runId: string | null
  appVersion: string | null
  locale: string | null
  platform: string | null
  submittedAt: Date
  screenshotStatus: "captured" | "failed"
  screenshotMimeType: string | null
  screenshotBytes: number | null
  youtrackIssueId: string | null
  youtrackIssueUrl: string | null
  lastProjectorError: string | null
  nextProjectorAttemptAt: Date | null
}

export type FeedbackProjectorStore = {
  getFeedback: (feedbackId: string) => Promise<FeedbackProjectionRecord | null>
  getLatestAttemptNumber: (feedbackId: string) => Promise<number>
  listDueRetries: (input: {
    now: Date
    limit: number
  }) => Promise<string[]>
  insertAttempt: (attempt: {
    feedbackId: string
    attemptNo: number
    status: "pending" | "succeeded" | "failed"
    errorMessage: string | null
  }) => Promise<void>
  markProjected: (result: {
    feedbackId: string
    issueId: string
    issueUrl: string
  }) => Promise<void>
  markRetryPending: (result: {
    feedbackId: string
    errorMessage: string
    nextProjectorAttemptAt: Date
  }) => Promise<void>
  markFailed: (result: {
    feedbackId: string
    errorMessage: string
  }) => Promise<void>
}

export type FeedbackProjectionResult = {
  issueId: string
  issueUrl: string
}

export type FeedbackProjectorDueRetryOptions = {
  now?: Date
  limit?: number
}

export type FeedbackProjectorDueRetryResult = {
  attempted: number
  projected: number
}

export type FeedbackIssueClient = {
  createIssue: (input: {
    project: string
    summary: string
    description: string
  }) => Promise<FeedbackProjectionResult>
  findIssueByFeedbackId?: (input: {
    project: string
    feedbackId: string
  }) => Promise<FeedbackProjectionResult | null>
}

type TimerApi = Pick<typeof globalThis, "setTimeout" | "clearTimeout">

export type FeedbackProjectorOptions = {
  projectKey: string | null
  store?: FeedbackProjectorStore
  issueClient: FeedbackIssueClient
  retryDelaysMs?: readonly number[]
  timerApi?: TimerApi
  now?: () => Date
  logger?: Pick<Console, "error" | "warn">
}

function formatOptional(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "-"
}

function formatLogLookupWindow(submittedAt: Date) {
  const start = new Date(submittedAt.getTime() - 10 * 60_000).toISOString()
  const end = new Date(submittedAt.getTime() + 2 * 60_000).toISOString()
  return `${start} .. ${end}`
}

function buildScreenshotReference(feedback: FeedbackProjectionRecord) {
  if (feedback.screenshotStatus !== "captured") {
    return "Den feedback record (capture failed)"
  }

  const mimeType = formatOptional(feedback.screenshotMimeType)
  const byteCount = typeof feedback.screenshotBytes === "number" ? `${feedback.screenshotBytes} bytes` : "unknown size"
  return `Den feedback record (captured, ${mimeType}, ${byteCount})`
}

export function buildFeedbackIssueSummary(feedback: FeedbackProjectionRecord) {
  return `[Bug] ${feedback.title}`
}

export function buildFeedbackIssueDescription(feedback: FeedbackProjectionRecord) {
  const lines = [
    "User report",
    feedback.description,
    "",
    "Locator",
    `Feedback ID: ${feedback.id}`,
    `Submitted at: ${feedback.submittedAt.toISOString()}`,
    `Reporter email: ${formatOptional(feedback.userEmail)}`,
    `Org ID: ${feedback.orgId}`,
    `View: ${feedback.view}`,
    `Pathname: ${formatOptional(feedback.pathname)}`,
    `Dashboard tab: ${formatOptional(feedback.dashboardTab)}`,
    `Settings tab: ${formatOptional(feedback.settingsTab)}`,
    `Session ID: ${formatOptional(feedback.sessionId)}`,
    `Workspace ID: ${formatOptional(feedback.workspaceId)}`,
    `Worker ID: ${formatOptional(feedback.workerId)}`,
    `Run ID: ${formatOptional(feedback.runId)}`,
    `App version: ${formatOptional(feedback.appVersion)}`,
    `Locale: ${formatOptional(feedback.locale)}`,
    `Platform: ${formatOptional(feedback.platform)}`,
    `Log lookup window: ${formatLogLookupWindow(feedback.submittedAt)}`,
    `Screenshot reference: ${buildScreenshotReference(feedback)}`,
  ]

  return lines.join("\n")
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function buildDisabledProjectorError(projectKey: string | null) {
  if (!projectKey || projectKey.trim().length === 0) {
    return "YouTrack projector project key is not configured."
  }
  return "YouTrack MCP transport is not configured."
}

export function createDbFeedbackProjectorStore(database = db): FeedbackProjectorStore {
  return {
    async getFeedback(feedbackId) {
      const rows = await database
        .select({
          id: FeedbackReportTable.id,
          title: FeedbackReportTable.title,
          description: FeedbackReportTable.description,
          status: FeedbackReportTable.status,
          userId: FeedbackReportTable.user_id,
          userEmail: FeedbackReportTable.user_email,
          orgId: FeedbackReportTable.org_id,
          view: FeedbackReportTable.view,
          pathname: FeedbackReportTable.pathname,
          dashboardTab: FeedbackReportTable.dashboard_tab,
          settingsTab: FeedbackReportTable.settings_tab,
          sessionId: FeedbackReportTable.session_id,
          workspaceId: FeedbackReportTable.workspace_id,
          workerId: FeedbackReportTable.worker_id,
          runId: FeedbackReportTable.run_id,
          appVersion: FeedbackReportTable.app_version,
          locale: FeedbackReportTable.locale,
          platform: FeedbackReportTable.platform,
          submittedAt: FeedbackReportTable.submitted_at,
          screenshotStatus: FeedbackReportTable.screenshot_status,
          screenshotMimeType: FeedbackReportTable.screenshot_mime_type,
          screenshotBytes: FeedbackReportTable.screenshot_bytes,
          youtrackIssueId: FeedbackReportTable.youtrack_issue_id,
          youtrackIssueUrl: FeedbackReportTable.youtrack_issue_url,
          lastProjectorError: FeedbackReportTable.last_projector_error,
          nextProjectorAttemptAt: FeedbackReportTable.next_projector_attempt_at,
        })
        .from(FeedbackReportTable)
        .where(eq(FeedbackReportTable.id, feedbackId))
        .limit(1)

      return rows[0] ?? null
    },

    async getLatestAttemptNumber(feedbackId) {
      const rows = await database
        .select({
          attemptNo: FeedbackProjectorAttemptTable.attempt_no,
        })
        .from(FeedbackProjectorAttemptTable)
        .where(eq(FeedbackProjectorAttemptTable.feedback_id, feedbackId))
        .orderBy(desc(FeedbackProjectorAttemptTable.attempt_no))
        .limit(1)

      return rows[0]?.attemptNo ?? 0
    },

    async listDueRetries(input) {
      const rows = await database
        .select({
          id: FeedbackReportTable.id,
        })
        .from(FeedbackReportTable)
        .where(and(
          eq(FeedbackReportTable.status, "pending"),
          isNull(FeedbackReportTable.youtrack_issue_id),
          lte(FeedbackReportTable.next_projector_attempt_at, input.now),
        ))
        .orderBy(asc(FeedbackReportTable.next_projector_attempt_at))
        .limit(input.limit)

      return rows.map((row) => row.id)
    },

    async insertAttempt(attempt) {
      await database.insert(FeedbackProjectorAttemptTable).values({
        id: crypto.randomUUID(),
        feedback_id: attempt.feedbackId,
        attempt_no: attempt.attemptNo,
        status: attempt.status,
        error_message: attempt.errorMessage,
      })
    },

    async markProjected(result) {
      await database
        .update(FeedbackReportTable)
        .set({
          status: "projected",
          youtrack_issue_id: result.issueId,
          youtrack_issue_url: result.issueUrl,
          last_projector_error: null,
          next_projector_attempt_at: null,
        })
        .where(eq(FeedbackReportTable.id, result.feedbackId))
    },

    async markRetryPending(result) {
      await database
        .update(FeedbackReportTable)
        .set({
          status: "pending",
          last_projector_error: result.errorMessage,
          next_projector_attempt_at: result.nextProjectorAttemptAt,
        })
        .where(eq(FeedbackReportTable.id, result.feedbackId))
    },

    async markFailed(result) {
      await database
        .update(FeedbackReportTable)
        .set({
          status: "failed",
          last_projector_error: result.errorMessage,
          next_projector_attempt_at: null,
        })
        .where(eq(FeedbackReportTable.id, result.feedbackId))
    },
  }
}

export function createFeedbackProjector(options: FeedbackProjectorOptions) {
  const store = options.store ?? createDbFeedbackProjectorStore()
  const retryDelaysMs = [...(options.retryDelaysMs ?? FEEDBACK_PROJECTOR_RETRY_DELAYS_MS)]
  const timerApi = options.timerApi ?? globalThis
  const now = options.now ?? (() => new Date())
  const logger = options.logger ?? console
  const inFlight = new Map<string, Promise<FeedbackProjectionResult | null>>()
  const scheduledRetries = new Map<string, ReturnType<TimerApi["setTimeout"]>>()

  function clearScheduledRetry(feedbackId: string) {
    const handle = scheduledRetries.get(feedbackId)
    if (handle !== undefined) {
      timerApi.clearTimeout(handle)
      scheduledRetries.delete(feedbackId)
    }
  }

  function scheduleRetry(feedbackId: string, delayMs: number) {
    clearScheduledRetry(feedbackId)
    const handle = timerApi.setTimeout(() => {
      scheduledRetries.delete(feedbackId)
      void projectFeedback(feedbackId).catch((error) => {
        logger.error(`[feedback-projector] retry failed for ${feedbackId}: ${toErrorMessage(error)}`)
      })
    }, delayMs)
    scheduledRetries.set(feedbackId, handle)
  }

  async function runProjection(feedbackId: string): Promise<FeedbackProjectionResult | null> {
    const feedback = await store.getFeedback(feedbackId)
    if (!feedback) {
      clearScheduledRetry(feedbackId)
      return null
    }

    if (feedback.youtrackIssueId) {
      clearScheduledRetry(feedbackId)
      return {
        issueId: feedback.youtrackIssueId,
        issueUrl: feedback.youtrackIssueUrl ?? "",
      }
    }

    const attemptNo = (await store.getLatestAttemptNumber(feedbackId)) + 1

    try {
      if (!options.projectKey || options.projectKey.trim().length === 0) {
        throw new Error(buildDisabledProjectorError(options.projectKey))
      }

      const existingIssue = await options.issueClient.findIssueByFeedbackId?.({
        project: options.projectKey,
        feedbackId: feedback.id,
      }) ?? null
      const issue = existingIssue ?? await options.issueClient.createIssue({
        project: options.projectKey,
        summary: buildFeedbackIssueSummary(feedback),
        description: buildFeedbackIssueDescription(feedback),
      })

      clearScheduledRetry(feedbackId)
      await store.markProjected({
        feedbackId,
        issueId: issue.issueId,
        issueUrl: issue.issueUrl,
      })
      await store.insertAttempt({
        feedbackId,
        attemptNo,
        status: "succeeded",
        errorMessage: null,
      })
      return issue
    } catch (error) {
      const errorMessage = toErrorMessage(error)
      await store.insertAttempt({
        feedbackId,
        attemptNo,
        status: "failed",
        errorMessage,
      })

      const nextDelayMs = retryDelaysMs[attemptNo - 1]
      if (typeof nextDelayMs === "number") {
        const nextProjectorAttemptAt = new Date(now().getTime() + nextDelayMs)
        await store.markRetryPending({
          feedbackId,
          errorMessage,
          nextProjectorAttemptAt,
        })
        scheduleRetry(feedbackId, nextDelayMs)
        return null
      }

      clearScheduledRetry(feedbackId)
      await store.markFailed({
        feedbackId,
        errorMessage,
      })
      return null
    }
  }

  async function projectFeedback(feedbackId: string) {
    const running = inFlight.get(feedbackId)
    if (running) {
      return running
    }

    const run = runProjection(feedbackId).finally(() => {
      inFlight.delete(feedbackId)
    })
    inFlight.set(feedbackId, run)
    return run
  }

  async function processDueRetries(options: FeedbackProjectorDueRetryOptions = {}): Promise<FeedbackProjectorDueRetryResult> {
    const limitCandidate = options.limit ?? FEEDBACK_PROJECTOR_DUE_RETRY_LIMIT
    const limit = Number.isFinite(limitCandidate) ? Math.max(0, Math.floor(limitCandidate)) : FEEDBACK_PROJECTOR_DUE_RETRY_LIMIT
    if (limit === 0) {
      return {
        attempted: 0,
        projected: 0,
      }
    }

    const feedbackIds = await store.listDueRetries({
      now: options.now ?? now(),
      limit,
    })
    let projected = 0

    for (const feedbackId of feedbackIds) {
      try {
        const result = await projectFeedback(feedbackId)
        if (result?.issueId) {
          projected += 1
        }
      } catch (error) {
        logger.error(`[feedback-projector] due retry failed for ${feedbackId}: ${toErrorMessage(error)}`)
      }
    }

    return {
      attempted: feedbackIds.length,
      projected,
    }
  }

  return {
    projectFeedback,
    processDueRetries,
    dispose() {
      for (const handle of scheduledRetries.values()) {
        timerApi.clearTimeout(handle)
      }
      scheduledRetries.clear()
    },
  }
}
