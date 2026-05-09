import assert from "node:assert/strict"
import test from "node:test"

const { parseDebugLogUploadRequest } = await import("../src/debug-logs/validation.js")

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    userId: "user_1",
    orgId: "org_1",
    workspaceId: "workspace_1",
    workerId: "worker_1",
    sessionId: "session_1",
    runId: "run_1",
    source: "engine",
    stream: "stdout",
    level: "info",
    timestamp: 1778322000000000000,
    sequenceNo: 1,
    payload: { line: "hello" },
    ...overrides,
  }
}

test("debug log validation parses the veslo-server upload contract", () => {
  const parsed = parseDebugLogUploadRequest({
    batchId: "batch_1",
    events: [makeEvent()],
  })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.value.batchId, "batch_1")
  assert.equal(parsed.ok && parsed.value.events[0]?.payload.line, "hello")
})

test("debug log validation rejects empty event batches", () => {
  const parsed = parseDebugLogUploadRequest({
    batchId: "batch_empty",
    events: [],
  })

  assert.equal(parsed.ok, false)
  assert.match(parsed.ok ? "" : parsed.issues.join("\n"), /events/)
})

test("debug log validation rejects missing required event fields", () => {
  const event = makeEvent()
  delete (event as { source?: unknown }).source

  const parsed = parseDebugLogUploadRequest({
    batchId: "batch_missing",
    events: [event],
  })

  assert.equal(parsed.ok, false)
  assert.match(parsed.ok ? "" : parsed.issues.join("\n"), /source/)
})

test("debug log validation requires payload objects", () => {
  const parsed = parseDebugLogUploadRequest({
    batchId: "batch_bad_payload",
    events: [makeEvent({ payload: "plain text is not accepted" })],
  })

  assert.equal(parsed.ok, false)
  assert.match(parsed.ok ? "" : parsed.issues.join("\n"), /payload/)
})
