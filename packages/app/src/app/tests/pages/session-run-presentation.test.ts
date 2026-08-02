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

test("connection-unavailable lifecycle evidence is a non-streaming recovery block", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "running",
    lifecycle: {
      runId: "run-a",
      status: "submitted",
      stale: false,
      recoveryState: "connection-unavailable",
    },
    local: {
      started: true,
      hasBegun: true,
      optimisticSending: true,
      optimisticAccepted: true,
      acceptedRunId: "run-a",
      responseStarted: false,
    },
  });

  assert.deepEqual(projection, {
    phase: "error",
    showIndicator: false,
    abortable: false,
    source: "lifecycle",
    diagnosticKind: "connection-unavailable",
    recoveryNotice: "connection-unavailable",
    composerMode: "recovery-blocked",
  });
});

test("terminalization pending remains visible but cannot start another local run", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: {
      runId: "run-a",
      status: "running",
      stale: false,
      terminalization: {
        state: "pending",
        reasonCode: "upstream_submit_failed",
        attempts: 2,
        nextAttemptAt: 2_000,
        deadlineAt: 300_000,
      },
    },
    local: { started: true, hasBegun: true, optimisticSending: true, responseStarted: false },
  });

  assert.deepEqual(projection, {
    phase: "thinking",
    showIndicator: true,
    abortable: false,
    source: "lifecycle",
    diagnosticKind: "terminalization-pending",
    composerMode: "recovery-blocked",
  });
});

test("unresolved terminal runtime handoff remains visible and blocks a new local run", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: {
      runId: "run-a",
      status: "failed",
      stale: true,
      terminalHandoff: {
        state: "unresolved",
        reasonCode: "exact_process_alive",
        attempts: 1,
        requestedAt: 1_000,
        decidedAt: 1_100,
      },
    },
    local: { started: true, hasBegun: true, optimisticSending: true, responseStarted: false },
  });

  assert.deepEqual(projection, {
    phase: "error",
    showIndicator: true,
    abortable: false,
    source: "lifecycle",
    diagnosticKind: "terminal-handoff-unresolved",
    recoveryNotice: "terminal-handoff-unresolved",
    composerMode: "recovery-blocked",
  });
});

test("pending terminal runtime handoff remains visible until the server decides it", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: {
      runId: "run-a",
      status: "failed",
      stale: true,
      terminalHandoff: {
        state: "pending",
        reasonCode: "no_current_engine",
        attempts: 2,
        requestedAt: 1_000,
        decidedAt: null,
      },
    },
    local: { started: true, hasBegun: true, optimisticSending: true, responseStarted: false },
  });

  assert.deepEqual(projection, {
    phase: "thinking",
    showIndicator: true,
    abortable: false,
    source: "lifecycle",
    diagnosticKind: "terminal-handoff-pending",
    composerMode: "recovery-blocked",
  });
});

test("transcript-unavailable lifecycle evidence keeps the composer idle without a Stop action", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: {
      runId: "run-a",
      status: "completed",
      stale: false,
      recoveryState: "transcript-unavailable",
    },
    local: {
      started: false,
      hasBegun: true,
      optimisticSending: true,
      optimisticAccepted: true,
      acceptedRunId: "run-a",
      responseStarted: false,
    },
  });

  assert.deepEqual(projection, {
    phase: "error",
    showIndicator: false,
    abortable: false,
    source: "lifecycle",
    diagnosticKind: "transcript-unavailable",
    recoveryNotice: "transcript-unavailable",
    composerMode: "idle",
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

test("all matching terminal lifecycle outcomes leave a retained transcript-sync row independent from the footer", () => {
  for (const status of ["completed", "failed", "aborted"]) {
    const projection = deriveSessionRunPresentation({
      hasSessionScope: true,
      engineStatus: "idle",
      lifecycle: { runId: "run-a", status, stale: false, clientMessageId: "msg-a" },
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

    assert.equal(projection.phase, "idle", status);
    assert.equal(projection.showIndicator, false, status);
  }
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

test("legacy blocked no-output retry stays a background retry while it remains backend-abortable", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "idle",
    lifecycle: { status: "blocked", stale: false, waitReason: "model_retry_no_output" },
    local: { started: true, hasBegun: true, optimisticSending: false, responseStarted: false },
  });

  assert.deepEqual(projection, {
    phase: "retrying",
    showIndicator: true,
    abortable: true,
    source: "lifecycle",
    diagnosticKind: "model-retry",
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

test("exhausted lifecycle observation is visibly degraded without fabricating idle", () => {
  const projection = deriveSessionRunPresentation({
    hasSessionScope: true,
    engineStatus: "submitted",
    lifecycle: {
      runId: "run-a",
      status: "running",
      stale: false,
      recoveryState: "exhausted",
    },
    local: {
      started: true,
      hasBegun: true,
      optimisticSending: true,
      optimisticAccepted: true,
      acceptedRunId: "run-a",
      responseStarted: false,
    },
  });

  assert.deepEqual(projection, {
    phase: "error",
    showIndicator: true,
    abortable: true,
    source: "lifecycle",
    diagnosticKind: "lifecycle-observation-exhausted",
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
