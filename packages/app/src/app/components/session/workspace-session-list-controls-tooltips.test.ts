import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("workspace session controls expose matching data-tooltip without native tooltip duplication", () => {
  assert.match(
    source,
    /const sidebarControlTooltipClass =[\s\S]*after:delay-\[250ms\]/,
    "left sidebar control tooltips should use the reduced 250ms show delay",
  );

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.new_session"\)\}/,
    "new control should expose data-tooltip",
  );

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.add_directory_or_project"\)\}[\s\S]*<span class="sr-only">\{tr\("sidebar\.add_directory_or_project"\)\}<\/span>/,
    "add-directory-or-project control should expose data-tooltip and an sr-only accessible label",
  );
  assert.doesNotMatch(source, /aria-label=\{tr\("sidebar\.add_directory_or_project"\)\}/);

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.more_actions"\)\}[\s\S]*<span class="sr-only">\{tr\("sidebar\.more_actions"\)\}<\/span>/,
    "overflow control should expose data-tooltip and an sr-only accessible label",
  );
  assert.doesNotMatch(source, /aria-label=\{tr\("sidebar\.more_actions"\)\}/);

  assert.doesNotMatch(source, /data-tooltip=\{tr\("sidebar\.show_archived"\)\}/);
  assert.doesNotMatch(source, /data-tooltip=\{tr\("session\.command_palette_search_sessions"\)\}/);
  assert.doesNotMatch(source, /data-tooltip=\{tr\("sidebar\.by_project"\)\}/);
  assert.doesNotMatch(source, /data-tooltip=\{tr\("sidebar\.recent"\)\}/);
});
