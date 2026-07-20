import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDeveloperModeFromSearch,
  resolveDeveloperModeFromWindowLocation,
} from "./developer-mode.js";

test("developer mode accepts only the explicit debug query values", () => {
  for (const search of ["?debug", "?debug=1", "?debug=true", "?debug=yes", "?debug=on"]) {
    assert.equal(resolveDeveloperModeFromSearch(search), true, search);
  }

  for (const search of ["", "?debug=0", "?debug=false", "?debug=no", "?debug=disabled"]) {
    assert.equal(resolveDeveloperModeFromSearch(search), false, search);
  }
});

test("desktop developer mode resolves debug from the hash-router query", () => {
  assert.equal(
    resolveDeveloperModeFromWindowLocation({ search: "", hash: "#/settings?debug=true" }),
    true,
  );
  assert.equal(
    resolveDeveloperModeFromWindowLocation({ search: "?debug=1", hash: "#/settings" }),
    true,
  );
  assert.equal(
    resolveDeveloperModeFromWindowLocation({ search: "", hash: "#/settings?debug=false" }),
    false,
  );
});
