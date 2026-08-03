import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { createAppSendTrace } from "../../context/app-send-trace.js";

const sessionPageSource = readFileSync(
  new URL("../../pages/session.tsx", import.meta.url),
  "utf8",
);
const composerSource = readFileSync(
  new URL("../../components/session/composer.tsx", import.meta.url),
  "utf8",
);

type TestWindow = {
  __vesloActiveSendTraceId?: string | null;
  __vesloSendFailureSnapshots?: Record<string, unknown>;
  __vesloSendTrace?: Array<Record<string, unknown>>;
  __vesloSendTraceSeq?: number;
  __vesloSendTraceStartPerfMsById?: Record<string, number>;
  localStorage?: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  };
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
  const preflight = appSendTrace.createSendPreflightContext(
    " trace-from-composer ",
  );

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
    assert.equal(
      target.__vesloSendTrace?.[0]?.event,
      "sendPrompt:test-step:start",
    );
    assert.equal(
      target.__vesloSendTrace?.[1]?.event,
      "sendPrompt:test-step:end",
    );
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

test(
  "app send trace redacts raw paths, URLs, prompt content, and credentials",
  withTestWindow((target) => {
    const appSendTrace = createAppSendTrace();

    appSendTrace.recordSendTrace("sendPrompt:redaction", {
      traceId: "trace-redaction",
      workspaceRoot: "C:\\Users\\name\\private-repo",
      directory: "C:\\Users\\name\\private-repo\\src",
      baseUrl: "http://127.0.0.1:4096/workspace/private/opencode",
      prompt: "private prompt",
      nested: {
        path: "C:\\Users\\name\\private-repo\\secret.txt",
        APIKey: "secret",
        token: "secret",
      },
    });

    const entry = target.__vesloSendTrace?.[0];
    assert.equal(entry?.workspaceRoot, "[redacted]");
    assert.equal(entry?.directory, "[redacted]");
    assert.equal(entry?.baseUrl, "[redacted]");
    assert.equal(entry?.prompt, "[redacted]");
    assert.deepEqual(entry?.nested, {
      path: "[redacted]",
      APIKey: "[redacted]",
      token: "[redacted]",
    });
  }),
);

test(
  "app send trace retains bounded safe first and final failures by workspace",
  withTestWindow((target) => {
    const appSendTrace = createAppSendTrace();

    appSendTrace.recordSendTrace("sendPrompt:server-submit-existing:error", {
      traceId: "trace-failure",
      workspaceId: "workspace-a",
      outcome: "error",
      workspaceRoot: "C:\\Users\\name\\private-repo",
      message: "request to http://127.0.0.1:4096/private failed",
    });
    appSendTrace.recordSendTrace(
      "sendPrompt:server-submit-existing:preflight-error",
      {
        traceId: "trace-failure",
        workspaceId: "workspace-a",
        phase: "preflight",
        code: "local_live_binding_unavailable",
        httpAttempted: false,
      },
    );

    assert.deepEqual(target.__vesloSendFailureSnapshots, {
      "workspace-a": {
        workspaceId: "workspace-a",
        firstFailure: {
          at: target.__vesloSendTrace?.[0]?.at,
          traceId: "trace-failure",
          event: "sendPrompt:server-submit-existing:error",
          phase: null,
          code: null,
          status: null,
          httpAttempted: null,
        },
        finalFailure: {
          at: target.__vesloSendTrace?.[1]?.at,
          traceId: "trace-failure",
          event: "sendPrompt:server-submit-existing:preflight-error",
          phase: "preflight",
          code: "local_live_binding_unavailable",
          status: null,
          httpAttempted: false,
        },
        updatedAt: target.__vesloSendTrace?.[1]?.at,
      },
    });
  }),
);

test(
  "app send trace normalizes persisted failure snapshots before exposing them",
  withTestWindow((target) => {
    const storedAt = new Date().toISOString();
    const stored = JSON.stringify({
      "workspace-a": {
        workspaceId: "workspace-a",
        firstFailure: {
          at: storedAt,
          traceId: "trace-stored",
          event: "sendPrompt:error",
          message: "C:\\Users\\name\\private-repo",
        },
        finalFailure: null,
        updatedAt: storedAt,
      },
    });
    target.localStorage = {
      getItem: () => stored,
      setItem: () => undefined,
    };

    createAppSendTrace();

    assert.deepEqual(target.__vesloSendFailureSnapshots, {
      "workspace-a": {
        workspaceId: "workspace-a",
        firstFailure: {
          at: storedAt,
          traceId: "trace-stored",
          event: "sendPrompt:error",
          phase: null,
          code: null,
          status: null,
          httpAttempted: null,
        },
        finalFailure: null,
        updatedAt: storedAt,
      },
    });
  }),
);

test("session-page trace uses the shared payload sanitizer before its local buffer", () => {
  const traceStart = sessionPageSource.indexOf("function recordSendTrace(");
  const traceEnd = sessionPageSource.indexOf("\nconst sessionUiMutationTraceEnabled", traceStart);
  assert.ok(traceStart >= 0 && traceEnd > traceStart);
  const traceSource = sessionPageSource.slice(traceStart, traceEnd);

  assert.match(traceSource, /sanitizeSendWorkflowTracePayload\(payload\)/);
  assert.match(traceSource, /\.\.\.\(safePayload \?\? \{\}\)/);
  assert.match(
    traceSource,
    /recordSendWorkflowTrace\("session-page", event, safePayload\)/,
  );
  assert.doesNotMatch(traceSource, /\.\.\.\(payload \?\? \{\}\)/);
});

test("composer trace uses the shared payload sanitizer before its local buffer", () => {
  const traceStart = composerSource.indexOf("function recordSendTrace(");
  const traceEnd = composerSource.indexOf("\nfunction setActiveSendTraceId", traceStart);
  assert.ok(traceStart >= 0 && traceEnd > traceStart);
  const traceSource = composerSource.slice(traceStart, traceEnd);

  assert.match(traceSource, /sanitizeSendWorkflowTracePayload\(payload\)/);
  assert.match(traceSource, /\.\.\.\(safePayload \?\? \{\}\)/);
  assert.match(
    traceSource,
    /recordSendWorkflowTrace\("composer", event, safePayload\)/,
  );
  assert.doesNotMatch(traceSource, /\.\.\.\(payload \?\? \{\}\)/);
});
