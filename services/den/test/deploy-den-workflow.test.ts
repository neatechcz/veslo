import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("Den deploy workflow keeps YouTrack projector configuration in Render env sync", () => {
  const workflowSource = readFileSync(new URL("../../../.github/workflows/deploy-den.yml", import.meta.url), "utf8")

  for (const key of [
    "DEN_YOUTRACK_PROJECT_KEY",
    "DEN_YOUTRACK_MCP_COMMAND",
    "DEN_YOUTRACK_MCP_ARGS",
    "DEN_YOUTRACK_MCP_TIMEOUT_MS",
    "DEN_YOUTRACK_MCP_WIRE_PROTOCOL",
    "DEN_YOUTRACK_MCP_URL",
    "DEN_YOUTRACK_MCP_TOKEN",
  ]) {
    assert.match(workflowSource, new RegExp(`${key}:`))
  }

  for (const key of [
    "YOUTRACK_PROJECT_KEY",
    "YOUTRACK_MCP_COMMAND",
    "YOUTRACK_MCP_ARGS",
    "YOUTRACK_MCP_TIMEOUT_MS",
    "YOUTRACK_MCP_WIRE_PROTOCOL",
    "YOUTRACK_MCP_URL",
    "YOUTRACK_MCP_TOKEN",
  ]) {
    assert.match(workflowSource, new RegExp(`"key": "${key}"`))
  }

  assert.match(workflowSource, /existing_env_values/)
})

test("Den deploy workflow fails before deploy when YouTrack projector transport is missing", () => {
  const workflowSource = readFileSync(new URL("../../../.github/workflows/deploy-den.yml", import.meta.url), "utf8")

  assert.match(workflowSource, /has_youtrack_transport/)
  assert.match(workflowSource, /Missing YouTrack projector transport/)
})
