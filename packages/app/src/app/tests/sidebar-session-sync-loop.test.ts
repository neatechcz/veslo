import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../context/sidebar-workspace-sessions.ts", import.meta.url), "utf8");

test("sidebar session-store sync reads existing sidebar rows without tracking the signal it updates", () => {
  assert.match(
    source,
    /const existingTargetSidebarRows = untrack\(\(\) => sidebarSessionsByWorkspaceId\(\)\[wsId\] \?\? \[\]\);[\s\S]*const existingTargetSessionCount = existingTargetSidebarRows\.length;/,
    "sidebar session-store sync should untrack the current sidebar rows so setting sidebarSessionsByWorkspaceId does not recursively retrigger the same effect",
  );
});
