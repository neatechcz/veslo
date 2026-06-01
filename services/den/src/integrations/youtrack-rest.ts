type CreateIssueInput = {
  project: string
  summary: string
  description: string
}

type CreateIssueResult = {
  issueId: string
  issueUrl: string
}

export type YouTrackRestConfig = {
  baseUrl: string | null
  token: string | null
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

type YouTrackIssue = {
  idReadable?: string
  id?: string
  summary?: string
}

function trimUrl(value: string) {
  return value.trim().replace(/\/+$/, "")
}

function readFeedbackIdFromIssueDescription(description: string) {
  return /^Feedback ID:\s*([^\s]+)/m.exec(description)?.[1]?.trim() || null
}

function buildIssueUrl(baseUrl: string, issueId: string) {
  return `${trimUrl(baseUrl)}/issue/${encodeURIComponent(issueId)}`
}

function normalizeIssue(baseUrl: string, issue: YouTrackIssue): CreateIssueResult {
  const issueId = issue.idReadable ?? issue.id
  if (!issueId) {
    throw new Error("YouTrack REST issue result did not include an issue id.")
  }
  return {
    issueId,
    issueUrl: buildIssueUrl(baseUrl, issueId),
  }
}

function buildSearchQuery(project: string, feedbackId: string) {
  return `project: ${project} "Feedback ID: ${feedbackId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function createYouTrackRestIssueClient(config: YouTrackRestConfig) {
  const baseUrl = config.baseUrl?.trim() ?? ""
  const token = config.token?.trim() ?? ""
  const fetchImpl = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? 20_000

  async function request(method: string, path: string, body?: unknown) {
    if (!baseUrl || !token) {
      throw new Error("YouTrack REST API is not configured.")
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(new URL(path, trimUrl(baseUrl)), {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      const parsed = text ? JSON.parse(text) : null

      if (!response.ok) {
        throw new Error(`YouTrack REST ${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
      }

      return parsed
    } finally {
      clearTimeout(timeout)
    }
  }

  async function findIssueByFeedbackId(input: { project: string; feedbackId: string }): Promise<CreateIssueResult | null> {
    const params = new URLSearchParams({
      fields: "id,idReadable,summary",
      query: buildSearchQuery(input.project, input.feedbackId),
      $top: "1",
    })
    const issues = await request("GET", `/api/issues?${params}`) as YouTrackIssue[]
    const issue = issues[0]
    return issue ? normalizeIssue(baseUrl, issue) : null
  }

  return {
    async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
      const issue = await request("POST", "/api/issues?fields=id,idReadable,summary", {
        project: { shortName: input.project },
        summary: input.summary,
        description: input.description,
      }) as YouTrackIssue

      return normalizeIssue(baseUrl, issue)
    },

    async findIssueByFeedbackId(input: { project: string; feedbackId: string }): Promise<CreateIssueResult | null> {
      return findIssueByFeedbackId(input)
    },

    readFeedbackIdFromIssueDescription,
  }
}
