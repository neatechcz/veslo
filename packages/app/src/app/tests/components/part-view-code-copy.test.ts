import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { marked } from "marked";

import { createCustomRenderer } from "../../components/part-view-markdown-renderer.js";

const partView = readFileSync(new URL("../../components/part-view.tsx", import.meta.url), "utf8");
const markdownRenderer = readFileSync(
  new URL("../../components/part-view-markdown-renderer.ts", import.meta.url),
  "utf8",
);

test("markdown code blocks render a scoped copy button", () => {
  assert.match(markdownRenderer, /data-testid="part-view-code-block"/);
  assert.match(markdownRenderer, /data-testid="part-view-code-copy"/);
  assert.match(markdownRenderer, /data-markdown-code-copy/);
});

test("markdown renderer outputs an icon-only copy button for text-labeled code blocks", () => {
  const html = marked.parse("```text\nUnity MCP Server\n```", {
    renderer: createCustomRenderer("light", { copyCodeLabel: "Copy" }),
    async: false,
  });

  assert.equal(typeof html, "string");
  assert.match(html, /data-testid="part-view-code-block"/);
  assert.match(html, /data-testid="part-view-code-copy"/);
  assert.match(html, /aria-label="Copy"/);
  assert.match(html, /<svg[\s\S]*data-lucide="copy"/);
  assert.doesNotMatch(html, />\s*Copy\s*<\/button>/);
  assert.match(html, /Unity MCP Server/);
});

test("markdown code copy button is scoped to hover or focus within its block", () => {
  const html = marked.parse("```text\nEdit -> Project Settings\n```", {
    renderer: createCustomRenderer("light", { copyCodeLabel: "Copy" }),
    async: false,
  });

  assert.equal(typeof html, "string");
  assert.match(html, /data-markdown-code-block class="[^"]*\bgroup\/code-block\b/);
  assert.match(html, /data-markdown-code-copy[\s\S]*class="[^"]*\bopacity-0\b/);
  assert.match(html, /data-markdown-code-copy[\s\S]*class="[^"]*\bpointer-events-none\b/);
  assert.match(html, /data-markdown-code-copy[\s\S]*class="[^"]*\bgroup-hover\/code-block:opacity-100\b/);
  assert.match(html, /data-markdown-code-copy[\s\S]*class="[^"]*\bgroup-hover\/code-block:pointer-events-auto\b/);
  assert.match(html, /data-markdown-code-copy[\s\S]*class="[^"]*\bgroup-focus-within\/code-block:opacity-100\b/);
  assert.match(html, /data-markdown-code-copy[\s\S]*class="[^"]*\bgroup-focus-within\/code-block:pointer-events-auto\b/);
});

test("markdown code copy button does not add an empty header row without a language", () => {
  const html = marked.parse("```\nplain value\n```", {
    renderer: createCustomRenderer("light", { copyCodeLabel: "Copy" }),
    async: false,
  });

  assert.equal(typeof html, "string");
  assert.doesNotMatch(html, /<span aria-hidden="true"><\/span>/);
  assert.doesNotMatch(html, /mb-2 flex items-center justify-between/);
  assert.match(html, /<pre class="[^"]*\bpr-8\b/);
});

test("part view copies the nearest rendered code block value", () => {
  assert.match(partView, /closest\("\[data-markdown-code-copy\]"\)/);
  assert.match(partView, /closest\("\[data-markdown-code-block\]"\)/);
  assert.match(partView, /querySelector\("pre code"\)/);
  assert.match(partView, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(partView, /document\.execCommand\("copy"\)/);
});
