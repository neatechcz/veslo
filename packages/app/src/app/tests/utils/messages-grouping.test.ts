import assert from "node:assert/strict";
import test from "node:test";

import { groupMessageParts } from "../../utils/messages.js";

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

test("groupMessageParts does not emit a duplicate text group for attachment file parts", () => {
  const groups = groupMessageParts(
    [
      {
        type: "text",
        text: "posílám screenshot, žádná taková sekce tam není",
      } as any,
      {
        type: "file",
        filename: "Screenshot 2026-04-08 at 11.43.22.png",
        mime: "image/png",
        url: "data:image/png;base64,AAAA",
      } as any,
    ],
    "msg-4",
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.kind, "text");
  if (groups[0]?.kind === "text") {
    assert.equal(groups[0].part.type, "text");
    assert.equal((groups[0].part as any).text, "posílám screenshot, žádná taková sekce tam není");
  }
});

test("groupMessageParts still preserves workspace file reference parts", () => {
  const groups = groupMessageParts(
    [
      {
        type: "text",
        text: "Mrkni na tenhle soubor",
      } as any,
      {
        type: "file",
        filename: "README.md",
        mime: "text/plain",
        url: "file:///workspace/README.md",
      } as any,
    ],
    "msg-5",
  );

  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.kind, "text");
  assert.equal(groups[1]?.kind, "text");
  if (groups[1]?.kind === "text") {
    assert.equal(groups[1].part.type, "file");
  }
});
