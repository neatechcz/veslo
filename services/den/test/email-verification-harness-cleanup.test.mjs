import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  assertComposeProjectResourcesAbsent,
  combineAcceptanceAndCleanupErrors,
} from "../scripts/email-verification-harness-cleanup.mjs"

test("compose cleanup audit checks only exact project labels across containers, networks, and volumes", async () => {
  const calls = []
  await assertComposeProjectResourcesAbsent(
    "veslo-den-email-verification-a1b2c3",
    async (command, args) => {
      calls.push([command, args])
      return ""
    },
  )

  assert.deepEqual(calls, [
    ["docker", ["ps", "-aq", "--filter", "label=com.docker.compose.project=veslo-den-email-verification-a1b2c3"]],
    ["docker", ["network", "ls", "-q", "--filter", "label=com.docker.compose.project=veslo-den-email-verification-a1b2c3"]],
    ["docker", ["volume", "ls", "-q", "--filter", "label=com.docker.compose.project=veslo-den-email-verification-a1b2c3"]],
  ])
})

test("compose cleanup audit reports exact surviving resources and rejects unsafe project names", async () => {
  await assert.rejects(
    assertComposeProjectResourcesAbsent(
      "veslo-den-email-verification-deadbeef",
      async (_command, args) => args[0] === "network" ? "network-id\n" : "",
    ),
    /network-id.*veslo-den-email-verification-deadbeef/i,
  )
  await assert.rejects(
    assertComposeProjectResourcesAbsent("some-user-project", async () => ""),
    /refusing to audit/i,
  )
})

test("acceptance and cleanup failures are aggregated without masking either error", () => {
  const acceptanceError = new Error("pilot assertion failed")
  const cleanupError = new Error("compose down failed")
  const combined = combineAcceptanceAndCleanupErrors(acceptanceError, cleanupError)

  assert.ok(combined instanceof AggregateError)
  assert.deepEqual(combined.errors, [acceptanceError, cleanupError])
  assert.match(combined.message, /acceptance and cleanup both failed/i)
  assert.equal(combineAcceptanceAndCleanupErrors(acceptanceError, null), acceptanceError)
  assert.equal(combineAcceptanceAndCleanupErrors(null, cleanupError), cleanupError)
  assert.equal(combineAcceptanceAndCleanupErrors(null, null), null)
})

test("outer acceptance runner cannot suppress compose-down failures", async () => {
  const source = await readFile(
    new URL("../scripts/run-email-verification-integration.mjs", import.meta.url),
    "utf8",
  )
  const teardown = source.slice(
    source.indexOf("async function teardown()"),
    source.indexOf("function composeArgs"),
  )

  assert.doesNotMatch(teardown, /allowFailure|\.catch\(\(\) => \{\}\)/)
  assert.match(source, /combineAcceptanceAndCleanupErrors\(acceptanceError, cleanupError\)/)
  assert.match(source, /assertComposeProjectResourcesAbsent\(/)
})
