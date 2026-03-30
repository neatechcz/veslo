import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("workspace session sidebar controls keep their accessibility labels", () => {
  assert.match(
    source,
    /aria-label=\{tr\("sidebar\.by_project"\)\}/,
    "project view toggle should keep its aria-label",
  );

  assert.match(
    source,
    /title=\{tr\("sidebar\.by_project"\)\}/,
    "project view toggle should keep its tooltip title",
  );

  assert.match(
    source,
    /aria-label=\{tr\("sidebar\.recent"\)\}/,
    "recent view toggle should keep its aria-label",
  );

  assert.match(
    source,
    /title=\{tr\("sidebar\.recent"\)\}/,
    "recent view toggle should keep its tooltip title",
  );

  assert.match(
    source,
    /aria-label=\{tr\("session\.command_palette_search_sessions"\)\}/,
    "search button should keep its aria-label",
  );

  assert.match(
    source,
    /title=\{tr\("session\.command_palette_search_sessions"\)\}/,
    "search button should keep its tooltip title",
  );

  assert.match(
    source,
    /aria-label=\{tr\("sidebar\.add_directory_session"\)\}/,
    "add-directory button should keep its aria-label",
  );

  assert.match(
    source,
    /title=\{tr\("sidebar\.add_directory_session"\)\}/,
    "add-directory button should keep its tooltip title",
  );

  assert.match(
    source,
    /tr\("sidebar\.new_session"\)/,
    "the primary new-session action should remain visible in the control rail",
  );
});
