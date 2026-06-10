import assert from "node:assert/strict";
import test from "node:test";

import { MCP_QUICK_CONNECT } from "../constants.js";

test("Control Chrome quick connect enables isolated profile mode", () => {
  const controlChrome = MCP_QUICK_CONNECT.find((entry) => entry.id === "chrome-devtools");
  assert.ok(controlChrome, "Control Chrome entry should exist");
  assert.equal(controlChrome.type, "local");
  assert.ok(controlChrome.command?.includes("--isolated"));
});

test("built-in MCP quick connect list contains only Control Chrome", () => {
  assert.deepEqual(
    MCP_QUICK_CONNECT.map((entry) => entry.id ?? entry.name),
    ["chrome-devtools"],
  );
});
