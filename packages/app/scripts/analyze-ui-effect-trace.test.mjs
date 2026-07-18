import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeTraceLines,
  dedupeIncidentWindowEntries,
  stableTraceValue,
  summarizeIncidentEntries,
} from "./analyze-ui-effect-trace.mjs";

test("deduplicates overlapping incident-window entries by timestamp, event, and payload", () => {
  const shared = {
    at: 100,
    event: "ui-effect:run",
    payload: { owner: "composer.prompt-sync", equal: true },
  };
  const entries = dedupeIncidentWindowEntries([
    {
      entries: [
        shared,
        {
          at: 101,
          event: "ui-effect:run",
          payload: { owner: "composer.prompt-sync", equal: false },
        },
      ],
    },
    { entries: [shared] },
  ]);

  assert.equal(entries.length, 2);
  assert.equal(
    summarizeIncidentEntries(entries).get("composer.prompt-sync"),
    2,
  );
});

test("uses a deterministic structural key for payloads with a different key order", () => {
  assert.equal(
    stableTraceValue({ b: 2, a: { y: 2, x: 1 } }),
    stableTraceValue({ a: { x: 1, y: 2 }, b: 2 }),
  );
  const trace = analyzeTraceLines([
    JSON.stringify({
      event: "ui-effect-trace:incident-window",
      entries: [{ at: 1, event: "ui-model:derived", payload: { b: 2, a: 1 } }],
    }),
    JSON.stringify({
      event: "ui-effect-trace:incident-window",
      entries: [{ at: 1, event: "ui-model:derived", payload: { a: 1, b: 2 } }],
    }),
  ]);

  assert.equal(trace.incidentEntries.length, 1);
});

test("extracts direct stream benchmark records independently of incident windows", () => {
  const trace = analyzeTraceLines([
    JSON.stringify({
      event: "ui-effect-trace:benchmark",
      kind: "message-blocks-stream",
      payload: { recomputes: 4, memoNoOps: 1 },
    }),
  ]);

  assert.equal(trace.benchmarks.length, 1);
  assert.equal(trace.benchmarks[0].payload.recomputes, 4);
});
