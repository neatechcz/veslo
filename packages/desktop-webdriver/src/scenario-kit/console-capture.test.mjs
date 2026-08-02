import assert from "node:assert/strict";
import test from "node:test";

import { collectDevConsoleLogs } from "./console-capture.mjs";

test("console capture uses the runner-owned browser state without optional protocol logs", async () => {
  let executeCalls = 0;
  const browser = {
    async execute(callback) {
      executeCalls += 1;
      const previousWindow = globalThis.window;
      globalThis.window = {
        __vesloWebDriverConsoleCapture: {
          entries: [{ level: "error", args: ["captured"] }],
        },
      };
      try {
        return callback();
      } finally {
        globalThis.window = previousWindow;
      }
    },
    async getLogs() {
      throw new Error("getLogs must not be called");
    },
  };

  const logs = await collectDevConsoleLogs(browser);

  assert.equal(executeCalls, 1);
  assert.deepEqual(logs.captured, [{ level: "error", args: ["captured"] }]);
  assert.deepEqual(logs.protocol, []);
  assert.equal(logs.protocolUnavailable, "loopback-webdriver-browser-logs-unsupported");
});
