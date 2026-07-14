import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../components/session/workspace-session-list.tsx", import.meta.url), "utf8");

test("session rows route through one shared row-class helper", () => {
  assert.match(
    source,
    /const sessionRowClass = \(isSelected: boolean, extraClass\?: string\) =>/,
    "session row visual state should be centralized in one helper",
  );
});

test("active row uses subtle stronger background and a left accent strip", () => {
  assert.match(source, /bg-gray-5 text-gray-12/, "active row should use a stronger neutral background");
  assert.match(
    source,
    /before:content-\[''\][\s\S]*before:bg-dls-accent/,
    "active row should render a thin cyan left accent strip via ::before pseudo-element",
  );
  assert.match(
    source,
    /before:left-1 before:top-1 before:bottom-1 before:w-0\.5/,
    "active row left strip should be tightly inset and thin",
  );
});

test("recent and by-project session rows both use the helper and aria-current", () => {
  const recentUses = source.match(/class=\{sessionRowClass\(isSelected\(\), "pr-12"\)\}/g) ?? [];
  assert.equal(recentUses.length, 1, "Recent rows should call the shared helper exactly once");

  const projectUses = source.match(/class=\{sessionRowClass\(isSelected\(\), "gap-2 pr-12"\)\}/g) ?? [];
  assert.equal(projectUses.length, 1, "By project rows should call the shared helper exactly once");

  const ariaCurrentUses = source.match(/aria-current=\{isSelected\(\) \? "page" : undefined\}/g) ?? [];
  assert.equal(ariaCurrentUses.length, 2, "Both render paths should expose active session via aria-current");
});

test("active background session rows render a loading spinner", () => {
  assert.match(
    source,
    /const isProjectedRowActive = \(row: FlatSessionRow\) =>[\s\S]*sidebarSessionActivityByRowKey\?\.\[row\.rowKey\]\?\.active/,
    "session rows should derive activity from the sole sidebar projection",
  );
  assert.match(source, /const rowForcesProjectOpen = \(row: FlatSessionRow\) =>[\s\S]*return isProjectedRowActive\(row\);/);

  const activityBindings = source.match(
    /classList=\{\{ "w-\[11px\] opacity-100": isSessionActive\(\), "w-0 opacity-0": !isSessionActive\(\) \}\}/g,
  ) ?? [];
  assert.equal(activityBindings.length, 2, "Recent and grouped rows should gate their spinner through the shared projection helper");

  const spinnerUses =
    source.match(/<Loader2 size=\{11\} class="shrink-0 animate-spin text-amber-10" \/>/g) ?? [];
  assert.equal(spinnerUses.length, 2, "Recent and grouped session rows should both render a loading spinner");
});
