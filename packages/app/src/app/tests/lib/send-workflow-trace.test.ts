import assert from "node:assert/strict";
import test from "node:test";

import {
  recordSendWorkflowTrace,
  sanitizeSendWorkflowTracePayload,
} from "../../lib/send-workflow-trace.js";

type TraceWindow = {
  localStorage: { getItem: (key: string) => string | null };
  __PILOT__?: Record<string, never>;
  __vesloSendWorkflowTraceEnabled?: boolean;
  __vesloSendWorkflowTrace?: Array<Record<string, unknown>>;
  __vesloSendWorkflowTraceSeq?: number;
  __vesloSendWorkflowTraceStartPerfMsById?: Record<string, number>;
};

function withTraceWindow(
  supportDiagnostics: "0" | "1" | null,
  run: (target: TraceWindow) => void,
  options?: { pilot?: boolean },
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
      ...(options?.pilot ? { __PILOT__: {} } : {}),
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

test("credential trace redaction preserves the credential label without a literal replacement token", () => {
  assert.equal(
    sanitizeSendWorkflowTracePayload("token=private-value"),
    "token=[redacted]",
  );
});

test("trace redaction removes encoded workspace paths from composite session keys", () => {
  const sanitized = sanitizeSendWorkflowTracePayload({
    baseSessionKey: "ws2:workspace:session:session:c%3A%2FUsers%2Fname%2Fprivate-repo",
    currentSessionQueueKey: "ws2:workspace:session:session:c%3A%2FUsers%2Fname%2Fprivate-repo",
    rowKey: "ws2:workspace:session:session:c%3A%2FUsers%2Fname%2Fprivate-repo",
    sessionKey: "ws2:workspace:session:session:c%3A%2FUsers%2Fname%2Fprivate-repo",
  }) as Record<string, string>;

  assert.deepEqual(sanitized, {
    baseSessionKey: "[redacted]",
    currentSessionQueueKey: "[redacted]",
    rowKey: "[redacted]",
    sessionKey: "[redacted]",
  });
});

test(
  "explicitly disabled support diagnostics suppress workflow traces",
  withTraceWindow("0", (target) => {
    recordSendWorkflowTrace("test", "support-diagnostics:disabled");

    assert.equal(target.__vesloSendWorkflowTrace, undefined);
  }),
);

test(
  "tauri-pilot records managed runtime traces without enabling developer mode",
  withTraceWindow(null, (target) => {
    recordSendWorkflowTrace("test", "pilot:managed-runtime", undefined, { developerMode: false });

    assert.equal(target.__vesloSendWorkflowTrace?.length, 1);
    assert.equal(target.__vesloSendWorkflowTrace?.[0]?.event, "pilot:managed-runtime");
  }, { pilot: true }),
);

test(
  "forced diagnostic traces use the shared batch sink while runtime diagnostics remain enabled",
  withTraceWindow(null, (target) => {
    recordSendWorkflowTrace("ui-effect-trace", "ui-effect-trace:benchmark", undefined, {
      developerMode: false,
      force: true,
    });

    assert.equal(target.__vesloSendWorkflowTrace?.length, 1);
    assert.equal(target.__vesloSendWorkflowTrace?.[0]?.source, "ui-effect-trace");
  }),
);

test("a credential scheme prefix does not leave the secret behind", () => {
  const sanitized = sanitizeSendWorkflowTracePayload({
    header: "authorization: Bearer sk-live-should-not-survive",
    basic: "Authorization=Basic dXNlcjpzZWNyZXQ=",
    bare: "token: sk-live-bare-secret",
  }) as Record<string, string>;

  // Consuming only one token after the key redacted `Bearer` and left the
  // secret itself in the trace.
  assert.doesNotMatch(JSON.stringify(sanitized), /sk-live-should-not-survive/);
  assert.doesNotMatch(JSON.stringify(sanitized), /dXNlcjpzZWNyZXQ=/);
  assert.doesNotMatch(JSON.stringify(sanitized), /sk-live-bare-secret/);
  assert.match(sanitized.header, /\[redacted\]/);
  assert.match(sanitized.basic, /\[redacted\]/);
  assert.match(sanitized.bare, /\[redacted\]/);
});
