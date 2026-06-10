import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../components/session/message-list.tsx", import.meta.url), "utf8");

test("message list exposes a latest-user-message edit action next to copy", () => {
  assert.match(
    source,
    /import type \{ EditableUserMessageDraft \} from "\.\/message-editability";/,
    "message list should consume the editability model type",
  );
  assert.match(
    source,
    /editableUserMessage\?: EditableUserMessageDraft \| null;/,
    "message list props should receive the currently editable user message",
  );
  assert.match(
    source,
    /onEditUserMessage\?: \(editable: EditableUserMessageDraft\) => void;/,
    "message list props should expose an edit callback",
  );
  assert.match(
    source,
    /pendingMessageStateById\?: Record<string, PendingMessageState>;/,
    "message list props should receive pending submit state by message id",
  );
  assert.match(
    source,
    /const editableMessage = \(\) =>\s*props\.editableUserMessage\?\.messageId === block\.messageId \? props\.editableUserMessage : null;/,
    "edit affordance should be scoped to the exact editable message id",
  );
  assert.match(
    source,
    /const pendingMessageState = \(\) => props\.pendingMessageStateById\?\.\[block\.messageId\] \?\? null;/,
    "pending status should be scoped to the exact message id",
  );
  assert.match(
    source,
    /<Show when=\{block\.isUser && pendingMessageState\(\)\?\.state === "error"\}>[\s\S]*session\.pending_submit_failed/s,
    "pending user messages should render only failed handoff status, not a sending/responding footnote",
  );
  assert.doesNotMatch(
    source,
    /session\.pending_submit_sending/,
    "sending/responding progress belongs to the run indicator, not the submitted user message bubble",
  );
  assert.match(
    source,
    /<Show when=\{editableMessage\(\)\}>[\s\S]*title=\{tr\("session\.edit_message_title"\)\}[\s\S]*aria-label=\{tr\("session\.edit_message_title"\)\}[\s\S]*props\.onEditUserMessage\?\.\(editable\(\)\)[\s\S]*<Pencil size=\{12\}/,
    "edit button should render a pencil action that calls the edit callback",
  );
});
