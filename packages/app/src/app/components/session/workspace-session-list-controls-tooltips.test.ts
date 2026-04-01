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
    /data-tooltip=\{tr\("sidebar\.by_project"\)\}[\s\S]*<span class="sr-only">\{tr\("sidebar\.by_project"\)\}<\/span>/,
    "folder control should expose data-tooltip and an sr-only accessible label",
  );
  assert.doesNotMatch(source, /aria-label=\{tr\("sidebar\.by_project"\)\}/);

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.recent"\)\}[\s\S]*<span class="sr-only">\{tr\("sidebar\.recent"\)\}<\/span>/,
    "recents control should expose data-tooltip and an sr-only accessible label",
  );
  assert.doesNotMatch(source, /aria-label=\{tr\("sidebar\.recent"\)\}/);

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.new_session"\)\}/,
    "new control should expose data-tooltip",
  );
  assert.match(
    source,
    /data-tooltip=\{tr\("session\.command_palette_search_sessions"\)\}[\s\S]*<span class="sr-only">\{tr\("session\.command_palette_search_sessions"\)\}<\/span>/,
    "search control should expose data-tooltip and an sr-only accessible label",
  );
  assert.doesNotMatch(source, /aria-label=\{tr\("session\.command_palette_search_sessions"\)\}/);

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.add_directory_session"\)\}[\s\S]*<span class="sr-only">\{tr\("sidebar\.add_directory_session"\)\}<\/span>/,
    "new-folder control should expose data-tooltip and an sr-only accessible label",
  );
  assert.doesNotMatch(source, /aria-label=\{tr\("sidebar\.add_directory_session"\)\}/);

  assert.match(
    source,
    /data-tooltip=\{tr\("sidebar\.show_archived"\)\}[\s\S]*<span class="sr-only">\{tr\("sidebar\.show_archived"\)\}<\/span>/,
    "show-archived control should expose data-tooltip and an sr-only accessible label",
  );
  assert.doesNotMatch(source, /aria-label=\{tr\("sidebar\.show_archived"\)\}/);
});
