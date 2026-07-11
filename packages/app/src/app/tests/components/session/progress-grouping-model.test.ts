import assert from "node:assert/strict";
import test from "node:test";
import type { Part } from "@opencode-ai/sdk/v2/client";

import { buildProgressRenderBlocks } from "../../../components/session/progress-grouping-model.js";
import type { MessageWithParts } from "../../../types";

function message(id: string, role: "user" | "assistant", parts: Part[]): MessageWithParts {
  return {
    info: {
      id,
      role,
      sessionID: "session-1",
      time: { created: Date.now() },
    } as any,
    parts: parts.map((part, index) => ({
      ...part,
      id: `${id}-part-${index}`,
      sessionID: "session-1",
      messageID: id,
    })) as Part[],
  };
}

test("collapses completed intermediate assistant activity between user and final answer", () => {
  const blocks = buildProgressRenderBlocks({
    messages: [
      message("u1", "user", [{ type: "text", text: "Fix it" } as any]),
      message("a1", "assistant", [{ type: "tool", tool: "read", state: { input: { filePath: "README.md" } } } as any]),
      message("a2", "assistant", [{ type: "text", text: "I found the issue." } as any]),
      message("a3", "assistant", [{ type: "tool", tool: "edit", state: { input: { filePath: "README.md" } } } as any]),
      message("a4", "assistant", [{ type: "text", text: "Done." } as any]),
    ],
    isStreaming: false,
    showThinking: false,
    developerMode: false,
  });

  assert.deepEqual(blocks.map((block) => block.kind), ["message", "progress-group", "message"]);
  const group = blocks[1];
  assert.equal(group?.kind, "progress-group");
  if (group?.kind !== "progress-group") return;
  assert.deepEqual(group.messageIds, ["a1", "a2", "a3"]);
  assert.deepEqual(group.items.map((item) => item.kind), ["steps", "comment", "steps"]);
});

test("keeps attachment-only user history as a canonical message block", () => {
  const blocks = buildProgressRenderBlocks({
    messages: [
      message("u-file", "user", [{
        type: "file",
        filename: "canonical-only.txt",
        mime: "text/plain",
        url: "data:text/plain;base64,Y2Fub25pY2Fs",
      } as any]),
    ],
    isStreaming: false,
    showThinking: false,
    developerMode: false,
  });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, "message");
  if (blocks[0]?.kind !== "message") return;
  assert.equal(blocks[0].messageId, "u-file");
  assert.deepEqual(blocks[0].groups, []);
});

test("keeps the latest assistant text live while streaming", () => {
  const blocks = buildProgressRenderBlocks({
    messages: [
      message("u1", "user", [{ type: "text", text: "Fix it" } as any]),
      message("a1", "assistant", [{ type: "tool", tool: "read", state: { input: { filePath: "README.md" } } } as any]),
      message("a2", "assistant", [{ type: "text", text: "I am still checking." } as any]),
    ],
    isStreaming: true,
    showThinking: false,
    developerMode: false,
  });

  assert.deepEqual(blocks.map((block) => block.kind), ["message", "progress-group", "message"]);
  assert.equal(blocks[2]?.kind, "message");
});

test("keeps progress group ids stable as later assistant activity joins the same turn", () => {
  const initialBlocks = buildProgressRenderBlocks({
    messages: [
      message("u1", "user", [{ type: "text", text: "Fix it" } as any]),
      message("a1", "assistant", [{ type: "tool", tool: "read", state: { input: { filePath: "README.md" } } } as any]),
      message("a2", "assistant", [{ type: "text", text: "Initial answer." } as any]),
    ],
    isStreaming: true,
    showThinking: false,
    developerMode: false,
  });
  const updatedBlocks = buildProgressRenderBlocks({
    messages: [
      message("u1", "user", [{ type: "text", text: "Fix it" } as any]),
      message("a1", "assistant", [{ type: "tool", tool: "read", state: { input: { filePath: "README.md" } } } as any]),
      message("a2", "assistant", [{ type: "text", text: "Intermediate progress." } as any]),
      message("a3", "assistant", [{ type: "tool", tool: "edit", state: { input: { filePath: "README.md" } } } as any]),
      message("a4", "assistant", [{ type: "text", text: "Updated answer." } as any]),
    ],
    isStreaming: true,
    showThinking: false,
    developerMode: false,
  });

  const initialGroup = initialBlocks.find((block) => block.kind === "progress-group");
  const updatedGroup = updatedBlocks.find((block) => block.kind === "progress-group");
  assert.equal(initialGroup?.kind, "progress-group");
  assert.equal(updatedGroup?.kind, "progress-group");
  if (initialGroup?.kind !== "progress-group" || updatedGroup?.kind !== "progress-group") return;

  assert.equal(updatedGroup.id, initialGroup.id);
});

test("showThinking hides reasoning but keeps comments and actions", () => {
  const blocks = buildProgressRenderBlocks({
    messages: [
      message("u1", "user", [{ type: "text", text: "Fix it" } as any]),
      message("a1", "assistant", [{ type: "reasoning", text: "Need inspect files" } as any]),
      message("a2", "assistant", [{ type: "text", text: "I will inspect files." } as any]),
      message("a3", "assistant", [{ type: "tool", tool: "read", state: { input: { filePath: "README.md" } } } as any]),
      message("a4", "assistant", [{ type: "text", text: "Done." } as any]),
    ],
    isStreaming: false,
    showThinking: false,
    developerMode: false,
  });

  assert.deepEqual(blocks.map((block) => block.kind), ["message", "progress-group", "message"]);
  const group = blocks[1];
  assert.equal(group?.kind, "progress-group");
  if (group?.kind !== "progress-group") return;
  assert.deepEqual(group.items.map((item) => item.kind), ["comment", "steps"]);
});

test("keeps separate progress groups for separate user turns", () => {
  const blocks = buildProgressRenderBlocks({
    messages: [
      message("u1", "user", [{ type: "text", text: "First" } as any]),
      message("a1", "assistant", [{ type: "tool", tool: "read", state: { input: { filePath: "one.ts" } } } as any]),
      message("a2", "assistant", [{ type: "text", text: "First done." } as any]),
      message("u2", "user", [{ type: "text", text: "Second" } as any]),
      message("a3", "assistant", [{ type: "tool", tool: "grep", state: { input: { pattern: "needle" } } } as any]),
      message("a4", "assistant", [{ type: "text", text: "I found the second spot." } as any]),
      message("a5", "assistant", [{ type: "text", text: "Second done." } as any]),
    ],
    isStreaming: false,
    showThinking: false,
    developerMode: false,
  });

  assert.deepEqual(blocks.map((block) => block.kind), [
    "message",
    "progress-group",
    "message",
    "message",
    "progress-group",
    "message",
  ]);
  const secondGroup = blocks[4];
  assert.equal(secondGroup?.kind, "progress-group");
  if (secondGroup?.kind !== "progress-group") return;
  assert.deepEqual(secondGroup.items.map((item) => item.kind), ["steps", "comment"]);
});
