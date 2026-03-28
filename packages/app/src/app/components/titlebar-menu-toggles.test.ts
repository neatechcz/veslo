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

test("titlebar menu toggles expose brand and session context slots", () => {
  assert.match(
    source,
    /Veslo by Neatech/,
    "titlebar should render the Veslo brand next to the left toggle",
  );

  assert.match(
    source,
    /<div class=\{layout\.leftOffsetClass\}>[\s\S]*<LeftSidebarToggleIcon size=\{18\} \/>[\s\S]*Veslo by Neatech/,"titlebar should keep the brand in the left cluster beside the left toggle",
  );

  assert.match(
    source,
    /centerContent\??:/,
    "titlebar should accept an optional center-content prop for session context",
  );

  assert.match(
    source,
    /props\.centerContent/,
    "titlebar should render optional center content when provided by the page",
  );
});

test("titlebar menu toggles support a custom left label and default to toggle text", () => {
  assert.match(
    source,
    /leftLabel\?: string;/,
    "titlebar should accept an optional left-button label prop",
  );

  assert.match(
    source,
    /const\s+leftLabel\s*=\s*\(\)\s*=>\s*props\.leftLabel\s*\?\?\s*["']Toggle left menu["'];/,
    "titlebar should derive the left label reactively",
  );

  assert.match(
    source,
    /aria-label=\{leftLabel\(\)\}/,
    "titlebar should use the resolved left label for the aria-label",
  );

  assert.match(
    source,
    /title=\{leftLabel\(\)\}/,
    "titlebar should use the resolved left label for the title",
  );
});
