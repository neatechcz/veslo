import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(CURRENT_DIR, "../src/app/app.tsx"), "utf8");

test("sidebar utility filtering does not delete sessions by title match", () => {
  assert.doesNotMatch(
    appSource,
    /const\s+cleanupVesloUtilitySessions\s*=\s*async/,
    "utility sessions should be hidden from sidebar, not deleted",
  );
  assert.doesNotMatch(
    appSource,
    /await\s+cleanupVesloUtilitySessions\(\s*c,\s*utility\s*\);/,
    "sidebar refresh should not call utility-session deletion",
  );
});
