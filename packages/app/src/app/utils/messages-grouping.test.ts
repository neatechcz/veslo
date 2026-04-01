import assert from "node:assert/strict";
import test from "node:test";

import { groupMessageParts } from "./messages.js";

test("groupMessageParts omits reasoning-only groups when thinking is hidden", () => {
  const groups = groupMessageParts(
    [
      {
        type: "reasoning",
        text: "Analyzing context",
      } as any,
    ],
    "msg-1",
    { showThinking: false } as any,
  );

  assert.equal(groups.length, 0);
});

test("groupMessageParts keeps reasoning groups by default", () => {
  const groups = groupMessageParts(
    [
      {
        type: "reasoning",
        text: "Analyzing context",
      } as any,
    ],
    "msg-2",
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.kind, "steps");
});

test("groupMessageParts still preserves tool steps when thinking is hidden", () => {
  const groups = groupMessageParts(
    [
      {
        type: "reasoning",
        text: "Analyzing context",
      } as any,
      {
        type: "tool",
        tool: "read",
        state: { input: { filePath: "README.md" } },
      } as any,
    ],
    "msg-3",
    { showThinking: false } as any,
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.kind, "steps");
  if (groups[0]?.kind === "steps") {
    assert.equal(groups[0].parts.length, 1);
    assert.equal(groups[0].parts[0]?.type, "tool");
  }
});
