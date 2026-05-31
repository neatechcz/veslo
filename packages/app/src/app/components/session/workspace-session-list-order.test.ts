import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProjectOrder,
  mergeVisibleOrder,
  promoteProjectKeyInOrder,
  reorderProjectKeys,
} from "./workspace-session-list-order.js";

test("applyProjectOrder keeps new keys ahead of stored order", () => {
  const groups = [
    { key: "c" },
    { key: "a" },
    { key: "b" },
  ];

  const ordered = applyProjectOrder(groups, ["b", "a"]);

  assert.deepEqual(
    ordered.map((group) => group.key),
    ["c", "b", "a"],
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
    ["c", "b", "a"],
  );
});

test("reorderProjectKeys inserts source before target", () => {
  const next = reorderProjectKeys(["a", "b", "c"], "c", "a");

  assert.deepEqual(next, ["c", "a", "b"]);
});

test("reorderProjectKeys inserts source after target when requested", () => {
  const next = reorderProjectKeys(["a", "b", "c"], "a", "c", "after");

  assert.deepEqual(next, ["b", "c", "a"]);
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

test("promoteProjectKeyInOrder moves a registered project to the front", () => {
  const next = promoteProjectKeyInOrder(["project:a", "project:b", "project:c"], " project:b ");

  assert.deepEqual(next, ["project:b", "project:a", "project:c"]);
});

test("promoteProjectKeyInOrder inserts a new registered project before existing projects", () => {
  const next = promoteProjectKeyInOrder(["project:a", "project:b"], "project:c");

  assert.deepEqual(next, ["project:c", "project:a", "project:b"]);
});

test("mergeVisibleOrder keeps hidden keys stable while applying reordered visible keys", () => {
  const next = mergeVisibleOrder(["x", "a", "b", "y"], ["b", "a"]);

  assert.deepEqual(next, ["x", "b", "a", "y"]);
});

test("mergeVisibleOrder appends visible keys missing from stored order", () => {
  const next = mergeVisibleOrder(["x", "y"], ["b", "a"]);

  assert.deepEqual(next, ["x", "y", "b", "a"]);
});
