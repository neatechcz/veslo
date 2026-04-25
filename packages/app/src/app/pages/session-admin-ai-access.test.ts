import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session blocks prompt sending when admin-managed ai access is unavailable", () => {
  assert.match(source, /if\s*\(props\.aiAccessBlockedReason\)\s*\{/s);
  assert.match(source, /setToastMessage\(props\.aiAccessBlockedReason\)/);
  assert.match(source, /Show when=\{props\.aiAccessBlockedReason\}/);
  assert.doesNotMatch(source, /ProviderAuthModal/);
});
