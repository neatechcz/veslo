import assert from "node:assert/strict"
import { once } from "node:events"
import { readFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

function setupEnv() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
}

async function loadFeedbackModules() {
  setupEnv()
  const [{ createFeedbackRouter, FEEDBACK_MAX_SCREENSHOT_BYTES }, { errorMiddleware }, schemaModule] = await Promise.all([
    import("../src/http/feedback.js"),
    import("../src/http/errors.js"),
    import("../src/db/schema.js"),
  ])

  return {
    createFeedbackRouter,
    FEEDBACK_MAX_SCREENSHOT_BYTES,
    errorMiddleware,
    FeedbackProjectorAttemptTable: schemaModule.FeedbackProjectorAttemptTable,
    FeedbackReportTable: schemaModule.FeedbackReportTable,
  }
}

type AuthorizationContext = {
  session: {
    user: {
      id: string
      email: string | null
      emailVerified: boolean
      name: string | null
    }
  }
  organization: {
    id: string
    name: string
    slug: string
    ownerUserId: string
  }
  membershipId: string | null
  orgRole: "owner" | "member" | null
  isPlatformAdmin: boolean
}

type InsertCall = {
  table: unknown
  value: Record<string, unknown>
}

function buildAuthorizationContext(): AuthorizationContext {
  return {
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
    diagnosticCaptureId: "00000000-0000-4000-8000-000000000001",
  }
}

async function startServer(options: {
  authorize: (req: express.Request, res: express.Response, options: Record<string, unknown>) => Promise<unknown>
  db: {
    insert: (table: unknown) => {
      values: (value: Record<string, unknown>) => Promise<unknown> | unknown
    }
  }
  generateId?: () => string
  findFeedbackSubmission?: (input: { submissionId: string; userId: string; orgId: string }) => Promise<{ feedbackId: string; requestHash: string } | null>
  findFeedbackByDiagnosticCapture?: (input: { captureId: string; userId: string; orgId: string }) => Promise<string | null>
}) {
  const { createFeedbackRouter, errorMiddleware } = await loadFeedbackModules()
  const app = express()
  app.use("/v1", createFeedbackRouter(options))
  app.use(errorMiddleware)

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  const { port } = server.address() as AddressInfo
  return {
    port,
    close: async () => {
      server.close()
      await once(server, "close")
    },
  }
}

test("feedback route requires an authenticated org-scoped session", async () => {
  const authorizeCalls: Array<{ minimumRole: string; orgHeader: string | undefined }> = []
  const server = await startServer({
    authorize: async (req, res, options) => {
      authorizeCalls.push({
        minimumRole: String(options.minimumRole),
        orgHeader: req.header("x-veslo-org-id") ?? undefined,
      })
      res.status(401).json({ error: "unauthorized" })
      return null
    },
    db: {
      insert() {
        throw new Error("insert must not be reached")
      },
    },
  })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-veslo-org-id": "org_123",
      },
      body: JSON.stringify(buildFeedbackPayload()),
    })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: "unauthorized" })
    assert.deepEqual(authorizeCalls, [{ minimumRole: "member", orgHeader: "org_123" }])
  } finally {
    await server.close()
  }
})

test("feedback route validates required title and description fields", async () => {
  const insertCalls: InsertCall[] = []
  const server = await startServer({
    authorize: async () => buildAuthorizationContext(),
    db: {
      insert(table) {
        return {
          values(value) {
            insertCalls.push({ table, value })
          },
        }
      },
    },
    generateId: () => "fb_validation",
  })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-veslo-org-id": "org_123",
      },
      body: JSON.stringify({
        ...buildFeedbackPayload(),
        title: "   ",
        description: "",
      }),
    })

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: "invalid_feedback_payload",
      fieldErrors: {
        title: ["Title is required."],
        description: ["Description is required."],
      },
    })
    assert.equal(insertCalls.length, 0)
  } finally {
    await server.close()
  }
})

test("feedback route rejects oversized screenshots before inserting", async () => {
  const insertCalls: InsertCall[] = []
  const { FEEDBACK_MAX_SCREENSHOT_BYTES } = await loadFeedbackModules()
  const oversizedData = Buffer.alloc(FEEDBACK_MAX_SCREENSHOT_BYTES + 1, 7).toString("base64")
  const server = await startServer({
    authorize: async () => buildAuthorizationContext(),
    db: {
      insert(table) {
        return {
          values(value) {
            insertCalls.push({ table, value })
          },
        }
      },
    },
    generateId: () => "fb_too_large",
  })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-veslo-org-id": "org_123",
      },
      body: JSON.stringify({
        ...buildFeedbackPayload(),
        screenshotDataUrl: `data:image/jpeg;base64,${oversizedData}`,
      }),
    })

    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), {
      error: "feedback_screenshot_too_large",
      maxBytes: FEEDBACK_MAX_SCREENSHOT_BYTES,
    })
    assert.equal(insertCalls.length, 0)
  } finally {
    await server.close()
  }
})

