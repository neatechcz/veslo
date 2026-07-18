import assert from "node:assert/strict";
import test from "node:test";

import {
  readScopedSessionStatus,
  readSessionStatus,
  scopedSessionStatusKey,
  withSessionStatus,
  withoutSessionStatus,
} from "../../lib/scoped-session-status.js";

test("scoped session status prefers workspace-specific status over legacy session id", () => {
  const statuses = {
    shared: "idle",
    [scopedSessionStatusKey("ws-a", "shared")]: "running",
    [scopedSessionStatusKey("ws-b", "shared")]: "retry",
  };

  assert.equal(readSessionStatus(statuses, "ws-a", "shared"), "running");
  assert.equal(readSessionStatus(statuses, "ws-b", "shared"), "retry");
  assert.equal(readSessionStatus(statuses, "ws-c", "shared"), "idle");
});

test("strict scoped status does not borrow a matching session id from another workspace", () => {
  const statuses = {
    shared: "running",
    [scopedSessionStatusKey("ws-b", "shared")]: "running",
  };

  assert.equal(readScopedSessionStatus(statuses, "ws-a", "shared"), "idle");
  assert.equal(readScopedSessionStatus(statuses, "ws-b", "shared"), "running");
});

test("scoped session status writes scoped and legacy keys for compatibility", () => {
  const statuses = withSessionStatus({}, "ws-a", "session-1", "running");

  assert.equal(statuses["session-1"], "running");
  assert.equal(
    statuses[scopedSessionStatusKey("ws-a", "session-1")],
    "running",
  );
});

test("same status preserves the existing map only when legacy and scoped compatibility keys already agree", () => {
  const consistent = withSessionStatus({}, "ws-a", "session-1", "running");
  assert.strictEqual(
    withSessionStatus(consistent, "ws-a", "session-1", " running "),
    consistent,
  );

  const legacyStale = {
    ...consistent,
    "session-1": "idle",
  };
  const repairedLegacy = withSessionStatus(
    legacyStale,
    "ws-a",
    "session-1",
    "running",
  );
  assert.notStrictEqual(repairedLegacy, legacyStale);
  assert.equal(repairedLegacy["session-1"], "running");
  assert.equal(
    repairedLegacy[scopedSessionStatusKey("ws-a", "session-1")],
    "running",
  );

  const scopedStale = {
    ...consistent,
    [scopedSessionStatusKey("ws-a", "session-1")]: "idle",
  };
  const repairedScoped = withSessionStatus(
    scopedStale,
    "ws-a",
    "session-1",
    "running",
  );
  assert.notStrictEqual(repairedScoped, scopedStale);
  assert.equal(repairedScoped["session-1"], "running");
  assert.equal(
    repairedScoped[scopedSessionStatusKey("ws-a", "session-1")],
    "running",
  );
});

test("removing one scoped status preserves legacy fallback while another scoped status exists", () => {
  const statuses = withSessionStatus(
    withSessionStatus({}, "ws-a", "shared", "running"),
    "ws-b",
    "shared",
    "retry",
  );

  const next = withoutSessionStatus(statuses, "ws-a", "shared");

  assert.equal(next[scopedSessionStatusKey("ws-a", "shared")], undefined);
  assert.equal(next[scopedSessionStatusKey("ws-b", "shared")], "retry");
  assert.equal(next.shared, "retry");
});

test("removing the latest legacy writer restores legacy fallback from remaining scoped status", () => {
  const statuses = withSessionStatus(
    withSessionStatus({}, "ws-a", "shared", "running"),
    "ws-b",
    "shared",
    "retry",
  );

  const next = withoutSessionStatus(statuses, "ws-b", "shared");

  assert.equal(next[scopedSessionStatusKey("ws-b", "shared")], undefined);
  assert.equal(next[scopedSessionStatusKey("ws-a", "shared")], "running");
  assert.equal(next.shared, "running");
});
