import { createMcpStdioClient } from "./mcp-stdio-client.js"

type CreateIssueInput = {
  project: string
  summary: string
  description: string
}

type CreateIssueResult = {
  issueId: string
  issueUrl: string
}

type SearchIssueResult = {
  issueId: string
  issueUrl: string | null
}

type ToolResultEnvelope = {
  structuredContent?: unknown
  content?: Array<{
    type?: string
    text?: string
  }>
}

export type YouTrackMcpConfig = {
  command: string | null
  args?: string[]
  timeoutMs?: number
  wireProtocol?: "content-length" | "line"
  remoteUrl?: string | null
  remoteToken?: string | null
  fetchImpl?: typeof fetch
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function readIssueResult(candidate: unknown): CreateIssueResult | null {
  if (!isObject(candidate)) {
    return null
  }

  const issueId = readString(candidate.issueId) ?? readString(candidate.id)
  const issueUrl = readString(candidate.issueUrl) ?? readString(candidate.url)
  if (issueId && issueUrl) {
    return {
      issueId,
      issueUrl,
    }
  }

  for (const key of ["createdIssue", "issue"]) {
    const nested = readIssueResult(candidate[key])
    if (nested) {
      return nested
    }
  }

  return null
}

function readIssueSearchResult(candidate: unknown): SearchIssueResult | null {
  if (!isObject(candidate)) {
    return null
  }

  const issueId = readString(candidate.issueId) ?? readString(candidate.id)
  if (!issueId) {
    return null
  }

  return {
    issueId,
    issueUrl: readString(candidate.issueUrl) ?? readString(candidate.url),
  }
}

function extractStructuredContent(result: unknown) {
  if (!isObject(result)) {
    return result
  }

  const envelope = result as ToolResultEnvelope
  return envelope.structuredContent ?? result
}

function readFirstTextContent(result: unknown) {
  if (!isObject(result)) {
    return null
  }

  const envelope = result as ToolResultEnvelope
  return envelope.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text ?? null
}

function normalizeCreateIssueResult(result: unknown): CreateIssueResult {
  const direct = readIssueResult(result)
  if (direct) {
    return direct
  }

  const structured = readIssueResult(extractStructuredContent(result))
  if (structured) {
    return structured
  }

  const firstContentText = readFirstTextContent(result)
  if (firstContentText) {
    try {
      const parsed = JSON.parse(firstContentText)
      const parsedResult = readIssueResult(parsed)
      if (parsedResult) {
        return parsedResult
      }
    } catch {
      // Ignore non-JSON text content and fall through to the error below.
    }
  }

  throw new Error("YouTrack MCP create_issue result did not include an issue id and issue URL.")
}

function normalizeSearchIssuesResult(result: unknown): SearchIssueResult[] {
  const structured = extractStructuredContent(result)
  if (Array.isArray(structured)) {
    return structured.flatMap((entry) => {
      const issue = readIssueSearchResult(entry)
      return issue ? [issue] : []
    })
  }

  if (isObject(structured)) {
    for (const key of ["issuesPage", "items", "issues"]) {
      const entries = structured[key]
      if (Array.isArray(entries)) {
        return entries.flatMap((entry) => {
          const issue = readIssueSearchResult(entry)
          return issue ? [issue] : []
        })
      }
    }
  }

  const firstContentText = readFirstTextContent(result)
  if (firstContentText) {
    try {
      const parsed = JSON.parse(firstContentText)
      return normalizeSearchIssuesResult(parsed)
    } catch {
      return []
    }
  }

  return []
}

function readFeedbackIdFromIssueDescription(description: string) {
  return readString(/^Feedback ID:\s*([^\s]+)/m.exec(description)?.[1])
}

export function createYouTrackMcpIssueClient(config: YouTrackMcpConfig) {
  const command = config.command?.trim() ?? ""
  const remoteUrl = config.remoteUrl?.trim() ?? ""
  const remoteToken = config.remoteToken?.trim() ?? ""

  if (!command && (!remoteUrl || !remoteToken)) {
    return {
      async createIssue(_input: CreateIssueInput): Promise<CreateIssueResult> {
        throw new Error("YouTrack MCP transport is not configured.")
      },
      async findIssueByFeedbackId(): Promise<CreateIssueResult | null> {
        return null
      },
    }
  }

  const mcpClient = command
    ? createMcpStdioClient({
      command,
      args: config.args ?? [],
      timeoutMs: config.timeoutMs,
      wireProtocol: config.wireProtocol,
    })
    : createRemoteMcpClient({
      remoteUrl,
      remoteToken,
      fetchImpl: config.fetchImpl,
    })

  async function findIssueByFeedbackId(input: { project: string; feedbackId: string }): Promise<CreateIssueResult | null> {
    const searchResult = await mcpClient.callTool("search_issues", {
      query: `project: ${input.project} "Feedback ID: ${input.feedbackId}"`,
      limit: 1,
      customFieldsToReturn: [],
    })

    const existingIssue = normalizeSearchIssuesResult(searchResult)[0]
    if (!existingIssue?.issueId) {
      return null
    }

    if (existingIssue.issueUrl) {
      return {
        issueId: existingIssue.issueId,
        issueUrl: existingIssue.issueUrl,
      }
    }

    const issueDetails = await mcpClient.callTool("get_issue", {
      issueId: existingIssue.issueId,
    })

    return normalizeCreateIssueResult(issueDetails)
  }

  return {
    async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
      const result = await mcpClient.callTool("create_issue", {
        project: input.project,
        summary: input.summary,
        description: input.description,
      })

      try {
        return normalizeCreateIssueResult(result)
      } catch (error) {
        const feedbackId = readFeedbackIdFromIssueDescription(input.description)
        if (!feedbackId) {
          throw error
        }

        const existingIssue = await findIssueByFeedbackId({
          project: input.project,
          feedbackId,
        })
        if (existingIssue) {
          return existingIssue
        }

        throw error
      }
    },

    async findIssueByFeedbackId(input: { project: string; feedbackId: string }): Promise<CreateIssueResult | null> {
      return findIssueByFeedbackId(input)
    },
  }
}

function createRemoteMcpClient(config: {
  remoteUrl: string
  remoteToken: string
  fetchImpl?: typeof fetch
}) {
  const fetchImpl = config.fetchImpl ?? fetch
  let nextRequestId = 1

  return {
    async callTool(name: string, args: Record<string, unknown>) {
      const response = await fetchImpl(config.remoteUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.remoteToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `remote-${nextRequestId}`,
          method: "tools/call",
          params: {
            name,
            arguments: args,
          },
        }),
      })
      nextRequestId += 1

      const text = await response.text()
      const message = text ? JSON.parse(text) : null
      if (!response.ok) {
        throw new Error(`Remote YouTrack MCP tools/call failed with HTTP ${response.status}: ${text.slice(0, 500)}`)
      }
      if (isObject(message) && isObject(message.error)) {
        const code = typeof message.error.code === "number" ? message.error.code : -32000
        const errorMessage = readString(message.error.message) ?? "Remote MCP error"
        throw new Error(`MCP ${code}: ${errorMessage}`)
      }

      return isObject(message) ? message.result : undefined
    },
  }
}
