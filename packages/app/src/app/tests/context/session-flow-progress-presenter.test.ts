import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionFlowProgressPresenter,
  type SessionFlowProgressEvent,
} from "../../context/session-flow-progress-presenter.js";

function createHarness() {
  const calls: string[] = [];
  let busy = false;
  let busyLabel: string | null = null;
  let busyStartedAt: number | null = null;
  let creatingSession = false;
  let now = 100;

  const presenter = createSessionFlowProgressPresenter({
    now: () => now,
    setBusy: (value) => {
      calls.push(`busy:${String(value)}`);
      busy = value;
    },
    setBusyLabel: (value) => {
      calls.push(`label:${value ?? "null"}`);
      busyLabel = value;
    },
    setBusyStartedAt: (value) => {
      calls.push(`started:${value === null ? "null" : String(value)}`);
      busyStartedAt = value;
    },
    setCreatingSession: (value) => {
      calls.push(`creating:${String(value)}`);
      creatingSession = value;
    },
  });

  return {
    calls,
    emit: (event: SessionFlowProgressEvent) => presenter.emit(event),
    setNow: (value: number) => {
      now = value;
    },
    state: () => ({ busy, busyLabel, busyStartedAt, creatingSession }),
  };
}

test("session flow progress presenter maps flow events to stable UI labels", () => {
  const harness = createHarness();

  harness.emit({ type: "runtime.connecting" });
  assert.deepEqual(harness.state(), {
    busy: true,
    busyLabel: "status.connecting",
    busyStartedAt: 100,
    creatingSession: false,
  });

  harness.setNow(125);
  harness.emit({ type: "conversation.running" });
  assert.deepEqual(harness.state(), {
    busy: true,
    busyLabel: "status.running",
    busyStartedAt: 100,
    creatingSession: false,
  });
});

test("session flow progress presenter clears create/loading progress idempotently", () => {
  const harness = createHarness();

  harness.emit({ type: "session.creating" });
  harness.setNow(125);
  harness.emit({ type: "session.loading" });
  harness.emit({ type: "flow.idle" });
  harness.emit({ type: "flow.idle" });

  assert.deepEqual(harness.state(), {
    busy: false,
    busyLabel: null,
    busyStartedAt: null,
    creatingSession: false,
  });
  assert.deepEqual(harness.calls.filter((call) => call.startsWith("started:")), [
    "started:100",
    "started:null",
    "started:null",
  ]);
});

test("session flow progress presenter dedupes overlapping send and create owners", () => {
  const harness = createHarness();

  harness.emit({ type: "runtime.connecting", owner: "send" });
  harness.setNow(125);
  harness.emit({ type: "session.creating", owner: "create" });
  harness.emit({ type: "session.loading", owner: "create" });
  harness.emit({ type: "flow.idle", owner: "create" });

  assert.deepEqual(harness.state(), {
    busy: true,
    busyLabel: "status.connecting",
    busyStartedAt: 100,
    creatingSession: false,
  });

  harness.emit({ type: "conversation.running", owner: "send" });
  assert.deepEqual(harness.state(), {
    busy: true,
    busyLabel: "status.running",
    busyStartedAt: 100,
    creatingSession: false,
  });

  harness.emit({ type: "flow.idle", owner: "send" });
  assert.deepEqual(harness.state(), {
    busy: false,
    busyLabel: null,
    busyStartedAt: null,
    creatingSession: false,
  });
});
