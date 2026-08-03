import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const workspaceSource = readFileSync(new URL("../context/workspace.ts", import.meta.url), "utf8");

test("workspace runtime folder access requests are wired into the folder access consent flow", () => {
  assert.match(
    workspaceSource,
    /requestWorkspaceFolderAccess\?: \(input: \{[\s\S]*workspaceId: string;[\s\S]*workspacePath: string;[\s\S]*requestedPath: string;[\s\S]*reason: string;[\s\S]*\}\) => void;/,
  );
  assert.match(
    workspaceSource,
    /requestWorkspaceFolderAccess: options\.requestWorkspaceFolderAccess,/,
  );

  assert.match(appSource, /const \[localFolderAccessPermissionIds, setLocalFolderAccessPermissionIds\]/);
  assert.match(appSource, /function requestWorkspaceFolderAccess\([\s\S]*permission: "folder_access"/);
  assert.match(appSource, /source: "workspace-runtime-access-denied"/);
  assert.match(appSource, /setPendingPermissions\(\[[\s\S]*permission,[\s\S]*\.\.\.pendingPermissions\(\)\.filter/);
  assert.match(
    appSource,
    /if \(requestId && localFolderAccessPermissionIds\(\)\.has\(requestId\)\) \{[\s\S]*setPendingPermissions\(\s*pendingPermissions\(\)\.filter/,
  );
});