test("feedback route persists a feedback record in MySQL without any ticketing side effects", async () => {
  const insertCalls: InsertCall[] = []
  const modules = await loadFeedbackModules()
  const server = await startServer({
    authorize: async () => buildAuthorizationContext(),
    db: {
      insert(table) {
        return {
          values(value) {
            insertCalls.push({ table, value })
            return Promise.resolve({ insertId: "fb_pending_123" })
          },
        }
      },
    },
    generateId: () => "fb_pending_123",
  })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-veslo-org-id": "org_123",
      },
      body: JSON.stringify(buildFeedbackPayload()),
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), {
      feedbackId: "fb_pending_123",
      status: "stored",
    })

    assert.equal(insertCalls.length, 1)
    assert.equal(insertCalls[0]?.table, modules.FeedbackReportTable)
    assert.notEqual(insertCalls[0]?.table, modules.FeedbackProjectorAttemptTable)
    assert.equal(insertCalls[0]?.value.id, "fb_pending_123")
    assert.equal(insertCalls[0]?.value.type, "bug")
    assert.equal(insertCalls[0]?.value.status, "stored")
    assert.equal(insertCalls[0]?.value.title, "Sidebar stopped responding")
    assert.equal(insertCalls[0]?.value.description, "The left sidebar stopped reacting after switching sessions.")
    assert.equal(insertCalls[0]?.value.user_id, "user_123")
    assert.equal(insertCalls[0]?.value.user_email, "vaclav@example.com")
    assert.equal(insertCalls[0]?.value.org_id, "org_123")
    assert.equal(insertCalls[0]?.value.view, "session")
    assert.equal(insertCalls[0]?.value.pathname, "/session/ses_123")
    assert.equal(insertCalls[0]?.value.dashboard_tab, "scheduled")
    assert.equal(insertCalls[0]?.value.settings_tab, "general")
    assert.equal(insertCalls[0]?.value.session_id, "ses_123")
    assert.equal(insertCalls[0]?.value.workspace_id, "workspace_local_1")
    assert.equal(insertCalls[0]?.value.veslo_server_workspace_id, "veslo_workspace_1")
    assert.equal(insertCalls[0]?.value.workspace_type, "local")
    assert.equal(insertCalls[0]?.value.workspace_path, "/tmp/veslo/workspace")
    assert.equal(insertCalls[0]?.value.worker_id, null)
    assert.equal(insertCalls[0]?.value.run_id, null)
    assert.equal(insertCalls[0]?.value.app_version, "2026.4.0")
    assert.equal(insertCalls[0]?.value.locale, "cs")
    assert.equal(insertCalls[0]?.value.platform, "macOS")
    assert.equal(insertCalls[0]?.value.os_family, "macOS")
    assert.equal(insertCalls[0]?.value.screenshot_status, "captured")
    assert.equal(insertCalls[0]?.value.screenshot_mime_type, "image/jpeg")
    assert.equal(insertCalls[0]?.value.screenshot_bytes, 5)
    assert.equal(insertCalls[0]?.value.screenshot_data, "aGVsbG8=")
    assert.equal(insertCalls[0]?.value.diagnostic_capture_id, "00000000-0000-4000-8000-000000000001")
    assert.equal(insertCalls[0]?.value.youtrack_issue_id, null)
    assert.equal(insertCalls[0]?.value.youtrack_issue_url, null)
    assert.equal(insertCalls[0]?.value.last_projector_error, null)
    assert.equal(insertCalls[0]?.value.next_projector_attempt_at, null)
    assert.ok(insertCalls[0]?.value.submitted_at instanceof Date)
  } finally {
    await server.close()
  }
})

test("den index mounts feedback router and raises the JSON body size limit", () => {
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  const routeSource = readFileSync(new URL("../src/http/feedback.ts", import.meta.url), "utf8")

  assert.match(indexSource, /app\.use\("\/v1",\s*feedbackRouter\)/)
  assert.match(indexSource, /const managedAiProxyJsonParser = express\.json\(\{\s*limit: MANAGED_AI_PROXY_JSON_LIMIT\s*\}\)/)
  assert.match(indexSource, /app\.use\("\/providers",\s*managedAiProxyJsonParser\)/)
  assert.match(indexSource, /app\.use\(express\.json\(\)\)/)
  assert.doesNotMatch(indexSource, /express\.json\(\{\s*limit:\s*"10mb"\s*\}\)/)
  assert.match(routeSource, /express\.json\(\{\s*limit:\s*"10mb"\s*\}\)/)
  assert.doesNotMatch(indexSource, /feedbackProjector|createYouTrackRestIssueClient/)
})

