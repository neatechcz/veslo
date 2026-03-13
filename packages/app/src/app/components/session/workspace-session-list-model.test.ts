import assert from "node:assert/strict";
import test from "node:test";

import { isProjectCollapsed, toggleProjectCollapsed } from "./workspace-session-list-model.js";

test("toggleProjectCollapsed collapses an expanded project", () => {
  const next = toggleProjectCollapsed({}, "project:alpha");

  assert.equal(isProjectCollapsed(next, "project:alpha"), true);
});

test("toggleProjectCollapsed expands a collapsed project", () => {
  const next = toggleProjectCollapsed({ "project:alpha": true }, "project:alpha");

  assert.equal(isProjectCollapsed(next, "project:alpha"), false);
});

test("toggleProjectCollapsed keeps other project keys unchanged", () => {
  const next = toggleProjectCollapsed({ "project:alpha": true, "project:beta": false }, "project:beta");

  assert.equal(isProjectCollapsed(next, "project:alpha"), true);
  assert.equal(isProjectCollapsed(next, "project:beta"), true);
});
