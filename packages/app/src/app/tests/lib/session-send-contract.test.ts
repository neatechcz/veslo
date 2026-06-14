import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionClientMessageId,
  normalizeSessionSendCorrelation,
  type SessionSendOrigin,
} from "../../lib/session-send-contract.js";

test("session send contract exposes explicit origin methods", () => {
  const origins = [
    "session:normal",
    "session:send-now",
    "session:queue-drain",
    "session:replacement",
    "app:retry-last-prompt",
    "app:soul-prompt",
  ] satisfies SessionSendOrigin[];

  assert.deepEqual(origins, [
    "session:normal",
    "session:send-now",
    "session:queue-drain",
    "session:replacement",
    "app:retry-last-prompt",
    "app:soul-prompt",
  ]);
});

test("session send contract creates transcript-safe message ids", () => {
  const id = createSessionClientMessageId();

  assert.match(id, /^msg_[a-zA-Z0-9]+$/);
});

test("session send correlation trims the client message id", () => {
  assert.deepEqual(
    normalizeSessionSendCorrelation({
      clientMessageId: " msg_123 ",
      origin: "session:normal",
    }),
    {
      clientMessageId: "msg_123",
      origin: "session:normal",
    },
  );
});
