import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../components/session/message-list.tsx"), "utf8");

test("collapsed step detail wraps when it contains a path", () => {
  assert.match(
    source,
    /flex w-full items-start gap-2 rounded-\[18px\] border px-3 py-2 text-left/,
    "timeline header should render as a compact card-like row instead of the previous flat inline toggle",
  );
});

test("expanded timeline renders derived section cards", () => {
  assert.match(
    source,
    /For each=\{timelineSections\(\)\}/,
    "expanded timeline should iterate derived sections instead of raw step rows",
  );
  assert.match(
    source,
    /<section class="rounded-\[18px\] border border-gray-6\/60 bg-gray-2\/35">/,
    "derived sections should render as compact cards",
  );
  assert.match(
    source,
    /text-\[13px\] font-medium leading-5 text-gray-12/,
    "row primary text should use the new compact two-line hierarchy",
  );
});

test("expanded timeline rows expose secondary detail and disclosure", () => {
  assert.match(
    source,
    /text-\[12px\] leading-5 text-gray-10 break-words/,
    "row secondary text should be rendered beneath the primary line",
  );
  assert.match(
    source,
    /<details class="mt-2">/,
    "technical detail should be hidden behind a details disclosure",
  );
});
