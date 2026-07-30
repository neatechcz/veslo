import assert from "node:assert/strict";
import test from "node:test";
import { hasConversationLiveEventRoute } from "../../context/conversation-live-event-readiness.js";

test("cold pooled workspace accepts its lazy proxy route before the engine starts", () => {
  assert.equal(
    hasConversationLiveEventRoute({
      baseUrl: "http://127.0.0.1:64612/workspace/ws-local/opencode",
    }),
    true,
  );
});

test("live event readiness still fails closed without a proxy route", () => {
  assert.equal(hasConversationLiveEventRoute({ baseUrl: null }), false);
  assert.equal(hasConversationLiveEventRoute({ baseUrl: "  " }), false);
});
