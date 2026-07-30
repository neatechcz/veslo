import assert from "node:assert/strict";
import test from "node:test";

import { parseOwnedSkillSidebarRefreshArguments } from "./skill-sidebar-refresh-owned.mjs";

test("owned skill sidebar scenario accepts only explicit workspace options", () => {
  const result = parseOwnedSkillSidebarRefreshArguments([
    "--workspace", "fixture",
    "--workspace-path", "C:/tmp/fixture",
    "--skill-name", "owned-sidebar-check",
  ]);
  assert.equal(result.workspaceLabel, "fixture");
  assert.equal(result.skillName, "owned-sidebar-check");
});

test("owned skill sidebar scenario rejects an attach runtime descriptor", () => {
  assert.throws(
    () => parseOwnedSkillSidebarRefreshArguments(["C:/tmp/runtime-info.json"]),
    /starts its own runtime/,
  );
});
