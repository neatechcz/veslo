import { describe, expect, test } from "bun:test";

import { normalizeOpencodeEvent } from "../opencode-event-normalization.js";

describe("normalizeOpencodeEvent", () => {
  test("keeps direct events unchanged", () => {
    expect(normalizeOpencodeEvent({ type: "session.updated", properties: { id: "s1" } })).toEqual({
      type: "session.updated",
      properties: { id: "s1" },
    });
  });

  test("keeps payload events unchanged", () => {
    expect(normalizeOpencodeEvent({ payload: { type: "message.updated", properties: { id: "m1" } } })).toEqual({
      type: "message.updated",
      properties: { id: "m1" },
    });
  });

  test("unwraps sync envelopes and strips trailing numeric schema suffixes", () => {
    expect(normalizeOpencodeEvent({ type: "sync", syncEvent: { type: "session.updated.2", data: { id: "s1" } } }))
      .toEqual({
        type: "session.updated",
        properties: { id: "s1" },
      });
  });

  test("keeps non-numeric dotted sync event names unchanged", () => {
    expect(
      normalizeOpencodeEvent({ type: "sync", syncEvent: { type: "session.updated.beta", data: { id: "s1" } } }),
    ).toEqual({
      type: "session.updated.beta",
      properties: { id: "s1" },
    });
  });

  test("rejects partial sync envelopes", () => {
    expect(normalizeOpencodeEvent({ type: "sync" })).toBeNull();
    expect(normalizeOpencodeEvent({ type: "sync", syncEvent: { data: { id: "s1" } } })).toBeNull();
  });
});
