import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("owned-server compose keeps YouTrack projector configuration in DEN env", () => {
  const composeSource = readFileSync(new URL("../../../packaging/owned-server/compose.yml", import.meta.url), "utf8")

  for (const key of [
    "YOUTRACK_PROJECT_KEY",
    "YOUTRACK_URL",
    "YOUTRACK_TOKEN",
    "YOUTRACK_TIMEOUT_MS",
  ]) {
    assert.match(composeSource, new RegExp(`${key}:\\s*\\$\\{${key}:-`))
  }
})

test("owned-server env templates expose YouTrack projector REST config", () => {
  const productionTemplate = readFileSync(new URL("../../../packaging/owned-server/env.example", import.meta.url), "utf8")
  const stagingTemplate = readFileSync(new URL("../../../packaging/owned-server/env.staging.example", import.meta.url), "utf8")

  for (const source of [productionTemplate, stagingTemplate]) {
    assert.match(source, /^YOUTRACK_PROJECT_KEY=/m)
    assert.match(source, /^YOUTRACK_URL=/m)
    assert.match(source, /^YOUTRACK_TOKEN=/m)
    assert.match(source, /^YOUTRACK_TIMEOUT_MS=/m)
  }
})
