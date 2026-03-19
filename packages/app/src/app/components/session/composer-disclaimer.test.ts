import assert from "node:assert/strict";
import test from "node:test";

import { resolveShortComposerDisclaimer } from "./composer-disclaimer.js";

test("returns the first sentence when disclaimer has multiple sentences", () => {
  const result = resolveShortComposerDisclaimer("AI se může mýlit. Použijte vlastní úsudek a ověřte si informace.");
  assert.equal(result, "AI se může mýlit.");
});

test("supports sentence delimiters used by CJK locales", () => {
  const result = resolveShortComposerDisclaimer("AI 可能会出错。请自行判断并核实关键信息。");
  assert.equal(result, "AI 可能会出错。");
});

test("falls back to the full text when no delimiter is present", () => {
  const result = resolveShortComposerDisclaimer("AI can be wrong");
  assert.equal(result, "AI can be wrong");
});
