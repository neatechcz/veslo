import assert from "node:assert/strict";
import test from "node:test";

import type { Part } from "@opencode-ai/sdk/v2/client";

import { detectChromeMcpCompletedError } from "../../lib/chrome-mcp-error.js";

const toolPart = (input: {
  tool: string;
  status: string;
  detail?: string;
  output?: unknown;
  title?: string;
}): Part =>
  ({
    id: "part-1",
    messageID: "msg-1",
    sessionID: "ses-1",
    type: "tool",
    tool: input.tool,
    state: {
      status: input.status,
      detail: input.detail,
      output: input.output,
      title: input.title,
    },
  }) as unknown as Part;

test("detects Chrome MCP profile-lock failures even when tool status is completed", () => {
  const part = toolPart({
    tool: "chrome-devtools_new_page",
    status: "completed",
    detail:
      "The browser is already running for /Users/test/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances.",
  });

  assert.equal(
    detectChromeMcpCompletedError(part),
    "Chrome MCP failed: The browser is already running for /Users/test/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances.",
  );
});

test("detects Chrome MCP profile-lock failures when conflict text is in output", () => {
  const part = toolPart({
    tool: "chrome-devtools_list_pages",
    status: "completed",
    output:
      "The browser is already running for /Users/test/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances.",
  });

  assert.equal(
    detectChromeMcpCompletedError(part),
    "Chrome MCP failed: The browser is already running for /Users/test/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances.",
  );
});

test("ignores normal completed Chrome MCP tool calls", () => {
  const part = toolPart({
    tool: "chrome-devtools_new_page",
    status: "completed",
    detail: "Opened tab 2",
  });

  assert.equal(detectChromeMcpCompletedError(part), null);
});

test("ignores profile-lock-like text for non-Chrome tools", () => {
  const part = toolPart({
    tool: "webfetch",
    status: "completed",
    detail:
      "The browser is already running for /Users/test/.cache/chrome-devtools-mcp/chrome-profile. Use --isolated to run multiple browser instances.",
  });

  assert.equal(detectChromeMcpCompletedError(part), null);
});
