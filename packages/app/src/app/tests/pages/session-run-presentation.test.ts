import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSessionRunPresentation,
  lifecycleKeepsRunPresentationActive,
} from "../../pages/session-run-presentation.js";

test("only fresh active lifecycle evidence defers an idle run reset", () => {
  assert.equal(lifecycleKeepsRunPresentationActive({ status: "submitted", stale: false }), true);
  assert.equal(lifecycleKeepsRunPresentationActive({ status: "running", stale: false }), true);
  assert.equal(lifecycleKeepsRunPresentationActive({ status: "blocked", stale: false }), true);
  assert.equal(lifecycleKeepsRunPresentationActive({ status: "completed", stale: false }), false);
  assert.equal(lifecycleKeepsRunPresentationActive({ status: "running", stale: true }), false);
});

test("active lifecycle truth wins over an idle engine observation", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: { status: "running", stale: false },
    local: { started: true, hasBegun: true, optimisticSending: false, responseStarted: false },
  });

  assert.deepEqual(projection, {
    phase: "thinking",
    showIndicator: true,
    abortable: true,
    source: "lifecycle",
    diagnosticKind: null,
  });
});

test("terminal lifecycle state releases the run presentation", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: { status: "completed", stale: false },
    local: { started: false, hasBegun: false, optimisticSending: false, responseStarted: false },
  });

  assert.equal(projection.phase, "idle");
  assert.equal(projection.showIndicator, false);
  assert.equal(projection.abortable, false);
});

test("matching durable terminal releases an accepted optimistic send before canonical adoption", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: { runId: "run-a", status: "failed", stale: false, clientMessageId: "msg-a" },
    local: {
      started: true,
      hasBegun: true,
      optimisticSending: true,
      optimisticAccepted: true,
      acceptedRunId: "run-a",
      acceptedClientMessageId: "msg-a",
      responseStarted: false,
    },
  });

  assert.equal(projection.phase, "idle");
  assert.equal(projection.showIndicator, false);
  assert.equal(projection.abortable, false);
});

test("an older terminal run cannot hide a newer optimistic send", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: { runId: "run-old", status: "failed", stale: false, clientMessageId: "msg-old" },
    local: {
      started: true,
      hasBegun: false,
      optimisticSending: true,
      optimisticAccepted: true,
      acceptedRunId: "run-new",
      acceptedClientMessageId: "msg-new",
      responseStarted: false,
    },
  });

  assert.equal(projection.phase, "responding");
  assert.equal(projection.showIndicator, true);
});

test("active engine evidence supersedes a retained terminal diagnostic from an older run", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "submitted",
    lifecycle: { runId: "run-old", status: "completed", stale: false },
    local: { started: false, hasBegun: false, optimisticSending: false, responseStarted: false },
  });

  assert.equal(projection.phase, "thinking");
  assert.equal(projection.showIndicator, true);
  assert.equal(projection.abortable, true);
  assert.equal(projection.source, "engine");
});

test("blocked no-output retry is error-styled while it stays backend-abortable", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: { status: "blocked", stale: false, waitReason: "model_retry_no_output" },
    local: { started: true, hasBegun: true, optimisticSending: false, responseStarted: false },
  });

  assert.deepEqual(projection, {
    phase: "error",
    showIndicator: true,
    abortable: true,
    source: "lifecycle",
    diagnosticKind: "model-retry-blocked",
  });
});

test("optimistic pre-admission sends remain visibly active without an abort target", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: false,
    engineStatus: "idle",
    lifecycle: null,
    local: { started: true, hasBegun: false, optimisticSending: true, responseStarted: false },
  });

  assert.deepEqual(projection, {
    phase: "responding",
    showIndicator: true,
    abortable: false,
    source: "local",
    diagnosticKind: null,
  });
});

test("assistant response progress changes an active engine run to responding", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "running",
    lifecycle: null,
    local: { started: true, hasBegun: true, optimisticSending: false, responseStarted: true },
  });

  assert.equal(projection.phase, "responding");
  assert.equal(projection.abortable, true);
  assert.equal(projection.source, "engine");
});

test("a missing scope is idle and non-abortable", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: false,
    engineStatus: "idle",
    lifecycle: null,
    local: { started: false, hasBegun: false, optimisticSending: false, responseStarted: false },
  });

  assert.deepEqual(projection, {
    phase: "idle",
    showIndicator: false,
    abortable: false,
    source: null,
    diagnosticKind: null,
  });
});
