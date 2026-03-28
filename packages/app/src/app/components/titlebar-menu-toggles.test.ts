import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./titlebar-menu-toggles.tsx", import.meta.url), "utf8");

test("titlebar menu toggles keep macOS-sized icon controls", () => {
  assert.match(
    source,
    /`h-6 w-6 flex items-center justify-center bg-transparent transition-colors focus:outline-none focus-visible:ring-0 \$\{/,
    "titlebar toggles should keep a 24px control box so their height matches native titlebar buttons",
  );

  assert.match(
    source,
    /<LeftSidebarToggleIcon size=\{18\} \/>/,
    "left titlebar toggle icon should use the 18px size needed for the visible outline to match native titlebar button height",
  );

  assert.match(
    source,
    /<RightSidebarToggleIcon size=\{18\} \/>/,
    "right titlebar toggle icon should use the 18px size needed for the visible outline to match native titlebar button height",
  );

  assert.doesNotMatch(
    source,
    /h-5 w-5|size=\{11\}|size=\{13\}/,
    "titlebar toggles should not regress to undersized icon metrics",
  );
});

test("titlebar menu toggles let session context replace the left-side brand", () => {
  assert.match(
    source,
    /Veslo by Neatech/,
    "titlebar should keep the Veslo brand as the fallback label when no session-specific titlebar content is provided",
  );

  assert.match(
    source,
    /leftContent\??:[\s\S]*showBrand\??:/,
    "titlebar should accept optional left-side content and an explicit brand toggle so session view can show only the directory beside the left toggle",
  );

  assert.match(
    source,
    /<div class=\{layout\.leftOffsetClass\}>[\s\S]*<LeftSidebarToggleIcon size=\{18\} \/>[\s\S]*props\.leftContent[\s\S]*props\.showBrand !== false[\s\S]*Veslo by Neatech/,
    "titlebar should render provided left-side content in the same cluster as the left toggle and only show the brand fallback when that behavior is explicitly enabled",
  );
});
