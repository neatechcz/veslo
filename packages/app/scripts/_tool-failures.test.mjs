import assert from "node:assert/strict";
import test from "node:test";

import { findUnexpectedToolFailure, getUnexpectedToolFailure } from "./_tool-failures.mjs";

test("getUnexpectedToolFailure catches explicit tool errors", () => {
  const message = getUnexpectedToolFailure({
    type: "tool",
    tool: "webfetch",
    state: {
      status: "error",
      title: "Tool crashed",
      error: "boom",
    },
  });

  assert.equal(message, "Unexpected tool error (webfetch): Tool crashed boom");
});

test("getUnexpectedToolFailure catches completed Chrome profile-lock failures", () => {
  const message = getUnexpectedToolFailure({
    type: "tool",
    tool: "chrome-devtools_list_pages",
    state: {
      status: "completed",
      detail:
        "The browser is already running for /tmp/chrome-profile. Use --isolated to run multiple browser instances.",
    },
  });

  assert.equal(
    message,
    "Unexpected tool error (chrome-devtools_list_pages): The browser is already running for /tmp/chrome-profile. Use --isolated to run multiple browser instances.",
  );
});

test("getUnexpectedToolFailure catches completed timeout signatures", () => {
  const message = getUnexpectedToolFailure({
    type: "tool",
    tool: "chrome-devtools_wait_for",
    state: {
      status: "completed",
      output: "Timed out after waiting 30000ms for selector #ready",
    },
  });

  assert.equal(
    message,
    "Unexpected tool error (chrome-devtools_wait_for): Timed out after waiting 30000ms for selector #ready",
  );
});

test("findUnexpectedToolFailure returns first matching failure from list", () => {
  const message = findUnexpectedToolFailure([
    {
      type: "tool",
      tool: "chrome-devtools_new_page",
      state: { status: "completed", detail: "Opened tab 2" },
    },
    {
      type: "tool",
      tool: "chrome-devtools_wait_for",
      state: { status: "completed", output: "Timed out after waiting 1000ms for text" },
    },
  ]);

  assert.equal(
    message,
    "Unexpected tool error (chrome-devtools_wait_for): Timed out after waiting 1000ms for text",
  );
});

test("findUnexpectedToolFailure ignores non-tool and successful tool parts", () => {
  const message = findUnexpectedToolFailure([
    { type: "text", text: "hello" },
    {
      type: "tool",
      tool: "chrome-devtools_new_page",
      state: { status: "completed", detail: "Opened tab 1" },
    },
  ]);

  assert.equal(message, null);
});
