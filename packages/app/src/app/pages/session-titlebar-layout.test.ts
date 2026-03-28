import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session routes the current directory into the shared titlebar", () => {
  assert.match(
    source,
    /<TitlebarMenuToggles[\s\S]*centerContent=\{/,
    "session should pass a centerContent value into the shared titlebar instead of keeping the path in the composer",
  );
});

test("session renders the disclaimer outside the composer", () => {
  assert.match(
    source,
    /\{\(_sessionKey\) => \(\s*<>\s*<Composer[\s\S]*\/>[\s\S]*session\.composer_disclaimer[\s\S]*<\/>\s*\)\}/,
    "session should render the disclaimer in session layout, not inside the Composer component",
  );
});
