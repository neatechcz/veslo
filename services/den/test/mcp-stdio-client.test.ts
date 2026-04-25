import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

function writeLineProtocolMcpServer() {
  const directory = mkdtempSync(path.join(tmpdir(), "den-mcp-line-"))
  const serverPath = path.join(directory, "server.mjs")
  writeFileSync(
    serverPath,
    `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        capabilities: { tools: {} },
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        serverInfo: { name: "line-test", version: "0.0.0" }
      }
    }) + "\\n");
    return;
  }
  if (request.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            issueId: "VSLO-321",
            issueUrl: "https://youtrack.example/issue/VSLO-321"
          })
        }]
      }
    }) + "\\n");
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

test("MCP stdio client supports line-delimited JSON-RPC servers", async () => {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"
  const { createMcpStdioClient } = await import("../src/integrations/mcp-stdio-client.js")
  const server = writeLineProtocolMcpServer()

  try {
    const client = createMcpStdioClient({
      command: process.execPath,
      args: [server.serverPath],
      timeoutMs: 2_000,
      wireProtocol: "line",
    } as Parameters<typeof createMcpStdioClient>[0])

    const result = await client.callTool("create_issue", {
      project: "VSLO",
      summary: "[Bug] Line protocol",
      description: "Created through a line-delimited MCP transport.",
    })

    assert.deepEqual(result, {
      content: [{
        type: "text",
        text: JSON.stringify({
          issueId: "VSLO-321",
          issueUrl: "https://youtrack.example/issue/VSLO-321",
        }),
      }],
    })
  } finally {
    server.cleanup()
  }
})
