import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./titlebar-menu-toggles.tsx", import.meta.url), "utf8");

function extractBalancedJsxBlock(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);

  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `missing ${endMarker}`);

  return source.slice(start, end + endMarker.length);
}

function extractJsxAttributeValue(tagSource: string, attributeName: string) {
  const startMarker = `${attributeName}={`;
  const start = tagSource.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${attributeName} attribute`);

  let depth = 1;
  let inString: string | null = null;

  for (let i = start + startMarker.length; i < tagSource.length; i += 1) {
    const char = tagSource[i];
    if (inString) {
      if (char === "\\" && i + 1 < tagSource.length) {
        i += 1;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      inString = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return tagSource.slice(start + startMarker.length, i);
    }
  }

  throw new Error(`unclosed ${attributeName} attribute`);
}

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

test("titlebar menu toggles expose a dedicated right-side content slot", () => {
  const rightRail = extractBalancedJsxBlock(
    source,
    '<div class={layout.rightOffsetClass}>',
    "</div>",
  );

  assert.match(rightRail, /props\.rightContent/, "titlebar should render right-side content inside the shared right rail");
  assert.match(
    rightRail,
    /aria-label="Toggle right menu"/,
    "titlebar should keep the existing right toggle button in the shared right rail",
  );
  assert.ok(
    rightRail.indexOf("props.rightContent") < rightRail.indexOf('aria-label="Toggle right menu"'),
    "right-side content should appear before the existing right toggle button",
  );

  const dashboardSource = readFileSync(new URL("../pages/dashboard.tsx", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../pages/session.tsx", import.meta.url), "utf8");

  const dashboardTitlebar = extractBalancedJsxBlock(dashboardSource, "<TitlebarMenuToggles", "/>");
  const sessionTitlebar = extractBalancedJsxBlock(sessionSource, "<TitlebarMenuToggles", "/>");

  const dashboardRightContent = extractJsxAttributeValue(dashboardTitlebar, "rightContent");
  const sessionRightContent = extractJsxAttributeValue(sessionTitlebar, "rightContent");

  assert.match(dashboardRightContent, /^<button[\s\S]*onClick=/s, "dashboard should pass an actual button element into the shared titlebar slot");
  assert.match(sessionRightContent, /^<button[\s\S]*onClick=/s, "session should pass an actual button element into the shared titlebar slot");
});
