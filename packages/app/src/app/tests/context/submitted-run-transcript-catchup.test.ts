import assert from "node:assert/strict";
import test from "node:test";

import {
  createSubmittedRunTranscriptCatchup,
  type SubmittedRunTranscriptCatchupTarget,
} from "../../context/submitted-run-transcript-catchup.js";
import type { MessageInfo } from "../../types.js";

const message = (id: string, role: "user" | "assistant"): MessageInfo => ({
  id,
  role,
  sessionID: "sess-a",
} as MessageInfo);

type CatchupTestSnapshot = {
  source: "server";
  sessionId: string;
  opencodeSessionId?: string;
  messages: MessageInfo[];
};

function createManualTimers() {
  const scheduled: Array<{ timer: object; callback: () => void; delayMs: number }> = [];
  return {
    scheduled,
    scheduleTimer(callback: () => void, delayMs: number) {
      const timer = {};
      scheduled.push({ timer, callback, delayMs });
      return timer;
    },
    clearTimer(timer: unknown) {
      const index = scheduled.findIndex((entry) => entry.timer === timer);
      if (index >= 0) scheduled.splice(index, 1);
    },
    async runNext() {
      const entry = scheduled.shift();
      assert.ok(entry, "expected a scheduled timer");
      entry.callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("submitted run catch-up hydrates the explicit target transcript when no assistant event was observed", async () => {
  const timers = createManualTimers();
  const loadCalls: SubmittedRunTranscriptCatchupTarget[] = [];
  const traces: string[] = [];
  let cachedMessages: MessageInfo[] = [];

  const catchup = createSubmittedRunTranscriptCatchup({
    selectedSessionId: () => "sess-a",
    resolveSelectedSessionWorkspaceId: () => "ws-a",
    assistantObservationVersion: () => 0,
    assistantMessageCount: () => cachedMessages.filter((entry) => entry.role === "assistant").length,
    loadTranscript: async (target) => {
      loadCalls.push(target);
      return {
        source: "server",
        sessionId: target.sessionId,
        messages: [message("msg-user", "user"), message("msg-assistant", "assistant")],
      };
    },
    hydrateTranscriptSnapshot: (snapshot) => {
      cachedMessages = snapshot.messages;
    },
    trace: (event) => traces.push(event),
    delaysMs: [0],
    scheduleTimer: timers.scheduleTimer,
    clearTimer: timers.clearTimer,
  });

  catchup.schedule({
    workspaceId: "ws-a",
    sessionId: "sess-a",
    directory: "/workspace-a",
    runId: "run-a",
    traceId: "trace-a",
    reason: "test",
  });
  await timers.runNext();

  assert.equal(loadCalls.length, 1);
  assert.deepEqual({
    workspaceId: loadCalls[0]?.workspaceId,
    sessionId: loadCalls[0]?.sessionId,
    directory: loadCalls[0]?.directory,
    runId: loadCalls[0]?.runId,
  }, {
    workspaceId: "ws-a",
    sessionId: "sess-a",
    directory: "/workspace-a",
    runId: "run-a",
  });
  assert.equal(cachedMessages.filter((entry) => entry.role === "assistant").length, 1);
  assert.ok(traces.includes("submitted-run-transcript-catchup:scheduled"));
  assert.ok(traces.includes("submitted-run-transcript-catchup:done"));
  assert.equal(timers.scheduled.length, 0);
});

test("submitted run catch-up retargets OpenCode transcript ids to the UI target session", async () => {
  const timers = createManualTimers();
  const hydrated: CatchupTestSnapshot[] = [];

  const catchup = createSubmittedRunTranscriptCatchup<CatchupTestSnapshot>({
    selectedSessionId: () => "ui-session-a",
    resolveSelectedSessionWorkspaceId: () => "ws-a",
    assistantObservationVersion: () => 0,
    assistantMessageCount: () => 0,
    loadTranscript: async () => ({
      source: "server",
      sessionId: "engine-session-a",
      messages: [message("msg-assistant", "assistant")],
    }),
    hydrateTranscriptSnapshot: (snapshot) => {
      hydrated.push(snapshot);
    },
    delaysMs: [0],
    scheduleTimer: timers.scheduleTimer,
    clearTimer: timers.clearTimer,
  });

  catchup.schedule({
    workspaceId: "ws-a",
    sessionId: "ui-session-a",
    runId: "run-a",
    reason: "test",
  });
  await timers.runNext();

  const hydratedSnapshot = hydrated[0] ?? null;
  assert.ok(hydratedSnapshot, "expected catch-up to hydrate the transcript");
  assert.equal(hydratedSnapshot.sessionId, "ui-session-a");
  assert.equal(hydratedSnapshot.opencodeSessionId, "engine-session-a");
});

test("submitted run catch-up skips transcript reads after an assistant SSE event was observed", async () => {
  const timers = createManualTimers();
  let observationVersion = 0;
  let loadCalls = 0;

  const catchup = createSubmittedRunTranscriptCatchup({
    selectedSessionId: () => "sess-a",
    resolveSelectedSessionWorkspaceId: () => "ws-a",
    assistantObservationVersion: () => observationVersion,
    assistantMessageCount: () => 0,
    loadTranscript: async () => {
      loadCalls += 1;
      return null;
    },
    hydrateTranscriptSnapshot: () => undefined,
    delaysMs: [0],
    scheduleTimer: timers.scheduleTimer,
    clearTimer: timers.clearTimer,
  });

  catchup.schedule({
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
    reason: "test",
  });
  observationVersion = 1;
  await timers.runNext();

  assert.equal(loadCalls, 0);
  assert.equal(timers.scheduled.length, 0);
});

test("submitted run catch-up skips transcript reads when an assistant is already cached", async () => {
  const timers = createManualTimers();
  let assistantCount = 0;
  let loadCalls = 0;
  const traces: string[] = [];

  const catchup = createSubmittedRunTranscriptCatchup({
    selectedSessionId: () => "sess-a",
    resolveSelectedSessionWorkspaceId: () => "ws-a",
    assistantObservationVersion: () => 0,
    assistantMessageCount: () => assistantCount,
    loadTranscript: async () => {
      loadCalls += 1;
      return null;
    },
    hydrateTranscriptSnapshot: () => undefined,
    trace: (event) => traces.push(event),
    delaysMs: [0],
    scheduleTimer: timers.scheduleTimer,
    clearTimer: timers.clearTimer,
  });

  catchup.schedule({
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
    reason: "test",
  });
  assistantCount = 1;
  await timers.runNext();

  assert.equal(loadCalls, 0);
  assert.ok(traces.includes("submitted-run-transcript-catchup:skip-assistant-cached"));
});

test("submitted run catch-up waits for the submitted session to become selected", async () => {
  const timers = createManualTimers();
  let selectedSessionId = "sess-other";
  let loadCalls = 0;
  let cachedMessages: MessageInfo[] = [];

  const catchup = createSubmittedRunTranscriptCatchup({
    selectedSessionId: () => selectedSessionId,
    resolveSelectedSessionWorkspaceId: () => "ws-a",
    assistantObservationVersion: () => 0,
    assistantMessageCount: () => cachedMessages.filter((entry) => entry.role === "assistant").length,
    loadTranscript: async () => {
      loadCalls += 1;
      return {
        source: "server",
        sessionId: "sess-a",
        messages: [message("msg-assistant", "assistant")],
      };
    },
    hydrateTranscriptSnapshot: (snapshot) => {
      cachedMessages = snapshot.messages;
    },
    delaysMs: [0, 0],
    scheduleTimer: timers.scheduleTimer,
    clearTimer: timers.clearTimer,
  });

  catchup.schedule({
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
    reason: "test",
  });
  await timers.runNext();
  assert.equal(loadCalls, 0);
  assert.equal(timers.scheduled.length, 1);

  selectedSessionId = "sess-a";
  await timers.runNext();

  assert.equal(loadCalls, 1);
  assert.equal(cachedMessages.filter((entry) => entry.role === "assistant").length, 1);
});

test("submitted run catch-up does not hydrate through a mismatched selected workspace scope", async () => {
  const timers = createManualTimers();
  const traces: string[] = [];
  let loadCalls = 0;

  const catchup = createSubmittedRunTranscriptCatchup({
    selectedSessionId: () => "sess-a",
    resolveSelectedSessionWorkspaceId: () => "ws-b",
    assistantObservationVersion: () => 0,
    assistantMessageCount: () => 0,
    loadTranscript: async () => {
      loadCalls += 1;
      return {
        source: "server",
        sessionId: "sess-a",
        messages: [message("msg-assistant", "assistant")],
      };
    },
    hydrateTranscriptSnapshot: () => undefined,
    trace: (event) => traces.push(event),
    delaysMs: [0],
    scheduleTimer: timers.scheduleTimer,
    clearTimer: timers.clearTimer,
  });

  catchup.schedule({
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
    reason: "test",
  });
  await timers.runNext();

  assert.equal(loadCalls, 0);
  assert.ok(traces.includes("submitted-run-transcript-catchup:defer-workspace-mismatch"));
  assert.ok(traces.includes("submitted-run-transcript-catchup:exhausted"));
});

test("submitted run catch-up cancels scheduled and in-flight work on dispose", async () => {
  const timers = createManualTimers();
  const pendingLoad: { resolve?: (snapshot: CatchupTestSnapshot) => void } = {};
  let loadCalls = 0;
  let hydrateCalls = 0;

  const catchup = createSubmittedRunTranscriptCatchup<CatchupTestSnapshot>({
    selectedSessionId: () => "sess-a",
    resolveSelectedSessionWorkspaceId: () => "ws-a",
    assistantObservationVersion: () => 0,
    assistantMessageCount: () => 0,
    loadTranscript: async () => {
      loadCalls += 1;
      return new Promise<CatchupTestSnapshot>((resolve) => {
        pendingLoad.resolve = resolve;
      });
    },
    hydrateTranscriptSnapshot: () => {
      hydrateCalls += 1;
    },
    delaysMs: [0, 0],
    scheduleTimer: timers.scheduleTimer,
    clearTimer: timers.clearTimer,
  });

  catchup.schedule({
    workspaceId: "ws-a",
    sessionId: "sess-a",
    runId: "run-a",
    reason: "test",
  });
  const run = timers.runNext();
  await Promise.resolve();
  assert.equal(loadCalls, 1);

  catchup.dispose();
  assert.ok(pendingLoad.resolve, "expected an in-flight transcript read");
  pendingLoad.resolve({
    source: "server",
    sessionId: "sess-a",
    messages: [message("msg-assistant", "assistant")],
  });
  await run;

  assert.equal(hydrateCalls, 0);
  assert.equal(timers.scheduled.length, 0);
});
