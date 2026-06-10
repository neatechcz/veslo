import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("sidebar session-store sync reads existing sidebar rows without tracking the signal it updates", () => {
  assert.match(
    source,
    /const existingTargetSessionCount = untrack\(\(\) => \(sidebarSessionsByWorkspaceId\(\)\[wsId\] \?\? \[\]\)\.length\);/,
    "sidebar session-store sync should untrack the current sidebar row count so setting sidebarSessionsByWorkspaceId does not recursively retrigger the same effect",
  );
});
