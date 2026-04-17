import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("overflow menu contains only the approved secondary actions", () => {
  assert.match(
    source,
    /tr\("sidebar\.archived_items"\)[\s\S]*tr\("session\.command_palette_search_sessions"\)[\s\S]*tr\("sidebar\.by_project"\)[\s\S]*tr\("sidebar\.recent"\)/,
    "overflow menu should contain archived items, search, by-project, and recent in order",
  );

  assert.match(
    source,
    /<Show when=\{props\.onOpenArchivedSessions\}>[\s\S]*tr\("sidebar\.archived_items"\)/,
    "archived items should only render when the parent provides the settings navigation callback",
  );

  assert.match(
    source,
    /<Show when=\{props\.onOpenSessionSearch\}>[\s\S]*tr\("session\.command_palette_search_sessions"\)/,
    "search should only render when the parent provides a session-search callback",
  );

  assert.doesNotMatch(
    source,
    /tr\("sidebar\.show_archived"\)/,
    "overflow menu should not keep the old show-archived toggle copy",
  );
});

test("overflow menu exposes keyboard and screen-reader affordances", () => {
  assert.match(
    source,
    /aria-haspopup="menu"[\s\S]*aria-expanded=\{moreActionsMenuOpen\(\)\}/,
    "overflow trigger should announce menu semantics and expanded state",
  );

  assert.match(
    source,
    /role="menu"/,
    "overflow popup should expose menu semantics",
  );

  assert.match(
    source,
    /window\.addEventListener\("keydown", handleMoreActionsKeyDown\)/,
    "overflow menu should install a keyboard close handler",
  );

  assert.match(
    source,
    /if \(event\.key !== "Escape" && event\.key !== "Tab"\) return;/,
    "overflow keyboard handler should close on Escape and Tab without relying on blur races",
  );

  assert.doesNotMatch(
    source,
    /onFocusOut=\{\(event\) => \{/,
    "overflow wrapper should not synchronously close on focusout because real clicks can lose focus before menu item handlers run",
  );
});
