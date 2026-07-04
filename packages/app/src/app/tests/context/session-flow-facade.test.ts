import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createSessionFlowFacade } from "../../context/session-flow-facade.js";
import type { ComposerDraft } from "../../types.js";

const facadeSource = readFileSync(new URL("../../context/session-flow-facade.ts", import.meta.url), "utf8");

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

test("session flow facade remains a thin reactive-free facade", () => {
  assert.doesNotMatch(
    facadeSource,
    /from "solid-js"|createEffect|createSignal|createMemo/,
    "session-flow-facade should not own reactive program flow",
  );
  assert.doesNotMatch(
    facadeSource,
    /setBusy|setBusyLabel|setBusyStartedAt|emitFlowProgress|prepareSendRuntimeForSend|drainNextQueuedDraft/,
    "session-flow-facade should not become the owner for progress, runtime preparation, or queue draining",
  );
  assert.match(
    facadeSource,
    /createSessionAndOpen: \(initialTitle, createOptions\) =>\s*options\.createSessionAndOpen\(initialTitle, createOptions\),/,
    "session-flow-facade should forward session creation to the injected owner",
  );
  assert.match(
    facadeSource,
    /sendPrompt: \(draft, sendOptions\) =>\s*options\.sendWorkflow\.sendPrompt\(draft, sendOptions\),/,
    "session-flow-facade should forward sends to the injected workflow",
  );
  assert.match(
    facadeSource,
    /abortSession: \(sessionId, target\) =>\s*options\.sendWorkflow\.abortSession\(sessionId, target\),/,
    "session-flow-facade should forward aborts to the injected workflow",
  );
});
