import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";

import {
  normalizeFilePath,
  renderCodeSpanWithLink,
  renderInlineTextWithLinks,
  splitTextWithStandalonePathLinks,
} from "../../components/part-view-link-utils.js";
import { createCustomRenderer } from "../../components/part-view-markdown-renderer.js";

const POSIX_WORKSPACE_ROOT = "/tmp/veslo path link workspace";
const POSIX_SPACED_FILE = `${POSIX_WORKSPACE_ROOT}/test/ulice_brno.xlsx`;
const POSIX_DOCX_OUTPUT = `${POSIX_WORKSPACE_ROOT}/offer_template/output/20260311 - Neatech JAVEX-TRADE_Interni_Automatizace_Procesu.docx`;
const POSIX_PDF_OUTPUT = `${POSIX_WORKSPACE_ROOT}/offer_template/output/20260311 - Neatech JAVEX-TRADE_Interni_Automatizace_Procesu.pdf`;
const WINDOWS_WORKSPACE_ROOT = "C:/Users/alice/AppData/Local/Veslo/fixtures/path-link-workspace";

test("links an absolute POSIX path line that contains spaces", () => {
  const segments = splitTextWithStandalonePathLinks(POSIX_SPACED_FILE);

  assert.deepEqual(segments, [
    {
      kind: "link",
      value: POSIX_SPACED_FILE,
      href: POSIX_SPACED_FILE,
      type: "file",
    },
  ]);
});

test("links a workspace-relative path line that contains spaces", () => {
  const segments = splitTextWithStandalonePathLinks("reports march/ulice brno.csv");

  assert.deepEqual(segments, [
    {
      kind: "link",
      value: "reports march/ulice brno.csv",
      href: "reports march/ulice brno.csv",
      type: "file",
    },
  ]);
});

test("keeps ordinary prose as plain text", () => {
  const text = "Nalezl jsem online seznam ulic v Brne a ulozil ho do Excelu.";
  const segments = splitTextWithStandalonePathLinks(text);

  assert.equal(segments.every((segment) => segment.kind === "text"), true);
  assert.equal(
    segments.map((segment) => segment.value).join(""),
    text,
  );
});

test("still renders ordinary web URLs as anchors", () => {
  const html = renderInlineTextWithLinks("https://example.com/report");

  assert.match(html, /href="https:\/\/example\.com\/report"/);
  assert.match(html, />https:\/\/example\.com\/report</);
});

test("renders a multi-line assistant snippet with a path-only line as a file anchor", () => {
  const html = renderInlineTextWithLinks(`Soubor je tady:\n${POSIX_SPACED_FILE}`);

  assert.equal(html.includes(`href="${POSIX_SPACED_FILE}"`), true);
  assert.equal(html.startsWith("Soubor je tady:\n"), true);
});

test("renders a code-formatted file path as a clickable code link", () => {
  const html = renderCodeSpanWithLink(POSIX_SPACED_FILE, "inline-code-class");

  assert.equal(html.startsWith(`<a href="${POSIX_SPACED_FILE}"`), true);
  assert.match(html, /<code class="inline-code-class">/);
  assert.equal(html.endsWith(`>${POSIX_SPACED_FILE}</code></a>`), true);
});

test("normalizes WSL sandbox file links to host workspace paths", () => {
  assert.equal(
    normalizeFilePath("/workspace/reports/result.pdf", WINDOWS_WORKSPACE_ROOT),
    `${WINDOWS_WORKSPACE_ROOT}/reports/result.pdf`,
  );
  assert.equal(
    normalizeFilePath("file:///workspace/screens/result.png", WINDOWS_WORKSPACE_ROOT),
    `${WINDOWS_WORKSPACE_ROOT}/screens/result.png`,
  );
  assert.equal(
    normalizeFilePath("/mnt/c/Users/alice/AppData/Local/Veslo/fixtures/path-link-workspace/reports/result.pdf", WINDOWS_WORKSPACE_ROOT),
    `${WINDOWS_WORKSPACE_ROOT}/reports/result.pdf`,
  );
});

test("does not treat Czech company suffix s.r.o. as a file link", () => {
  const text = "Firma Acme s.r.o. dodava zbozi.";
  const segments = splitTextWithStandalonePathLinks(text);
  assert.equal(segments.every((s) => s.kind === "text"), true);
  assert.equal(
    segments.map((s) => s.value).join(""),
    text,
  );
});

test("does not treat a Czech house number like 536/38 as a file link", () => {
  const text = "Adresa: Hlavni 536/38, Praha.";
  const segments = splitTextWithStandalonePathLinks(text);
  assert.equal(segments.every((s) => s.kind === "text"), true);
  assert.equal(
    segments.map((s) => s.value).join(""),
    text,
  );
});

test("renders list-item code paths with spaces as a single clickable markdown link", () => {
  const markdown = [
    "Vystupy:",
    "- **DOCX:**  ",
    `\`${POSIX_DOCX_OUTPUT}\``,
    "- **PDF:**  ",
    `\`${POSIX_PDF_OUTPUT}\``,
  ].join("\n");

  const html = marked.parse(markdown, {
    breaks: true,
    gfm: true,
    renderer: createCustomRenderer("light"),
    async: false,
  });

  const rendered = typeof html === "string" ? html : "";
  assert.match(rendered, /<strong>DOCX:<\/strong><br>/);
  assert.equal(rendered.includes(`<a href="${POSIX_DOCX_OUTPUT}"`), true);
  assert.equal(rendered.includes(`<a href="${POSIX_PDF_OUTPUT}"`), true);
  assert.equal(rendered.includes(`href="${POSIX_WORKSPACE_ROOT}`), true);
});
