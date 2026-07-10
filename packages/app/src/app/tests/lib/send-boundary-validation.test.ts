import assert from "node:assert/strict";
import test from "node:test";

import { validateConversationSubmitTerminalResult } from "../../lib/send-boundary-validation.js";

const submittedResult = (canonicalMessageId?: unknown) => ({
  status: "submitted",
  workspaceId: "ws-1",
  conversationId: "conv-1",
  opencodeSessionId: "sess-1",
  runId: "run-1",
  clientMessageId: "client-1",
  ...(canonicalMessageId === undefined ? {} : { canonicalMessageId }),
  draftDisposition: "clear",
});

const validate = (value: unknown) => validateConversationSubmitTerminalResult(value, {
  event: "test:validation-failed",
  mode: "strict",
  recordSendTrace: () => undefined,
});

test("conversation submit boundary accepts legacy and canonical submitted results", () => {
  assert.equal(validate(submittedResult()).ok, true);
  assert.equal(validate(submittedResult("msg_veslo_v1_canonical")).ok, true);
});

test("conversation submit boundary rejects malformed canonical message identities", () => {
  assert.equal(validate(submittedResult(42)).ok, false);
  assert.equal(validate(submittedResult("")).ok, false);
});
