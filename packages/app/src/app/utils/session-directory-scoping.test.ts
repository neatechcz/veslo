import assert from "node:assert/strict";
import test from "node:test";

import { sessionDirectoryMatchesRoot } from "./index.js";

test("matches when session directory equals workspace root", () => {
  assert.equal(
    sessionDirectoryMatchesRoot("/Users/alice/workspace", "/Users/alice/workspace"),
    true,
  );
});

test("matches temporary sessions with empty directory to active workspace root", () => {
  assert.equal(
    sessionDirectoryMatchesRoot("", "/Users/alice/private-workspaces/tmp-123"),
    true,
  );
});

test("does not match session from a different root", () => {
  assert.equal(
    sessionDirectoryMatchesRoot("/Users/alice/other", "/Users/alice/workspace"),
    false,
  );
});
