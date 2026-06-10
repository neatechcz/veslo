import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");

test("settings exposes technical details instead of the old thinking-only label", () => {
  assert.match(source, /translate\("settings\.technical_details_label"\)/);
  assert.match(source, /translate\("settings\.technical_details_description"\)/);
  assert.doesNotMatch(source, /<div class="text-sm text-gray-12">Thinking<\/div>/);
});
