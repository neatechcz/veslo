import assert from "node:assert/strict"
import test from "node:test"

test("YouTrack REST issue client creates issues through REST API", async () => {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
  const { createYouTrackRestIssueClient } = await import("../src/integrations/youtrack-rest.js")
  const requests: Array<{
    url: string
    authorization: string | null
    body: unknown
  }> = []

  const client = createYouTrackRestIssueClient({
    baseUrl: "https://youtrack.example.test",
    token: "service-token",
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        authorization: init?.headers instanceof Headers
          ? init.headers.get("Authorization")
          : (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
        body: JSON.parse(String(init?.body)),
      })
      return new Response(JSON.stringify({
        idReadable: "VSLO-987",
        summary: "[Bug] REST issue",
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    },
  })

  const issue = await client.createIssue({
    project: "VSLO",
    summary: "[Bug] REST issue",
    description: "Locator\nFeedback ID: fb_rest",
  })

  assert.deepEqual(issue, {
    issueId: "VSLO-987",
    issueUrl: "https://youtrack.example.test/issue/VSLO-987",
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, "https://youtrack.example.test/api/issues?fields=id,idReadable,summary")
  assert.equal(requests[0]?.authorization, "Bearer service-token")
  assert.deepEqual(requests[0]?.body, {
    project: { shortName: "VSLO" },
    summary: "[Bug] REST issue",
    description: "Locator\nFeedback ID: fb_rest",
  })
})

test("YouTrack REST issue client searches by feedback id", async () => {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
  const { createYouTrackRestIssueClient } = await import("../src/integrations/youtrack-rest.js")
  const requests: string[] = []

  const client = createYouTrackRestIssueClient({
    baseUrl: "https://youtrack.example.test/",
    token: "service-token",
    fetchImpl: async (url) => {
      requests.push(String(url))
      return new Response(JSON.stringify([{ idReadable: "VSLO-777" }]), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      })
    },
  })

  const issue = await client.findIssueByFeedbackId({
    project: "VSLO",
    feedbackId: "fb_123",
  })

  assert.deepEqual(issue, {
    issueId: "VSLO-777",
    issueUrl: "https://youtrack.example.test/issue/VSLO-777",
  })
  assert.match(requests[0] ?? "", /\/api\/issues\?/)
  assert.match(requests[0] ?? "", /project%3A\+VSLO/)
})

test("YouTrack REST issue client reports missing configuration", async () => {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
  const { createYouTrackRestIssueClient } = await import("../src/integrations/youtrack-rest.js")
  const client = createYouTrackRestIssueClient({
    baseUrl: null,
    token: null,
  })

  await assert.rejects(
    () => client.createIssue({ project: "VSLO", summary: "Missing config", description: "" }),
    /REST API is not configured/,
  )
})
