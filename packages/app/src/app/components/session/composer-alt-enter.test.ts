import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");

test("Alt+Enter inserts a line break only during plain composer typing", () => {
  assert.match(
    source,
    /if \(\s*event\.key === "Enter"[\s\S]*?event\.altKey[\s\S]*?!event\.metaKey[\s\S]*?!event\.ctrlKey[\s\S]*?!mentionOpen\(\)[\s\S]*?!slashOpen\(\)[\s\S]*?\)\s*\{[\s\S]*?document\.execCommand\("insertLineBreak"\);[\s\S]*?emitDraftChange\(\);[\s\S]*?return;/,
    "Alt+Enter should insert a line break only when mention/slash pickers are closed",
  );
});

test("picker Enter behavior remains prioritized when mention or slash menus are open", () => {
  assert.match(
    source,
    /if \(mentionOpen\(\)\) \{[\s\S]*?if \(event\.key === "Enter" && !imeActive\) \{[\s\S]*?insertMention\(active\);[\s\S]*?return;/,
    "mention picker should continue to consume Enter for option selection",
  );

  assert.match(
    source,
    /if \(slashOpen\(\)\) \{[\s\S]*?if \(event\.key === "Enter" && !imeActive\) \{[\s\S]*?handleSlashSelect\(active\);[\s\S]*?return;/,
    "slash picker should continue to consume Enter for option selection",
  );
});
