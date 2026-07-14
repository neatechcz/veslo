import assert from "node:assert/strict";
import test from "node:test";

import { recordSendWorkflowTrace } from "../../lib/send-workflow-trace.js";

type TraceWindow = {
  localStorage: { getItem: (key: string) => string | null };
  __vesloSendWorkflowTraceEnabled?: boolean;
  __vesloSendWorkflowTrace?: Array<Record<string, unknown>>;
  __vesloSendWorkflowTraceSeq?: number;
  __vesloSendWorkflowTraceStartPerfMsById?: Record<string, number>;
};

function withTraceWindow(
  supportDiagnostics: "0" | "1",
  run: (target: TraceWindow) => void,
) {
  return () => {
    const root = globalThis as unknown as Record<string, unknown>;
    const hadWindow = Object.prototype.hasOwnProperty.call(root, "window");
    const previousWindow = root.window;
    const target: TraceWindow = {
      localStorage: {
        getItem: (key) => key === "veslo.supportDiagnostics" ? supportDiagnostics : null,
      },
      __vesloSendWorkflowTraceEnabled: true,
    };
    root.window = target;

    try {
      run(target);
    } finally {
      if (!hadWindow) {
        Reflect.deleteProperty(root, "window");
      } else {
        root.window = previousWindow;
      }
    }
  };
}

test(
  "support diagnostics records a workflow trace outside developer mode",
  withTraceWindow("1", (target) => {
    recordSendWorkflowTrace("test", "support-diagnostics:enabled", undefined, { developerMode: false });

    assert.equal(target.__vesloSendWorkflowTrace?.length, 1);
    assert.equal(target.__vesloSendWorkflowTrace?.[0]?.event, "support-diagnostics:enabled");
  }),
);

test(
  "explicitly disabled support diagnostics suppress workflow traces",
  withTraceWindow("0", (target) => {
    recordSendWorkflowTrace("test", "support-diagnostics:disabled");

    assert.equal(target.__vesloSendWorkflowTrace, undefined);
  }),
);
