import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");

test("settings replaces user-managed provider and model controls with admin-managed ai access copy", () => {
  assert.match(source, />AI access</);
  assert.match(source, /managed by the platform admin/i);
  assert.doesNotMatch(source, /Connect provider/);
  assert.doesNotMatch(source, /activeTab\(\)\s*===\s*"model"/);
  assert.doesNotMatch(source, /openDefaultModelPicker/);
});
