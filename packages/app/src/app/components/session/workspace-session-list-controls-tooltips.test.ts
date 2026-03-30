import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("workspace session controls expose matching title and aria labels", () => {
  assert.match(
    source,
    /aria-label=\{tr\("sidebar\.by_project"\)\}[\s\S]*title=\{tr\("sidebar\.by_project"\)\}/,
    "folder control should expose both aria-label and title",
  );

  assert.match(
    source,
    /aria-label=\{tr\("sidebar\.recent"\)\}[\s\S]*title=\{tr\("sidebar\.recent"\)\}/,
    "recents control should expose both aria-label and title",
  );

  assert.match(
    source,
    /aria-label=\{tr\("sidebar\.new_session"\)\}[\s\S]*title=\{tr\("sidebar\.new_session"\)\}/,
    "new control should use the session label for accessibility and tooltip text",
  );

  assert.match(
    source,
    /aria-label=\{tr\("session\.command_palette_search_sessions"\)\}[\s\S]*title=\{tr\("session\.command_palette_search_sessions"\)\}/,
    "search control should expose both aria-label and title",
  );

  assert.match(
    source,
    /aria-label=\{tr\("sidebar\.add_directory_session"\)\}[\s\S]*title=\{tr\("sidebar\.add_directory_session"\)\}/,
    "new-folder control should expose both aria-label and title",
  );
});
