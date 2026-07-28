import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  clearPerfLogs,
  recordPerfLog,
  setRuntimePerfNativeLoggerForTests,
} from "../../lib/perf-log.js";

const source = readFileSync(new URL("../../lib/perf-log.ts", import.meta.url), "utf8");

test("native runtime performance diagnostics use the bounded batch sink", () => {
  assert.match(source, /const nativeRuntimePerfSink = createBatchedDiagnosticSink<PerfLogRecord>\(/);
  assert.match(source, /maxEntries: 24/);
  assert.match(source, /delayMs: 100/);
  assert.match(source, /nativeRuntimePerfSink\.enqueue\(entry\)/);
  assert.match(source, /window\.addEventListener\("pagehide", nativeRuntimePerfSink\.flush\)/);
  assert.doesNotMatch(source, /logUiEvent\("runtime-perf", `\$\{scope\}:\$\{event\}`, entry\)/);
});

test("runtime-perf sends 24 entries in one native batch and flushes a pending batch on pagehide", () => {
  const root = globalThis as unknown as {
    window?: {
      addEventListener: (event: string, listener: () => void) => void;
    };
    document?: {
      addEventListener: (event: string, listener: () => void) => void;
      visibilityState: "visible" | "hidden";
    };
  };
  const previousWindow = root.window;
  const previousDocument = root.document;
  const previousConsoleLog = console.log;
  const listeners = new Map<string, () => void>();
  const nativeCalls: Array<{
    scope: string;
    message: string;
    payload: { schema: string; entries: Array<{ id: number; event: string }> };
  }> = [];

  root.window = {
    addEventListener: (event, listener) => listeners.set(event, listener),
  };
  root.document = {
    addEventListener: (event, listener) => listeners.set(event, listener),
    visibilityState: "visible",
  };
  console.log = () => undefined;
  clearPerfLogs();
  setRuntimePerfNativeLoggerForTests((scope, message, payload) => {
    nativeCalls.push({
      scope,
      message,
      payload: payload as (typeof nativeCalls)[number]["payload"],
    });
  });

  try {
    for (let index = 1; index <= 24; index += 1) {
      recordPerfLog(true, "workspace.requests", `request-${index}`);
    }

    assert.equal(nativeCalls.length, 1);
    assert.equal(nativeCalls[0]?.scope, "runtime-perf");
    assert.equal(nativeCalls[0]?.message, "batch");
    assert.equal(nativeCalls[0]?.payload.schema, "runtime-perf/v1");
    assert.deepEqual(
      nativeCalls[0]?.payload.entries.map((entry) => entry.id),
      Array.from({ length: 24 }, (_, index) => index + 1),
    );

    recordPerfLog(true, "workspace.requests", "waiting-for-pagehide");
    assert.equal(nativeCalls.length, 1, "one pending entry must wait for lifecycle flush");
    listeners.get("pagehide")?.();

    assert.equal(nativeCalls.length, 2);
    assert.deepEqual(
      nativeCalls[1]?.payload.entries.map((entry) => ({
        id: entry.id,
        event: entry.event,
      })),
      [{ id: 25, event: "waiting-for-pagehide" }],
    );
  } finally {
    setRuntimePerfNativeLoggerForTests(null);
    clearPerfLogs();
    console.log = previousConsoleLog;
    root.window = previousWindow;
    root.document = previousDocument;
  }
});
