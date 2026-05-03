import assert from "node:assert/strict"
import test from "node:test"

const baseEnv = {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
}

Object.assign(process.env, baseEnv)

const { parseEnv } = await import("../src/env.js")

test("youtrack env parses remote MCP URL and token", () => {
  const parsed = parseEnv({
    ...baseEnv,
    YOUTRACK_PROJECT_KEY: "VSLO",
    YOUTRACK_MCP_URL: "https://youtrack.example.test/mcp",
    YOUTRACK_MCP_TOKEN: "service-token",
  })

  assert.deepEqual(parsed.youtrack, {
    projectKey: "VSLO",
    mcpCommand: null,
    mcpArgs: [],
    mcpTimeoutMs: 20_000,
    mcpWireProtocol: "content-length",
    mcpUrl: "https://youtrack.example.test/mcp",
    mcpToken: "service-token",
  })
})
