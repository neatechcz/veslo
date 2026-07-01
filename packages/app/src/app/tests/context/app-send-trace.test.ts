import assert from "node:assert/strict";
import test from "node:test";

import { createAppSendTrace } from "../../context/app-send-trace.js";

type TestWindow = {
  __vesloActiveSendTraceId?: string | null;
  __vesloSendTrace?: Array<Record<string, unknown>>;
  __vesloSendTraceSeq?: number;
  __vesloSendTraceStartPerfMsById?: Record<string, number>;
};

function withTestWindow(run: (target: TestWindow) => void | Promise<void>) {
  return async () => {
    const root = globalThis as unknown as Record<string, unknown>;
    const hadWindow = Object.prototype.hasOwnProperty.call(root, "window");
    const previousWindow = root.window;
    const previousConsoleLog = console.log;
    const target: TestWindow = {};
    root.window = target;
    console.log = () => undefined;

    try {
      await run(target);
    } finally {
      console.log = previousConsoleLog;
      if (!hadWindow) {
        Reflect.deleteProperty(root, "window");
      } else {
        root.window = previousWindow;
      }
    }
  };
}

test("app send trace preflight preserves supplied trace id and initializes mutable gates", () => {
  const appSendTrace = createAppSendTrace();
  const preflight = appSendTrace.createSendPreflightContext(" trace-from-composer ");

  assert.equal(preflight.traceId, "trace-from-composer");
  assert.equal(preflight.managedAiReady, false);
  assert.equal(preflight.runtimeHealthOk, false);
  assert.equal(preflight.enginePrepared, false);
  assert.equal(preflight.effectiveSandbox, null);
  assert.equal(preflight.targetWorkspace, null);
  assert.equal(preflight.conversationWorkspaceByDirectory instanceof Map, true);
});

test(
  "app send trace records start and end entries with relative timing",
  withTestWindow(async (target) => {
    const appSendTrace = createAppSendTrace();

    const result = await appSendTrace.sendTraceStep(
      "sendPrompt:test-step",
      async () => "ok",
      { traceId: "trace-step" },
    );

    assert.equal(result, "ok");
    assert.equal(target.__vesloSendTrace?.length, 2);
    assert.equal(target.__vesloSendTrace?.[0]?.event, "sendPrompt:test-step:start");
    assert.equal(target.__vesloSendTrace?.[1]?.event, "sendPrompt:test-step:end");
    assert.equal(target.__vesloSendTrace?.[1]?.traceId, "trace-step");
    assert.equal(target.__vesloSendTrace?.[1]?.outcome, "ok");
    assert.equal(typeof target.__vesloSendTrace?.[1]?.durationMs, "number");
    assert.equal(typeof target.__vesloSendTrace?.[1]?.relativeMs, "number");
  }),
);

test(
  "app send trace imports external trace entries through the same recorder",
  withTestWindow((target) => {
    const appSendTrace = createAppSendTrace();
    target.__vesloActiveSendTraceId = "trace-active";

    appSendTrace.recordExternalSendTraceEntries([
      { event: "external:accepted", detail: "kept" },
      { event: "", detail: "ignored" },
      null,
    ]);

    assert.equal(target.__vesloSendTrace?.length, 1);
    assert.equal(target.__vesloSendTrace?.[0]?.event, "external:accepted");
    assert.equal(target.__vesloSendTrace?.[0]?.traceId, "trace-active");
    assert.equal(target.__vesloSendTrace?.[0]?.detail, "kept");
  }),
);
