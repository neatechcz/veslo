import assert from "node:assert/strict";
import test from "node:test";

import { classifyConversationRunDeliveryPresentation } from "./conversation-run-delivery-presentation.js";

test("delivery presentation distinguishes visible assistant text from intentionally hidden progress", () => {
  assert.equal(classifyConversationRunDeliveryPresentation({
    assistantMessageIds: ["msg-a"],
    messagesBySession: { "ses-a": [{ id: "msg-a", role: "assistant" }] },
    partsByMessageId: { "msg-a": [{ type: "text", text: "answer" }] },
  }), "visible_output");

  assert.equal(classifyConversationRunDeliveryPresentation({
    assistantMessageIds: ["msg-a"],
    messagesBySession: { "ses-a": [{ id: "msg-a", role: "assistant" }] },
    partsByMessageId: { "msg-a": [{ type: "tool" }] },
  }), "hidden_progress");

  assert.equal(classifyConversationRunDeliveryPresentation({
    assistantMessageIds: ["msg-a", "msg-a"],
    messagesBySession: { "ses-a": [{ id: "msg-a", role: "assistant" }] },
    partsByMessageId: { "msg-a": [] },
  }), "no_visible_output");
});

test("delivery presentation never lets an older assistant turn satisfy a later run", () => {
  assert.equal(classifyConversationRunDeliveryPresentation({
    assistantMessageIds: ["msg-current"],
    messagesBySession: {
      "ses-a": [
        { id: "msg-history", role: "assistant" },
        { id: "msg-current", role: "assistant" },
      ],
    },
    partsByMessageId: {
      "msg-history": [{ type: "text", text: "older visible answer" }],
      "msg-current": [],
    },
  }), "no_visible_output");

  assert.equal(classifyConversationRunDeliveryPresentation({
    assistantMessageIds: [],
    messagesBySession: { "ses-a": [{ id: "msg-history", role: "assistant" }] },
    partsByMessageId: { "msg-history": [{ type: "text", text: "older visible answer" }] },
  }), "unknown");
});
