import assert from "node:assert/strict";
import test from "node:test";

import type { ComposerDraft } from "../types";
import {
  createEmptyComposerDraft,
  getSessionComposerDraft,
  setSessionComposerDraft,
  setSessionComposerPrompt,
} from "./session-composer-drafts.js";

const withText = (text: string, extras?: Partial<ComposerDraft>): ComposerDraft => ({
  ...createEmptyComposerDraft(),
  text,
  resolvedText: text,
  parts: text ? [{ type: "text", text }] : [],
  ...extras,
});

test("stores drafts per session id without leaking text across sessions", () => {
  const sessA = withText("Draft A");
  const sessB = withText("Draft B");

  let store = {};
  store = setSessionComposerDraft(store, "session-a", sessA);
  store = setSessionComposerDraft(store, "session-b", sessB);

  assert.equal(getSessionComposerDraft(store, "session-a").text, "Draft A");
  assert.equal(getSessionComposerDraft(store, "session-b").text, "Draft B");
});

test("uses a separate draft bucket for no selected session", () => {
  let store = {};
  store = setSessionComposerPrompt(store, null, "No session draft");
  store = setSessionComposerPrompt(store, "session-a", "Session A draft");

  assert.equal(getSessionComposerDraft(store, null).text, "No session draft");
  assert.equal(getSessionComposerDraft(store, "session-a").text, "Session A draft");
});

test("setSessionComposerPrompt resets attachments to prevent cross-session carry-over", () => {
  const draftWithAttachment = withText("Has attachment", {
    attachments: [
      {
        id: "file-1",
        name: "demo.txt",
        mimeType: "text/plain",
        size: 4,
        kind: "file",
        dataUrl: "data:text/plain;base64,ZGVtbw==",
      },
    ],
  });

  let store = {};
  store = setSessionComposerDraft(store, "session-a", draftWithAttachment);
  store = setSessionComposerPrompt(store, "session-b", "Session B");

  assert.equal(getSessionComposerDraft(store, "session-a").attachments.length, 1);
  assert.equal(getSessionComposerDraft(store, "session-b").attachments.length, 0);
});
