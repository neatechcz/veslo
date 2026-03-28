import assert from "node:assert/strict";
import test from "node:test";

import { isPrivateWorkspacePathForRoot, preferredSessionWorkspaceRoot } from "./index.js";

test("prefers selected session directory over active workspace root", () => {
  const sessionRoot =
    "/Users/alice/Library/Application Support/com.neatech.veslo.dev/private-workspaces/1774553831968-abd709dc-08b6-4666-9a8c-";
  const activeRoot = "/Users/alice/projects/technotrade";
  assert.equal(preferredSessionWorkspaceRoot(sessionRoot, activeRoot), sessionRoot);
});

test("falls back to active workspace root when session directory is empty", () => {
  const activeRoot = "/Users/alice/projects/technotrade";
  assert.equal(preferredSessionWorkspaceRoot("", activeRoot), activeRoot);
});

test("matches path nested under configured private workspace root", () => {
  const root = "/Users/alice/Library/Application Support/com.neatech.veslo.dev/private-workspaces";
  const folder = `${root}/1774553831968-abd709dc-08b6-4666-9a8c-`;
  assert.equal(isPrivateWorkspacePathForRoot(folder, root), true);
});

test("matches legacy/private marker path even when cached root is unavailable", () => {
  const folder =
    "/Users/alice/Library/Application Support/com.neatech.veslo.dev/private-workspaces/1774553831968-abd709dc-08b6-4666-9a8c-";
  assert.equal(isPrivateWorkspacePathForRoot(folder, ""), true);
  assert.equal(isPrivateWorkspacePathForRoot(folder, null), true);
});

test("does not treat regular workspace as private", () => {
  const root = "/Users/alice/Library/Application Support/com.neatech.veslo.dev/private-workspaces";
  const folder = "/Users/alice/projects/technotrade";
  assert.equal(isPrivateWorkspacePathForRoot(folder, root), false);
});
