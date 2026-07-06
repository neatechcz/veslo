import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEvent } from "../../utils/messages.js";

test("normalizeEvent keeps direct events unchanged", () => {
  assert.deepEqual(normalizeEvent({ type: "session.updated", properties: { id: "s1" } }), {
    type: "session.updated",
    properties: { id: "s1" },
  });
});

test("normalizeEvent keeps payload events unchanged", () => {
  assert.deepEqual(normalizeEvent({ payload: { type: "message.updated", properties: { id: "m1" } } }), {
    type: "message.updated",
    properties: { id: "m1" },
  });
});

test("normalizeEvent unwraps sync envelopes and strips trailing numeric schema suffixes", () => {
  assert.deepEqual(
    normalizeEvent({ type: "sync", syncEvent: { type: "session.updated.2", data: { id: "s1" } } }),
    {
      type: "session.updated",
      properties: { id: "s1" },
    },
  );
});

test("normalizeEvent keeps non-numeric dotted sync event names unchanged", () => {
  assert.deepEqual(
    normalizeEvent({ type: "sync", syncEvent: { type: "session.updated.beta", data: { id: "s1" } } }),
    {
      type: "session.updated.beta",
      properties: { id: "s1" },
    },
  );
});

test("normalizeEvent rejects partial sync envelopes", () => {
  assert.equal(normalizeEvent({ type: "sync" }), null);
  assert.equal(normalizeEvent({ type: "sync", syncEvent: { data: { id: "s1" } } }), null);
});
