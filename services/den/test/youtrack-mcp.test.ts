import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

function writeContentLengthMcpServer() {
  const directory = mkdtempSync(path.join(tmpdir(), "den-youtrack-mcp-"))
  const serverPath = path.join(directory, "server.mjs")
  writeFileSync(
    serverPath,
    `
let buffer = "";

function writeMessage(message) {
  const payload = JSON.stringify(message);
  process.stdout.write(\`Content-Length: \${Buffer.byteLength(payload, "utf8")}\\r\\n\\r\\n\${payload}\`);
}

function handleMessage(request) {
  if (request.method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        capabilities: { tools: {} },
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        serverInfo: { name: "youtrack-test", version: "0.0.0" }
      }
    });
    return;
  }

  if (request.method !== "tools/call") return;

  const name = request.params?.name;
  if (name === "create_issue") {
    writeMessage({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: "Created issue without structured payload" }]
      }
    });
    return;
  }

  if (name === "search_issues") {
    writeMessage({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            issuesPage: [{
              id: "VSLO-777",
              url: "https://youtrack.example/issue/VSLO-777",
              summary: "[Bug] Fallback issue"
            }],
            hasNextPage: false
          })
        }]
      }
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd);
    const length = Number(/Content-Length:\\s*(\\d+)/i.exec(header)?.[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (!Number.isFinite(length) || buffer.length < bodyEnd) return;
    const request = JSON.parse(buffer.slice(bodyStart, bodyEnd));
    buffer = buffer.slice(bodyEnd);
    handleMessage(request);
  }
});
`,
    "utf8",
  )

  return {
    serverPath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

test("YouTrack MCP issue client falls back to searching by feedback id when create result has no issue id", async () => {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
  const { createYouTrackMcpIssueClient } = await import("../src/integrations/youtrack-mcp.js")
  const server = writeContentLengthMcpServer()

  try {
    const client = createYouTrackMcpIssueClient({
      command: process.execPath,
      args: [server.serverPath],
      timeoutMs: 2_000,
    })

    const issue = await client.createIssue({
      project: "VSLO",
      summary: "[Bug] Fallback issue",
      description: "Locator\nFeedback ID: fb_123",
    })

    assert.deepEqual(issue, {
      issueId: "VSLO-777",
      issueUrl: "https://youtrack.example/issue/VSLO-777",
    })
  } finally {
    server.cleanup()
  }
})

test("YouTrack MCP issue client can create issues through the remote HTTP MCP endpoint", async () => {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
  const { createYouTrackMcpIssueClient } = await import("../src/integrations/youtrack-mcp.js")
  const requests: Array<{
    url: string
    authorization: string | null
    body: unknown
  }> = []

  const client = createYouTrackMcpIssueClient({
    command: null,
    remoteUrl: "https://youtrack.example.test/mcp",
    remoteToken: "service-token",
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        authorization: init?.headers instanceof Headers
          ? init.headers.get("Authorization")
          : (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
        body: JSON.parse(String(init?.body)),
      })
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "remote-1",
        result: {
          structuredContent: {
            issueId: "VSLO-987",
            issueUrl: "https://youtrack.example.test/issue/VSLO-987",
          },
        },
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
    summary: "[Bug] Remote MCP issue",
    description: "Locator\nFeedback ID: fb_remote",
  })

  assert.deepEqual(issue, {
    issueId: "VSLO-987",
    issueUrl: "https://youtrack.example.test/issue/VSLO-987",
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, "https://youtrack.example.test/mcp")
  assert.equal(requests[0]?.authorization, "Bearer service-token")
  assert.deepEqual(requests[0]?.body, {
    jsonrpc: "2.0",
    id: "remote-1",
    method: "tools/call",
    params: {
      name: "create_issue",
      arguments: {
        project: "VSLO",
        summary: "[Bug] Remote MCP issue",
        description: "Locator\nFeedback ID: fb_remote",
      },
    },
  })
})

test("YouTrack MCP issue client reads nested createdIssue payloads returned as text content", async () => {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
  const { createYouTrackMcpIssueClient } = await import("../src/integrations/youtrack-mcp.js")
  let searchCalls = 0
  const client = createYouTrackMcpIssueClient({
    command: null,
    remoteUrl: "https://youtrack.example.test/mcp",
    remoteToken: "service-token",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        params?: {
          name?: string
        }
      }
      if (body.params?.name === "search_issues") {
        searchCalls += 1
      }

      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "remote-1",
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              createdIssue: {
                id: "VSLO-988",
                url: "https://youtrack.example.test/issue/VSLO-988",
              },
            }),
          }],
        },
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
    summary: "[Bug] Nested createdIssue",
    description: "Locator\nFeedback ID: fb_nested",
  })

  assert.deepEqual(issue, {
    issueId: "VSLO-988",
    issueUrl: "https://youtrack.example.test/issue/VSLO-988",
  })
  assert.equal(searchCalls, 0)
})
