import assert from "node:assert/strict";
import test from "node:test";

import { createSessionFlowFacade } from "../../context/session-flow-facade.js";
import type { ComposerDraft } from "../../types.js";

const draft = (text = "hello"): ComposerDraft => ({
  mode: "prompt",
  text,
  resolvedText: text,
  parts: [{ type: "text", text }],
  attachments: [],
});

test("session flow facade exposes first-send and create-session entrypoints through one boundary", async () => {
  const calls: string[] = [];
  const facade = createSessionFlowFacade({
    createSessionAndOpen: async (initialTitle, options) => {
      calls.push(`create:${initialTitle ?? ""}:${options?.clientMessageId ?? ""}`);
      return "sess-created";
    },
    sendWorkflow: {
      sendPrompt: async (nextDraft, options) => {
        calls.push(`send:${nextDraft.text}:${options.clientMessageId}`);
        return true;
      },
      abortSession: async (sessionId) => {
        calls.push(`abort:${sessionId ?? ""}`);
      },
    },
  });

  assert.equal(
    await facade.createSessionAndOpen("title", { clientMessageId: "client-create" }),
    "sess-created",
  );
  assert.equal(
    await facade.sendPrompt(draft("queued"), {
      clientMessageId: "client-send",
      origin: "session:normal",
    }),
    true,
  );
  await facade.abortSession("sess-created");

  assert.deepEqual(calls, [
    "create:title:client-create",
    "send:queued:client-send",
    "abort:sess-created",
  ]);
});
