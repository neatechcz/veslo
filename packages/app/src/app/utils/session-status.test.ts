import assert from "node:assert/strict";
import test from "node:test";

import { extractSessionId, normalizeSessionStatus } from "./index.js";

test("normalizeSessionStatus handles string statuses from SSE payloads", () => {
  assert.equal(normalizeSessionStatus("busy"), "running");
  assert.equal(normalizeSessionStatus("running"), "running");
  assert.equal(normalizeSessionStatus("retry"), "retry");
  assert.equal(normalizeSessionStatus("retrying"), "retry");
  assert.equal(normalizeSessionStatus("idle"), "idle");
  assert.equal(normalizeSessionStatus("completed"), "idle");
});

test("normalizeSessionStatus handles nested status shapes", () => {
  assert.equal(normalizeSessionStatus({ type: "busy" }), "running");
  assert.equal(normalizeSessionStatus({ type: "retry" }), "retry");
  assert.equal(normalizeSessionStatus({ status: "busy" }), "running");
  assert.equal(normalizeSessionStatus({ status: { type: "idle" } }), "idle");
});

test("extractSessionId accepts both sessionID and sessionId", () => {
  assert.equal(extractSessionId({ sessionID: "sess-1" }), "sess-1");
  assert.equal(extractSessionId({ sessionId: "sess-2" }), "sess-2");
});

test("extractSessionId resolves nested info and part records", () => {
  assert.equal(extractSessionId({ info: { sessionId: "sess-3" } }), "sess-3");
  assert.equal(extractSessionId({ part: { sessionID: "sess-4" } }), "sess-4");
  assert.equal(extractSessionId({}), null);
});
