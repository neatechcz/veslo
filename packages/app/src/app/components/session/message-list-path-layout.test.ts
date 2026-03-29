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

test("expanded step rows use message typography with tighter row spacing", () => {
  assert.match(
    source,
    /flex items-center gap-2 py-0\.5 leading-\[1\.5\] group\/step/,
    "step rows should use compact vertical spacing while keeping message typography baseline",
  );
  assert.match(
    source,
    /text-\[14px\] text-gray-12 font-medium truncate shrink-0 max-w-\[200px\]/,
    "step titles should match message window text size",
  );
  assert.match(
    source,
    /text-\[14px\] text-gray-9 truncate min-w-0/,
    "step detail text should match message window text size",
  );
});

test("expanded step groups have compact vertical separation", () => {
  assert.match(
    source,
    /index\(\) === 0\s*\?\s*""\s*:\s*"mt-1 pt-1 border-t border-gray-6\/40"/,
    "step groups should use tighter top spacing",
  );
});
