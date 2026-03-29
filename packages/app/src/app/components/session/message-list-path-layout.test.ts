import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "message-list.tsx"), "utf8");

test("collapsed step detail wraps when it contains a path", () => {
  assert.match(
    source,
    /containsPathLikeText\(collapsedDetail\(\)\) \? "whitespace-normal break-all" : "truncate"/,
    "collapsed step detail should switch from truncation to wrapping for path-bearing prompts",
  );
});
