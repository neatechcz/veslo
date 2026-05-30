import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session routes the current directory into the centered shared titlebar slot", () => {
  assert.match(
    source,
    /resolveSessionTitlebarContext/,
    "session should derive titlebar state and directory through the shared titlebar context model",
  );

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

test("session titlebar session label truncates within the minimum window width", () => {
  assert.match(
    source,
    /class="[^"]*\bmin-w-0\b[^"]*max-w-\[14rem\][^"]*\btruncate\b[^"]*"[\s\S]*title=\{label\(\)\}[\s\S]*>\s*\{label\(\)\}/,
    "session title label should own truncation so long names fit inside the narrow centered titlebar slot",
  );

  assert.doesNotMatch(
    source,
    /class="[^"]*\bmax-w-full\b[^"]*"[\s\S]*title=\{label\(\)\}[\s\S]*>\s*\{label\(\)\}/,
    "session title label should keep an explicit width cap instead of using unbounded max-w-full",
  );

  assert.doesNotMatch(
    source,
    /class="[^"]*\bshrink-0\b[^"]*"[\s\S]*title=\{label\(\)\}[\s\S]*>\s*\{label\(\)\}/,
    "session title label must be allowed to shrink instead of forcing the titlebar wider than the minimum window",
  );
});

test("session keeps centered titlebar context visible for new empty chats", () => {
  assert.doesNotMatch(
    source,
    /const sessionTitlebarContext = createMemo\(\(\) => \{\s*if \(props\.messages\.length === 0\) return null;/,
    "session should show titlebar context before the first message exists",
  );

  const titlebarContextCall = source.match(
    /return resolveSessionTitlebarContext\(\{[\s\S]*?\n    \}\);/,
  )?.[0];
  assert.ok(titlebarContextCall, "session should call resolveSessionTitlebarContext with a literal options object");
  assert.match(
    titlebarContextCall,
    /selectedSessionTitle: selectedSessionTitle\(\) \|\| null,/,
    "session titlebar should use the selected session title from session state, not only the visible sidebar rows",
  );
  assert.doesNotMatch(
    titlebarContextCall,
    /selectedSessionTitle: selectedSessionSidebarItem\(\)\?\.title \?\? null,/,
    "session titlebar must not fall back to Chat only because the selected session is outside the sidebar page",
  );
  assert.match(
    titlebarContextCall,
    /newSessionLabel: tr\("session\.chat_label"\),/,
    "session titlebar should use chat copy for the new-session state label",
  );
  assert.match(
    titlebarContextCall,
    /chatFallbackLabel: tr\("session\.chat_label"\),/,
    "session titlebar should use chat copy for untitled private-session fallback titles",
  );
  assert.doesNotMatch(
    titlebarContextCall,
    /session\.new_session_label/,
    "session titlebar context should not keep old New session copy wiring",
  );

  assert.match(
    source,
    /stateLabel[\s\S]*locationLabel[\s\S]*[·•]/,
    "session should render a separator between the New session state and directory label",
  );
});

test("session renders the disclaimer outside the composer", () => {
  assert.match(
    source,
    /\{\(_sessionKey\) => \(\s*<>[\s\S]*<Composer[\s\S]*\/>[\s\S]*session\.composer_disclaimer[\s\S]*<\/>\s*\)\}/,
    "session should render the disclaimer in session layout, not inside the Composer component",
  );
});
