import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace.ts", import.meta.url), "utf8");

test("local activation path applies workspace_set_active response back into the workspace list", () => {
  assert.match(
    source,
    /_wsLog\("\[workspace:activate\] STEP 3 — workspaceSetActive\.\.\.", \{ id \}\);[\s\S]*const ws = await withTimeoutOrThrow\([\s\S]*workspaceSetActive\(id, \{ promoteToFront: activationOptions\?\.promoteToFront \?\? false \}\),[\s\S]*\);[\s\S]*setWorkspaces\(ws\.workspaces\);/s,
  );
});

test("ensuring an existing folder promotes that workspace to the top immediately", () => {
  assert.match(
    source,
    /const existing = findLocalWorkspaceByPath\(resolvedFolder\);[\s\S]*if \(existing\) \{[\s\S]*setWorkspaces\(\(prev\) => \{[\s\S]*return \[existing, \.\.\.rest\];[\s\S]*\}\);[\s\S]*return existing;[\s\S]*\}/s,
  );
});

test("connect flow keeps pending permissions loaded by refreshPendingPermissions", () => {
  assert.match(
    source,
    /await withTimeoutOrThrow\(\s*options\.refreshPendingPermissions\(\),[\s\S]*options\.setSelectedSessionId\(null\);[\s\S]*options\.setMessages\(\[\]\);[\s\S]*options\.setTodos\(\[\]\);[\s\S]*options\.setSessionStatusById\(\{\}\);/s,
  );

  assert.doesNotMatch(
    source,
    /await withTimeoutOrThrow\(\s*options\.refreshPendingPermissions\(\),[\s\S]{0,900}options\.setPendingPermissions\(\[\]\);/s,
  );
});
