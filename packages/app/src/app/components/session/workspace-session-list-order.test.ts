import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProjectOrder,
  mergeVisibleOrder,
  reorderProjectKeys,
} from "./workspace-session-list-order.js";

test("applyProjectOrder applies stored key order and appends unknown keys", () => {
  const groups = [
    { key: "a" },
    { key: "c" },
    { key: "b" },
  ];

  const ordered = applyProjectOrder(groups, ["b", "a"]);

  assert.deepEqual(
    ordered.map((group) => group.key),
    ["b", "a", "c"],
  );
});

test("applyProjectOrder ignores unknown and duplicate stored keys", () => {
  const groups = [
    { key: "a" },
    { key: "b" },
    { key: "c" },
  ];

  const ordered = applyProjectOrder(groups, ["x", "b", "b", "a"]);

  assert.deepEqual(
    ordered.map((group) => group.key),
    ["b", "a", "c"],
  );
});

test("reorderProjectKeys inserts source before target", () => {
  const next = reorderProjectKeys(["a", "b", "c"], "c", "a");

  assert.deepEqual(next, ["c", "a", "b"]);
});

test("reorderProjectKeys returns original order for self drop", () => {
  const keys = ["a", "b", "c"];

  assert.deepEqual(reorderProjectKeys(keys, "b", "b"), keys);
});

test("reorderProjectKeys ignores missing keys", () => {
  const keys = ["a", "b", "c"];

  assert.deepEqual(reorderProjectKeys(keys, "x", "b"), keys);
  assert.deepEqual(reorderProjectKeys(keys, "a", "x"), keys);
});

test("mergeVisibleOrder keeps hidden keys stable while applying reordered visible keys", () => {
  const next = mergeVisibleOrder(["x", "a", "b", "y"], ["b", "a"]);

  assert.deepEqual(next, ["x", "b", "a", "y"]);
});

test("mergeVisibleOrder appends visible keys missing from stored order", () => {
  const next = mergeVisibleOrder(["x", "y"], ["b", "a"]);

  assert.deepEqual(next, ["x", "y", "b", "a"]);
});
