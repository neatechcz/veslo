import assert from "node:assert/strict";
import test from "node:test";

import {
  captureFatalRenderError,
  type ErrorMonitoringClient,
  type ErrorMonitoringScope,
} from "../lib/error-monitoring.js";
import { createRendererRecoveryAction } from "./renderer-error-boundary.js";

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

test("fatal renderer capture returns the monitoring incident id with fatal-only tags", () => {
  const calls: unknown[] = [];
  const tags: Record<string, string> = {};
  const contexts: Record<string, unknown> = {};
  const client: ErrorMonitoringClient = {
    withScope(callback: (scope: ErrorMonitoringScope) => void) {
      callback({
        setTag(key, value) {
          tags[key] = value;
        },
        setContext(key, value) {
          contexts[key] = value;
        },
        setLevel() {},
      });
    },
    captureException(error) {
      calls.push(error);
      return "fatal-render-event-123";
    },
    captureMessage(message) {
      calls.push(message);
      return "unexpected-message-event";
    },
  };

  const error = new Error("render failed");
  assert.equal(captureFatalRenderError(error, client), "fatal-render-event-123");
  assert.deepEqual(calls, [error]);
  assert.deepEqual(tags, {
    "veslo.context": "renderer.fatal",
    "veslo.severity": "error",
    "veslo.fatal": "true",
  });
  assert.deepEqual(contexts, {
    veslo: {
      context: "renderer.fatal",
      severity: "error",
      fatal: true,
    },
  });
});

test("renderer recovery relaunches first and falls back to a browser reload", async () => {
  const calls: string[] = [];
  const recover = createRendererRecoveryAction({
    restart: async () => {
      calls.push("restart");
      throw new Error("desktop relaunch unavailable");
    },
    reload: () => calls.push("reload"),
  });

  recover();
  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(calls, ["restart", "reload"]);
});

test("renderer recovery does not reload when relaunch is accepted", async () => {
  const calls: string[] = [];
  const recover = createRendererRecoveryAction({
    restart: () => {
      calls.push("restart");
    },
    reload: () => {
      calls.push("reload");
    },
  });

  recover();
  await flushMicrotasks();

  assert.deepEqual(calls, ["restart"]);
});
