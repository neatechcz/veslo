import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("session page routes explicit folder access permissions to the localized consent modal", () => {
  assert.match(source, /import FolderAccessConsentModal from "\.\.\/components\/folder-access-consent-modal";/);
  assert.match(source, /resolveFolderAccessRequestFromPermission/);
  assert.match(source, /activeWorkspaceId: props\.activeWorkspaceId/);
  assert.match(source, /workspaces: props\.workspaces/);
  assert.match(source, /const activeFolderAccessRequest = createMemo/);
  assert.match(source, /<FolderAccessConsentModal/);
  assert.match(source, /requestedPath=\{activeFolderAccessRequest\(\)\?\.requestedPath \?\? ""\}/);
  assert.match(source, /pickerStartPath=\{activeFolderAccessRequest\(\)\?\.pickerStartPath \?\? ""\}/);
  assert.match(source, /onChooseFolder=\{\(\) => void chooseFolderForAccessRequest\(\)\}/);
});

test("session folder access flow opens picker at requested folder and persists read grant", () => {
  assert.match(source, /pickDirectory\(\{[\s\S]*defaultPath: request\.pickerStartPath/s);
  assert.match(source, /selectedFolderContainsRequestedPath\(selectedFolderPath, request\.requestedPath\)/);
  assert.match(source, /workspaceGrantFolderAccess\(\{[\s\S]*workspacePath: request\.workspacePath,[\s\S]*requestedPath: request\.requestedPath,[\s\S]*selectedFolderPath,[\s\S]*accessMode: "read"/s);
  assert.match(source, /await props\.refreshWorkspaceConfig\(request\.workspacePath\)/);
  assert.match(source, /await props\.reloadWorkspaceEngine\(request\.workspaceId\)/);
  assert.match(source, /props\.respondPermission\(request\.permissionId, "once"\)/);
});

test("generic runtime permission prompt is hidden while folder access consent is active", () => {
  assert.match(source, /<Show when=\{props\.activePermission && !activeFolderAccessRequest\(\)\}>/);
});

test("app passes a workspace config refresh callback into the session view", () => {
  assert.match(appSource, /async function refreshWorkspaceConfigForPath\(workspacePath\?: string\)/);
  assert.match(appSource, /workspaceVesloRead\(\{ workspacePath: targetPath \}\)/);
  assert.match(appSource, /workspaceStore\.setWorkspaceConfig\(cfg\)/);
  assert.match(appSource, /workspaceStore\.setAuthorizedDirs\(roots\.length \? roots : \[targetPath\]\)/);
  assert.match(appSource, /const reloadWorkspaceEngineAndResume = async \(workspaceId\?: string\)/);
  assert.match(appSource, /workspaceStore\.activateWorkspace\(targetWorkspaceId/);
  assert.match(appSource, /refreshWorkspaceConfig: refreshWorkspaceConfigForPath/);
});
