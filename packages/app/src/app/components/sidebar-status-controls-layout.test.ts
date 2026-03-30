import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./sidebar-status-controls.tsx", import.meta.url), "utf8");

test("sidebar status controls should not add a second top divider line", () => {
  assert.doesNotMatch(source, /class="mt-3 border-t border-gray-6\/70 pt-3"/);
});
