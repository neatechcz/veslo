import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../components/session/composer.tsx", import.meta.url), "utf8");

test("Delete key can remove a slash chip when caret is before it", () => {
  assert.match(
    source,
    /event\.key === "Delete"[\s\S]*?editorRef\.childNodes\[offset\]/,
    "Delete should resolve the next sibling slash chip from the caret position",
  );
});

test("Selecting a slash chip can be deleted directly", () => {
  assert.match(
    source,
    /if \(!range\.collapsed\)[\s\S]*?intersectsNode[\s\S]*?dataset\.slashCommand/,
    "non-collapsed selections should delete selected slash chips",
  );
});
