import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("Den deploy workflow keeps YouTrack projector configuration in Render env sync", () => {
  const workflowSource = readFileSync(new URL("../../../.github/workflows/deploy-den.yml", import.meta.url), "utf8")

  for (const key of [
    "DEN_YOUTRACK_PROJECT_KEY",
    "DEN_YOUTRACK_URL",
    "DEN_YOUTRACK_TOKEN",
    "DEN_YOUTRACK_TIMEOUT_MS",
  ]) {
    assert.match(workflowSource, new RegExp(`${key}:`))
  }

  for (const key of [
    "YOUTRACK_PROJECT_KEY",
    "YOUTRACK_URL",
    "YOUTRACK_TOKEN",
    "YOUTRACK_TIMEOUT_MS",
  ]) {
    assert.match(workflowSource, new RegExp(`"key": "${key}"`))
  }

  assert.match(workflowSource, /existing_env_values/)
})

test("Den deploy workflow fails before deploy when YouTrack projector REST config is missing", () => {
  const workflowSource = readFileSync(new URL("../../../.github/workflows/deploy-den.yml", import.meta.url), "utf8")

  assert.match(workflowSource, /has_youtrack_rest_config/)
  assert.match(workflowSource, /Missing YouTrack projector REST config/)
})
