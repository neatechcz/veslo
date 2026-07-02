import assert from "node:assert/strict";
import test from "node:test";

import { createLateBound } from "../../lib/late-bound.js";

test("current returns null before bind and the value after bind", () => {
  const slot = createLateBound<{ id: string }>("test-slot");

  assert.equal(slot.current(), null);
  assert.equal(slot.isBound(), false);

  const value = { id: "bound" };
  slot.bind(value);

  assert.equal(slot.current(), value);
  assert.equal(slot.isBound(), true);
});

test("reports the first early access exactly once", () => {
  const reported: string[] = [];
  const slot = createLateBound<string>("early-slot", {
    onEarlyAccess: (name) => reported.push(name),
  });

  slot.current();
  slot.current();
  assert.deepEqual(reported, ["early-slot"]);

  slot.bind("value");
  slot.current();
  assert.deepEqual(reported, ["early-slot"]);
});

test("does not report early access when bound before first read", () => {
  const reported: string[] = [];
  const slot = createLateBound<string>("bound-first", {
    onEarlyAccess: (name) => reported.push(name),
  });

  slot.bind("value");
  assert.equal(slot.current(), "value");
  assert.deepEqual(reported, []);
});

// Reactive re-evaluation of consumers after bind() is provided by the
// signal-backed slot and cannot be asserted here: node resolves the solid-js
// server build, where memo recomputation is disabled by design.
test("readers observe the value on reads after bind", () => {
  const slot = createLateBound<{ label: () => string }>("reactive-slot");
  const label = () => slot.current()?.label() ?? "unbound";

  assert.equal(label(), "unbound");

  slot.bind({ label: () => "bound" });
  assert.equal(label(), "bound");
});

test("stores function-typed dependencies without invoking them", () => {
  const slot = createLateBound<() => string>("function-slot");
  slot.bind(() => "called");

  const bound = slot.current();
  assert.equal(typeof bound, "function");
  assert.equal(bound?.(), "called");
});

test("whenBound runs immediately when already bound", () => {
  const slot = createLateBound<string>("immediate-slot");
  slot.bind("value");

  const seen: string[] = [];
  slot.whenBound((value) => seen.push(value));
  assert.deepEqual(seen, ["value"]);
});

test("whenBound queues pre-bind callbacks and flushes them on bind", () => {
  const slot = createLateBound<string>("queued-slot");
  const seen: string[] = [];

  slot.whenBound((value) => seen.push(`first:${value}`));
  slot.whenBound((value) => seen.push(`second:${value}`));
  assert.deepEqual(seen, []);

  slot.bind("value");
  assert.deepEqual(seen, ["first:value", "second:value"]);
});

test("whenBound collapses queued callbacks sharing a key", () => {
  const slot = createLateBound<string>("keyed-slot");
  const seen: string[] = [];

  slot.whenBound(() => seen.push("stale"), { key: "refresh" });
  slot.whenBound(() => seen.push("latest"), { key: "refresh" });
  slot.whenBound(() => seen.push("other"));

  slot.bind("value");
  assert.deepEqual(seen, ["latest", "other"]);
});
