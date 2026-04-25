import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session routes the current directory into the centered shared titlebar slot", () => {
  assert.match(
    source,
    /<TitlebarMenuToggles[\s\S]*centerContent=\{sessionTitlebarContext\(\)\}/,
    "session should pass the current directory into the centered titlebar slot",
  );

  assert.doesNotMatch(
    source,
    /<TitlebarMenuToggles[\s\S]*leftContent=\{/,
    "session should not override the shared left titlebar content",
  );

  assert.doesNotMatch(
    source,
    /<TitlebarMenuToggles[\s\S]*showBrand=\{false\}/,
    "session should keep the shared brand fallback enabled",
  );
});

test("session clears the native centered window title while custom titlebar context is active", () => {
  assert.match(
    source,
    /acquireBlankNativeWindowTitleLease/,
    "session should acquire the shared blank native title lease so the default centered product name does not remain visible alongside the custom titlebar content",
  );

  assert.match(
    source,
    /releaseNativeWindowTitleLease\?\.\(\)/,
    "session should release the shared blank native title lease on cleanup instead of restoring the product title directly",
  );
});

test("session titlebar directory uses the shared app font instead of monospace", () => {
  assert.doesNotMatch(
    source,
    /font-mono text-\[12px\] leading-6 text-gray-10/,
    "session titlebar directory should not keep the old monospace treatment from the composer",
  );
});

test("session hides the centered directory context when the chat is empty", () => {
  assert.match(
    source,
    /const sessionTitlebarContext = createMemo\(\(\) => \{\s*if \(props\.messages\.length === 0\) return null;/,
    "session should avoid showing duplicate directory context above the composer in empty chats",
  );
});

test("session renders the disclaimer outside the composer", () => {
  assert.match(
    source,
    /\{\(_sessionKey\) => \(\s*<>[\s\S]*<Composer[\s\S]*\/>[\s\S]*session\.composer_disclaimer[\s\S]*<\/>\s*\)\}/,
    "session should render the disclaimer in session layout, not inside the Composer component",
  );
});
