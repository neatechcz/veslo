import assert from "node:assert/strict";
import test from "node:test";

import { createBatchedDiagnosticSink } from "../../lib/batched-diagnostic-sink.js";

test("batched diagnostic sink coalesces entries until its scheduled flush", () => {
  let scheduled: (() => void) | undefined;
  let scheduleCount = 0;
  const flushed: string[][] = [];
  const sink = createBatchedDiagnosticSink<string>({
    maxEntries: 4,
    delayMs: 100,
    schedule: (callback) => {
      scheduleCount += 1;
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => undefined,
    flush: (entries) => flushed.push(entries),
  });

  sink.enqueue("a");
  sink.enqueue("b");
  assert.equal(scheduleCount, 1);
  assert.deepEqual(flushed, []);

  scheduled?.();
  assert.deepEqual(flushed, [["a", "b"]]);
});

test("batched diagnostic sink flushes immediately at its bounded batch size", () => {
  const flushed: number[][] = [];
  const sink = createBatchedDiagnosticSink<number>({
    maxEntries: 2,
    delayMs: 100,
    schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    cancel: () => undefined,
    flush: (entries) => flushed.push(entries),
  });

  sink.enqueue(1);
  sink.enqueue(2);
  assert.deepEqual(flushed, [[1, 2]]);
});
