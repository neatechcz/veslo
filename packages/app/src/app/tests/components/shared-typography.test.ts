import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(new URL("../../components/live-markdown-editor.tsx", import.meta.url), "utf8");
const button = readFileSync(new URL("../../components/button.tsx", import.meta.url), "utf8");
const textInput = readFileSync(new URL("../../components/text-input.tsx", import.meta.url), "utf8");

test("markdown editor no longer hard-codes the Inter stack", () => {
  assert.doesNotMatch(editor, /Inter, ui-sans-serif/);
  assert.match(editor, /var\(--veslo-font-reading\)/);
});

test("markdown live preview decorations stay explicitly typed", () => {
  const unsafeTypeToken = "a" + "ny";

  assert.match(editor, /type Range } from "@codemirror\/state"/);
  assert.match(editor, /const ranges: Range<Decoration>\[\] = \[\];/);
  assert.doesNotMatch(editor, new RegExp(`:\\s*${unsafeTypeToken}\\b`));
  assert.doesNotMatch(editor, new RegExp(`${unsafeTypeToken}\\[\\]`));
  assert.doesNotMatch(editor, new RegExp(`as ${unsafeTypeToken}`));
});

test("shared button uses product font semantics", () => {
  assert.match(button, /font-product/);
  assert.match(button, /type-ui-md/);
});

test("text input separates product chrome from readable body text", () => {
  assert.match(textInput, /font-product type-ui-xs/);
  assert.match(textInput, /font-reading type-ui-md/);
  assert.match(textInput, /type-ui-sm/);
});