test("feedback submission idempotency returns the original durable feedback record", async () => {
  const submissions = new Map<string, { feedbackId: string; requestHash: string }>()
  let insertCalls = 0
  const server = await startServer({
    authorize: async () => buildAuthorizationContext(),
    db: {
      insert() {
        return {
          values(value) {
            insertCalls += 1
            const submissionId = String(value.submission_id)
            submissions.set(submissionId, {
              feedbackId: String(value.id),
              requestHash: String(value.request_hash),
            })
          },
        }
      },
    },
    findFeedbackSubmission: async ({ submissionId }) => submissions.get(submissionId) ?? null,
    generateId: () => "fb_idempotent_123",
  })

  try {
    const payload = {
      ...buildFeedbackPayload(),
      submissionId: "00000000-0000-4000-8000-000000000099",
    }
    const first = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-veslo-org-id": "org_123" },
      body: JSON.stringify(payload),
    })
    const second = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-veslo-org-id": "org_123" },
      body: JSON.stringify(payload),
    })

    assert.equal(first.status, 201)
    assert.deepEqual(await first.json(), { feedbackId: "fb_idempotent_123", status: "stored" })
    assert.equal(second.status, 200)
    assert.deepEqual(await second.json(), {
      feedbackId: "fb_idempotent_123",
      status: "stored",
      idempotent: true,
    })
    assert.equal(insertCalls, 1)
  } finally {
    await server.close()
  }
})

test("feedback submission idempotency rejects a changed payload", async () => {
  const submissions = new Map<string, { feedbackId: string; requestHash: string }>()
  const server = await startServer({
    authorize: async () => buildAuthorizationContext(),
    db: {
      insert() {
        return {
          values(value) {
            submissions.set(String(value.submission_id), {
              feedbackId: String(value.id),
              requestHash: String(value.request_hash),
            })
          },
        }
      },
    },
    findFeedbackSubmission: async ({ submissionId }) => submissions.get(submissionId) ?? null,
    generateId: () => "fb_conflict_123",
  })

  try {
    const submissionId = "00000000-0000-4000-8000-000000000098"
    const first = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-veslo-org-id": "org_123" },
      body: JSON.stringify({ ...buildFeedbackPayload(), submissionId }),
    })
    const changed = await fetch(`http://127.0.0.1:${server.port}/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-veslo-org-id": "org_123" },
      body: JSON.stringify({
        ...buildFeedbackPayload(),
        submissionId,
        description: "This is a different feedback payload.",
      }),
    })

    assert.equal(first.status, 201)
    assert.equal(changed.status, 409)
    assert.deepEqual(await changed.json(), { error: "feedback_submission_conflict" })
  } finally {
    await server.close()
  }
})

test("feedback diagnostic capture lookup is scoped to the authenticated user and organization", async () => {
  const lookups: Array<{ captureId: string; userId: string; orgId: string }> = []
  const server = await startServer({
    authorize: async () => buildAuthorizationContext(),
    db: {
      insert() {
        throw new Error("insert must not be reached")
      },
    },
    findFeedbackByDiagnosticCapture: async (input) => {
      lookups.push(input)
      return "fb_linked_123"
    },
  })

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/feedback/diagnostic-captures/00000000-0000-4000-8000-000000000001`,
      { headers: { "x-veslo-org-id": "org_123" } },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { linked: true, feedbackId: "fb_linked_123" })
    assert.deepEqual(lookups, [{
      captureId: "00000000-0000-4000-8000-000000000001",
      userId: "user_123",
      orgId: "org_123",
    }])
  } finally {
    await server.close()
  }
})

test("feedback diagnostic capture lookup rejects an invalid capture id before the store read", async () => {
  let lookupCalls = 0
  const server = await startServer({
    authorize: async () => buildAuthorizationContext(),
    db: {
      insert() {
        throw new Error("insert must not be reached")
      },
    },
    findFeedbackByDiagnosticCapture: async () => {
      lookupCalls += 1
      return null
    },
  })

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/feedback/diagnostic-captures/not-a-uuid`,
      { headers: { "x-veslo-org-id": "org_123" } },
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "invalid_diagnostic_capture_id" })
    assert.equal(lookupCalls, 0)
  } finally {
    await server.close()
  }
})

test("den startup ensures feedback persistence tables and indexes", () => {
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")

  assert.ok(indexSource.includes("CREATE TABLE IF NOT EXISTS \\`feedback_report\\`"))
  assert.ok(indexSource.includes("CREATE TABLE IF NOT EXISTS \\`feedback_projector_attempt\\`"))
  assert.match(indexSource, /ensureIndex\("feedback_report", "feedback_report_org_id", \["org_id"\]\)/)
  assert.match(indexSource, /ensureIndex\("feedback_report", "feedback_report_user_id", \["user_id"\]\)/)
  assert.match(indexSource, /ensureIndex\("feedback_report", "feedback_report_status", \["status"\]\)/)
  assert.ok(indexSource.includes('"feedback_report_next_projector_attempt_at"'))
  assert.ok(indexSource.includes('["next_projector_attempt_at"]'))
  assert.ok(indexSource.includes('"feedback_report_diagnostic_capture_id"'))
  assert.ok(indexSource.includes('["diagnostic_capture_id"]'))
  assert.ok(indexSource.includes('"feedback_projector_attempt_feedback_id"'))
  assert.ok(indexSource.includes('["feedback_id"]'))
})
