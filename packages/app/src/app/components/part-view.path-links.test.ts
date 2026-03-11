import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";

import {
  renderCodeSpanWithLink,
  renderInlineTextWithLinks,
  splitTextWithStandalonePathLinks,
} from "./part-view-link-utils.js";
import { createCustomRenderer } from "./part-view-markdown-renderer.js";

test("links an absolute POSIX path line that contains spaces", () => {
  const segments = splitTextWithStandalonePathLinks(
    "/Users/vaclavsoukup/ai discussion projects/test/ulice_brno.xlsx",
  );

  assert.deepEqual(segments, [
    {
      kind: "link",
      value: "/Users/vaclavsoukup/ai discussion projects/test/ulice_brno.xlsx",
      href: "/Users/vaclavsoukup/ai discussion projects/test/ulice_brno.xlsx",
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
  const text = "Našel jsem online seznam ulic v Brně a uložil ho do Excelu.";
  const segments = splitTextWithStandalonePathLinks(
    text,
  );

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
  const html = renderInlineTextWithLinks(
    "Soubor je tady:\n/Users/vaclavsoukup/ai discussion projects/test/ulice_brno.xlsx",
  );

  assert.match(
    html,
    /href="\/Users\/vaclavsoukup\/ai discussion projects\/test\/ulice_brno\.xlsx"/,
  );
  assert.equal(html.startsWith("Soubor je tady:\n"), true);
});

test("renders a code-formatted file path as a clickable code link", () => {
  const html = renderCodeSpanWithLink(
    "/Users/vaclavsoukup/ai discussion projects/test/ulice_brno.xlsx",
    "inline-code-class",
  );

  assert.match(
    html,
    /^<a href="\/Users\/vaclavsoukup\/ai discussion projects\/test\/ulice_brno\.xlsx"/,
  );
  assert.match(html, /<code class="inline-code-class">/);
  assert.match(html, />\/Users\/vaclavsoukup\/ai discussion projects\/test\/ulice_brno\.xlsx<\/code><\/a>$/);
});

test("does not treat Czech company suffix s.r.o. as a file link", () => {
  const text = "Firma Acme s.r.o. dodá zboží.";
  const segments = splitTextWithStandalonePathLinks(text);
  assert.equal(segments.every((s) => s.kind === "text"), true);
  assert.equal(
    segments.map((s) => s.value).join(""),
    text,
  );
});

test("does not treat a Czech house number like 536/38 as a file link", () => {
  const text = "Adresa: Hlavní 536/38, Praha.";
  const segments = splitTextWithStandalonePathLinks(text);
  assert.equal(segments.every((s) => s.kind === "text"), true);
  assert.equal(
    segments.map((s) => s.value).join(""),
    text,
  );
});

test("renders list-item code paths with spaces as a single clickable markdown link", () => {
  const markdown = [
    "Výstupy:",
    "- **DOCX:**  ",
    "`/Users/vaclavsoukup/ai discussion projects/offer_template/output/20260311 - Neatech JAVEX-TRADE_Interni_Automatizace_Procesu.docx`",
    "- **PDF:**  ",
    "`/Users/vaclavsoukup/ai discussion projects/offer_template/output/20260311 - Neatech JAVEX-TRADE_Interni_Automatizace_Procesu.pdf`",
  ].join("\n");

  const html = marked.parse(markdown, {
    breaks: true,
    gfm: true,
    renderer: createCustomRenderer("light"),
    async: false,
  });

  const rendered = typeof html === "string" ? html : "";
  assert.match(rendered, /<strong>DOCX:<\/strong><br>/);
  assert.match(
    rendered,
    /<a href="\/Users\/vaclavsoukup\/ai discussion projects\/offer_template\/output\/20260311 - Neatech JAVEX-TRADE_Interni_Automatizace_Procesu\.docx"/,
  );
  assert.match(
    rendered,
    /<a href="\/Users\/vaclavsoukup\/ai discussion projects\/offer_template\/output\/20260311 - Neatech JAVEX-TRADE_Interni_Automatizace_Procesu\.pdf"/,
  );
  assert.doesNotMatch(rendered, /href="\/Users\/vaclavsoukup\/ai"/);
});
