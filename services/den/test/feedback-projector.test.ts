import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

function setupEnv() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
}

type ProjectableFeedback = {
  id: string
  title: string
  description: string
  status: "pending" | "projected" | "failed"
  userId: string
  userEmail: string | null
  orgId: string
  view: string
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

type AttemptRecord = {
  feedbackId: string
  attemptNo: number
  status: "pending" | "succeeded" | "failed"
  errorMessage: string | null
}

function buildFeedback(overrides: Partial<ProjectableFeedback> = {}): ProjectableFeedback {
  return {
    id: "fb_123",
    title: "Sidebar stopped responding",
    description: "The left sidebar stopped reacting after switching sessions.",
    status: "pending",
    userId: "user_123",
    userEmail: "vaclav@example.com",
    orgId: "org_123",
    view: "session",
    dashboardTab: "scheduled",
    settingsTab: "general",
    sessionId: "ses_123",
    workspaceId: "workspace_123",
    workerId: null,
    runId: null,
    appVersion: "2026.4.0",
    locale: "cs",
    platform: "macOS",
    submittedAt: new Date("2026-04-16T20:00:00.000Z"),
    screenshotStatus: "captured",
    screenshotMimeType: "image/jpeg",
    screenshotBytes: 5,
    youtrackIssueId: null,
    youtrackIssueUrl: null,
    lastProjectorError: null,
    nextProjectorAttemptAt: null,
    ...overrides,
  }
}

function createMemoryStore(initialFeedback: ProjectableFeedback) {
  const feedbacks = new Map<string, ProjectableFeedback>([[initialFeedback.id, { ...initialFeedback }]])
  const attempts: AttemptRecord[] = []

  return {
    attempts,
    feedbacks,
    store: {
      async getFeedback(feedbackId: string) {
        return feedbacks.get(feedbackId) ?? null
      },
      async getLatestAttemptNumber(feedbackId: string) {
        const matching = attempts.filter((attempt) => attempt.feedbackId === feedbackId)
        return matching.at(-1)?.attemptNo ?? 0
      },
      async insertAttempt(attempt: AttemptRecord) {
        attempts.push(attempt)
      },
      async markProjected(args: {
        feedbackId: string
        issueId: string
        issueUrl: string
      }) {
        const feedback = feedbacks.get(args.feedbackId)
        if (!feedback) {
          throw new Error("feedback not found")
        }
        feedbacks.set(args.feedbackId, {
          ...feedback,
          status: "projected",
          youtrackIssueId: args.issueId,
          youtrackIssueUrl: args.issueUrl,
          lastProjectorError: null,
          nextProjectorAttemptAt: null,
        })
      },
      async markRetryPending(args: {
        feedbackId: string
        errorMessage: string
        nextProjectorAttemptAt: Date
      }) {
        const feedback = feedbacks.get(args.feedbackId)
        if (!feedback) {
          throw new Error("feedback not found")
        }
        feedbacks.set(args.feedbackId, {
          ...feedback,
          status: "pending",
          lastProjectorError: args.errorMessage,
          nextProjectorAttemptAt: args.nextProjectorAttemptAt,
        })
      },
      async markFailed(args: {
        feedbackId: string
        errorMessage: string
      }) {
        const feedback = feedbacks.get(args.feedbackId)
        if (!feedback) {
          throw new Error("feedback not found")
        }
        feedbacks.set(args.feedbackId, {
          ...feedback,
          status: "failed",
          lastProjectorError: args.errorMessage,
          nextProjectorAttemptAt: null,
        })
      },
    },
  }
}

function createTimerStub() {
  const scheduled: Array<{ delayMs: number; callback: () => void }> = []
  return {
    scheduled,
    api: {
      setTimeout(callback: () => void, delayMs?: number) {
        scheduled.push({ delayMs: Number(delayMs ?? 0), callback })
        return scheduled.length
      },
      clearTimeout() {
      },
    },
  }
}

function buildFeedbackPayload() {
  return {
    title: "Sidebar stopped responding",
    description: "The left sidebar stopped reacting after switching sessions.",
    userId: "user_123",
    userEmail: "vaclav@example.com",
    orgId: "org_123",
    orgName: "Veslo",
    context: {
      view: "session",
      pathname: "/session/ses_123",
      tab: "scheduled",
      settingsTab: "general",
      selectedSessionId: "ses_123",
      activeWorkspaceId: "workspace_local_1",
      vesloServerWorkspaceId: "veslo_workspace_1",
      activeWorkspaceType: "local",
      activeWorkspaceRoot: "/tmp/veslo/workspace",
      locale: "cs",
      appVersion: "2026.4.0",
      platform: "macOS",
    },
    screenshotStatus: "captured",
    screenshotDataUrl: "data:image/jpeg;base64,aGVsbG8=",
    screenshotMimeType: "image/jpeg",
  }
}

test("feedback projector creates one immediate YouTrack issue and records success metadata", async () => {
  setupEnv()
  const { createFeedbackProjector } = await import("../src/feedback/projector.js")
  const memory = createMemoryStore(buildFeedback())
  const createIssueCalls: Array<{ project: string; summary: string; description: string }> = []
  const projector = createFeedbackProjector({
    projectKey: "VESLO",
    store: memory.store,
    issueClient: {
      async createIssue(input) {
        createIssueCalls.push(input)
        return {
          issueId: "VESLO-123",
          issueUrl: "https://youtrack.example/issue/VESLO-123",
        }
      },
    },
    now: () => new Date("2026-04-16T20:00:00.000Z"),
  })

  await projector.projectFeedback("fb_123")

  assert.equal(createIssueCalls.length, 1)
  assert.equal(createIssueCalls[0]?.project, "VESLO")
  assert.equal(createIssueCalls[0]?.summary, "[Bug] Sidebar stopped responding")
  assert.match(String(createIssueCalls[0]?.description), /Feedback ID: fb_123/)
  assert.match(String(createIssueCalls[0]?.description), /Reporter email: vaclav@example\.com/)
  assert.match(String(createIssueCalls[0]?.description), /Org ID: org_123/)
  assert.match(String(createIssueCalls[0]?.description), /Session ID: ses_123/)
  assert.match(String(createIssueCalls[0]?.description), /Workspace ID: workspace_123/)
  assert.match(String(createIssueCalls[0]?.description), /Run ID: -/)
  assert.match(String(createIssueCalls[0]?.description), /Log lookup window: 2026-04-16T19:50:00\.000Z \.\. 2026-04-16T20:02:00\.000Z/)
  assert.match(String(createIssueCalls[0]?.description), /Screenshot reference: Den feedback record \(captured, image\/jpeg, 5 bytes\)/)

  assert.deepEqual(memory.attempts, [{
    feedbackId: "fb_123",
    attemptNo: 1,
    status: "succeeded",
    errorMessage: null,
  }])
  assert.deepEqual(memory.feedbacks.get("fb_123"), {
    ...buildFeedback(),
    status: "projected",
    youtrackIssueId: "VESLO-123",
    youtrackIssueUrl: "https://youtrack.example/issue/VESLO-123",
    lastProjectorError: null,
    nextProjectorAttemptAt: null,
  })
})

test("feedback projector records failure, schedules retry, and keeps the row pending before retry budget is exhausted", async () => {
  setupEnv()
  const { createFeedbackProjector, FEEDBACK_PROJECTOR_RETRY_DELAYS_MS } = await import("../src/feedback/projector.js")
  const memory = createMemoryStore(buildFeedback())
  const timer = createTimerStub()
  const projector = createFeedbackProjector({
    projectKey: "VESLO",
    store: memory.store,
    issueClient: {
      async createIssue() {
        throw new Error("MCP unavailable")
      },
    },
    timerApi: timer.api,
    now: () => new Date("2026-04-16T20:00:00.000Z"),
  })

  await projector.projectFeedback("fb_123")

  assert.deepEqual(memory.attempts, [{
    feedbackId: "fb_123",
    attemptNo: 1,
    status: "failed",
    errorMessage: "MCP unavailable",
  }])
  assert.equal(memory.feedbacks.get("fb_123")?.status, "pending")
  assert.equal(memory.feedbacks.get("fb_123")?.lastProjectorError, "MCP unavailable")
  assert.deepEqual(memory.feedbacks.get("fb_123")?.nextProjectorAttemptAt, new Date("2026-04-16T20:00:30.000Z"))
  assert.equal(timer.scheduled.length, 1)
  assert.equal(timer.scheduled[0]?.delayMs, FEEDBACK_PROJECTOR_RETRY_DELAYS_MS[0])
})

test("feedback projector suppresses duplicate issue creation when the feedback row already has a YouTrack issue id", async () => {
  setupEnv()
  const { createFeedbackProjector } = await import("../src/feedback/projector.js")
  const memory = createMemoryStore(buildFeedback({
    status: "projected",
    youtrackIssueId: "VESLO-123",
    youtrackIssueUrl: "https://youtrack.example/issue/VESLO-123",
  }))
  let createIssueCalls = 0
  const projector = createFeedbackProjector({
    projectKey: "VESLO",
    store: memory.store,
    issueClient: {
      async createIssue() {
        createIssueCalls += 1
        throw new Error("should not be called")
      },
    },
  })

  await projector.projectFeedback("fb_123")

  assert.equal(createIssueCalls, 0)
  assert.deepEqual(memory.attempts, [])
  assert.equal(memory.feedbacks.get("fb_123")?.youtrackIssueId, "VESLO-123")
})

test("feedback projector reuses an existing YouTrack issue found by feedback id before attempting a new create", async () => {
  setupEnv()
  const { createFeedbackProjector } = await import("../src/feedback/projector.js")
  const memory = createMemoryStore(buildFeedback())
  let createIssueCalls = 0
  let lookupCalls = 0
  const projector = createFeedbackProjector({
    projectKey: "VESLO",
    store: memory.store,
    issueClient: {
      async createIssue() {
        createIssueCalls += 1
        throw new Error("should not be called")
      },
      async findIssueByFeedbackId(input) {
        lookupCalls += 1
        assert.equal(input.feedbackId, "fb_123")
        return {
          issueId: "VESLO-123",
          issueUrl: "https://youtrack.example/issue/VESLO-123",
        }
      },
    },
  })

  await projector.projectFeedback("fb_123")

  assert.equal(lookupCalls, 1)
  assert.equal(createIssueCalls, 0)
  assert.equal(memory.feedbacks.get("fb_123")?.status, "projected")
  assert.equal(memory.feedbacks.get("fb_123")?.youtrackIssueId, "VESLO-123")
  assert.deepEqual(memory.attempts, [{
    feedbackId: "fb_123",
    attemptNo: 1,
    status: "succeeded",
    errorMessage: null,
  }])
})

test("feedback route triggers projector work asynchronously after persistence instead of waiting on the projection promise", async () => {
  setupEnv()
  const [{ createFeedbackRouter }, { errorMiddleware }] = await Promise.all([
    import("../src/http/feedback.js"),
    import("../src/http/errors.js"),
  ])

  const projectorCalls: string[] = []
  const app = express()
  app.use("/v1", createFeedbackRouter({
    authorize: async () => ({
      session: {
        user: {
          id: "user_123",
          email: "vaclav@example.com",
          emailVerified: true,
          name: "Vaclav Soukup",
        },
      },
      organization: {
        id: "org_123",
        name: "Veslo",
        slug: "veslo",
        ownerUserId: "user_123",
      },
      membershipId: "membership_123",
      orgRole: "owner",
      isPlatformAdmin: false,
    }),
    db: {
      insert() {
        return {
          async values() {
            return { affectedRows: 1 }
          },
        }
      },
    },
    generateId: () => "fb_async_123",
    projector: {
      async projectFeedback(feedbackId: string) {
        projectorCalls.push(feedbackId)
        await new Promise(() => {})
      },
    },
  }))
  app.use(errorMiddleware)

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/v1/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-veslo-org-id": "org_123",
      },
      body: JSON.stringify(buildFeedbackPayload()),
      signal: AbortSignal.timeout(2_000),
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), {
      feedbackId: "fb_async_123",
      status: "pending",
    })
    assert.deepEqual(projectorCalls, ["fb_async_123"])
  } finally {
    server.close()
    await once(server, "close")
  }
})
