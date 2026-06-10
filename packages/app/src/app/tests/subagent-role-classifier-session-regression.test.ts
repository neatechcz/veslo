import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(CURRENT_DIR, "../app.tsx"), "utf8");

test("subagent role decoration does not create visible helper sessions", () => {
  assert.doesNotMatch(source, /title:\s*"\[Veslo\] Subagent role classifier"/);
});
