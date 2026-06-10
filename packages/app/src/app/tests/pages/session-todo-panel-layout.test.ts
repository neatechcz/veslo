import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");

test("todo panel item text matches message typography baseline", () => {
  assert.match(
    source,
    /class=\{`flex-1 text-\[13px\] leading-\[1\.35\] \$\{\s*cancelled\(\) \? "text-gray-9 line-through" : "text-gray-12"\s*\}`\}/,
    "todo item text should use smaller compact typography",
  );
  assert.doesNotMatch(
    source,
    /class=\{`flex-1 text-\[14px\] leading-\[1\.5\] \$\{\s*cancelled\(\) \? "text-gray-9 line-through" : "text-gray-12"\s*\}`\}/,
    "todo item text should not keep the previous larger typography",
  );
});

test("todo panel uses tighter vertical spacing between tasks", () => {
  assert.match(
    source,
    /<div class="px-4 pb-1\.5 space-y-1 max-h-60 overflow-auto border-t border-gray-6\/50">/,
    "todo list container should use tighter bottom and row spacing",
  );
  assert.match(
    source,
    /<div class="flex items-start gap-2 pt-1 first:pt-1">/,
    "each todo row should use smaller top padding",
  );
  assert.match(
    source,
    /class="w-full flex items-center justify-between px-4 py-1\.5 text-xs text-gray-9 hover:bg-gray-2\/50 transition-colors rounded-t-xl"/,
    "todo panel header should be more compact vertically",
  );
});
