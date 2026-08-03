import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { marked } from "marked";

import { closeUnterminatedCodeFence } from "../../components/part-view-markdown-renderer.js";

const partView = readFileSync(new URL("../../components/part-view.tsx", import.meta.url), "utf8");

test("a collapsed long text part renders markdown instead of raw source", () => {
  // The collapsed branch used to short-circuit both memos, which showed the
  // reader literal "##" and "**" markup until they expanded the message.
  assert.doesNotMatch(partView, /if \(collapsedLongText\(\)\) return "";/);
  assert.doesNotMatch(partView, /if \(collapsedLongText\(\)\) return null;/);
  assert.match(partView, /collapsedLongText\(\) \? collapsedPreviewText\(\) : rawText\(\)/);
});

test("the collapsed preview keeps its bounded slice and its own guard", () => {
  assert.match(partView, /closeUnterminatedCodeFence\(text\.slice\(0, LARGE_TEXT_PREVIEW_CHARS\)\)/);
  assert.match(partView, /const LARGE_TEXT_PREVIEW_CHARS = 3_200;/);
});

test("balanced markdown is returned untouched", () => {
  const balanced = "# Title\n\n```ts\nconst a = 1;\n```\n\nAfter.";
  assert.equal(closeUnterminatedCodeFence(balanced), balanced);

  const plain = "## Heading\n\n**bold** and a list:\n\n- one\n- two";
  assert.equal(closeUnterminatedCodeFence(plain), plain);
});

test("a fence left open by the preview cut is closed", () => {
  assert.equal(
    closeUnterminatedCodeFence("Intro\n\n```ts\nconst a = 1;"),
    "Intro\n\n```ts\nconst a = 1;\n```",
  );
  assert.equal(closeUnterminatedCodeFence("~~~~\nraw"), "~~~~\nraw\n~~~~");
});

test("a shorter inner run does not close a longer fence", () => {
  assert.equal(
    closeUnterminatedCodeFence("````\n```\nstill inside"),
    "````\n```\nstill inside\n````",
  );
});

test("repairing the cut keeps later headings out of the code block", () => {
  const cut = "```ts\nconst a = 1;";
  const swallowed = String(marked.parse(`${cut}\n\n## Heading`, { gfm: true, async: false }));
  const repaired = String(
    marked.parse(`${closeUnterminatedCodeFence(cut)}\n\n## Heading`, { gfm: true, async: false }),
  );

  assert.doesNotMatch(swallowed, /<h2/);
  assert.match(repaired, /<h2/);
});
