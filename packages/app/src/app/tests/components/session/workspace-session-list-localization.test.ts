import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const enSource = readFileSync(new URL("../../../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../../../i18n/locales/zh.ts", import.meta.url), "utf8");

for (const [label, source] of [
  ["en", enSource],
  ["cs", csSource],
  ["zh", zhSource],
] as const) {
  test(`${label} locale defines sidebar overflow labels`, () => {
    assert.match(source, /"sidebar\.add_directory_or_project":/);
    assert.match(source, /"sidebar\.more_actions":/);
    assert.match(source, /"sidebar\.archived_items":/);
    assert.match(source, /"sidebar\.chat":/);
    assert.match(source, /"sidebar\.chats":/);
    assert.match(source, /"sidebar\.new_chat":/);
    assert.match(source, /"session\.chat_label":/);
    assert.doesNotMatch(source, /"sidebar\.show_archived":/);
  });
}
