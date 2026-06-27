import assert from "node:assert/strict";
import test from "node:test";

import type { Part } from "@opencode-ai/sdk/v2/client";

import {
  applyCommandDisplayAlias,
  formatSlashCommandDisplay,
} from "../../context/session-store-model.js";
import type { MessageInfo } from "../../types";

const makeUserMessage = (id: string): MessageInfo =>
  ({
    id,
    sessionID: "sess-a",
    role: "user",
    time: { created: 1 },
    parentID: "",
    modelID: "",
    providerID: "",
    mode: "",
    agent: "",
    path: { cwd: "", root: "" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }) as unknown as MessageInfo;

const makeAssistantMessage = (id: string): MessageInfo =>
  ({
    ...makeUserMessage(id),
    role: "assistant",
  }) as unknown as MessageInfo;

const makeTextPart = (id: string, messageID: string, text: string): Part =>
  ({
    id,
    sessionID: "sess-a",
    messageID,
    type: "text",
    text,
    synthetic: false,
    ignored: false,
  }) as Part;

const makeToolPart = (id: string, messageID: string): Part =>
  ({
    id,
    sessionID: "sess-a",
    messageID,
    type: "tool",
    tool: "read",
    state: {},
  }) as unknown as Part;

test("session store model formats command display aliases for preassigned command messages", () => {
  assert.equal(formatSlashCommandDisplay("review", " --quick "), "/review --quick");
  assert.equal(formatSlashCommandDisplay("/review", ""), "/review");
  assert.equal(formatSlashCommandDisplay("/", " --ignored "), "");
});

test("session store model applies command aliases only to user message text", () => {
  const user = makeUserMessage("msg-user");
  const text = makeTextPart("text-a", "msg-user", "expanded prompt");
  const followupText = makeTextPart("text-b", "msg-user", "kept follow-up text");
  const tool = makeToolPart("tool-a", "msg-user");
  const aliased = applyCommandDisplayAlias(user, [text, tool, followupText], "/review --quick");

  assert.equal((aliased.parts[0] as Part & { text?: string }).text, "/review --quick");
  assert.equal(aliased.parts[1], tool);
  assert.equal(aliased.parts[2], followupText);

  const assistant = makeAssistantMessage("msg-assistant");
  const assistantText = makeTextPart("text-b", "msg-assistant", "assistant text");
  const unchanged = applyCommandDisplayAlias(assistant, [assistantText], "/ignored");

  assert.equal(unchanged.parts[0], assistantText);
});
