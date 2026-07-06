import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGlobalSdkStreamEvent } from "../../context/global-sdk.js";

test("global SDK stream events unwrap sync payload envelopes", () => {
  const event = normalizeGlobalSdkStreamEvent({
    directory: "/repo",
    payload: {
      type: "sync",
      syncEvent: {
        type: "mcp.tools.changed.2",
        data: { server: "filesystem" },
      },
    },
  });

  assert.deepEqual(event, {
    directory: "/repo",
    payload: {
      type: "mcp.tools.changed",
      properties: { server: "filesystem" },
    },
  });
});

test("global SDK stream events preserve direct payload events", () => {
  const event = normalizeGlobalSdkStreamEvent({
    directory: "/repo",
    payload: {
      type: "lsp.updated",
      properties: { language: "ts" },
    },
  });

  assert.deepEqual(event, {
    directory: "/repo",
    payload: {
      type: "lsp.updated",
      properties: { language: "ts" },
    },
  });
});
