import assert from "node:assert/strict";
import test from "node:test";

import { validateConversationSubmitTerminalResult } from "../../lib/send-boundary-validation.js";

const submittedResult = () => ({
  status: "submitted",
  workspaceId: "ws-1",
  conversationId: "conv-1",
  opencodeSessionId: "sess-1",
  runId: "run-1",
  clientMessageId: "client-1",
  draftDisposition: "clear",
});

const validate = (value: unknown) => validateConversationSubmitTerminalResult(value, {
  event: "test:validation-failed",
  mode: "strict",
  recordSendTrace: () => undefined,
});

test("conversation submit boundary accepts the current submitted result contract", () => {
  assert.equal(validate(submittedResult()).ok, true);
});

test("conversation submit boundary rejects malformed required submitted identities", () => {
  assert.equal(validate({ ...submittedResult(), clientMessageId: 42 }).ok, false);
  assert.equal(validate({ ...submittedResult(), clientMessageId: "" }).ok, false);
  assert.equal(validate({ ...submittedResult(), runId: "" }).ok, false);
});
