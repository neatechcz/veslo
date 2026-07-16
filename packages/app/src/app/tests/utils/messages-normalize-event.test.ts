import assert from "node:assert/strict";
import test from "node:test";

import { modelFromUserMessage, normalizeEvent } from "../../utils/messages.js";

test("modelFromUserMessage accepts only complete user model payloads", () => {
  assert.deepEqual(
    modelFromUserMessage({
      role: "user",
      model: { providerID: "openai", modelID: "gpt-5" },
    }),
    { providerID: "openai", modelID: "gpt-5" },
  );
  assert.equal(modelFromUserMessage({ role: "assistant", model: { providerID: "openai", modelID: "gpt-5" } }), null);
  assert.equal(modelFromUserMessage({ role: "user", model: { providerID: "openai" } }), null);
  assert.equal(modelFromUserMessage(undefined), null);
});

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

test("normalizeEvent unwraps sync envelopes inside payload wrappers", () => {
  assert.deepEqual(
    normalizeEvent({ payload: { type: "sync", syncEvent: { type: "mcp.tools.changed.2", data: { server: "fs" } } } }),
    {
      type: "mcp.tools.changed",
      properties: { server: "fs" },
    },
  );
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
