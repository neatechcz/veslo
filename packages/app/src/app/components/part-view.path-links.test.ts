import assert from "node:assert/strict";
import test from "node:test";

import {
  renderInlineTextWithLinks,
  splitTextWithStandalonePathLinks,
} from "./part-view-link-utils.js";

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
