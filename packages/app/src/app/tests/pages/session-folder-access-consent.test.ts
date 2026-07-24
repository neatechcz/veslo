import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const viewPropsSource = readFileSync(new URL("../../app-view-props.ts", import.meta.url), "utf8");

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
  assert.match(viewPropsSource, /get refreshWorkspaceConfig\(\) \{\s*return refreshWorkspaceConfigForPath;\s*\}/);
});

test("app exposes a guarded E2E-only folder access permission injection hook", () => {
  assert.match(appSource, /import \{ getIdentifier, getVersion \} from "@tauri-apps\/api\/app";/);
  assert.match(appSource, /const E2E_APP_IDENTIFIER = "com\.neatech\.veslo\.e2e";/);
  assert.match(appSource, /identifier !== E2E_APP_IDENTIFIER/);
  assert.match(appSource, /__vesloE2EInjectFolderAccessPermission/);
  assert.match(appSource, /permission: input\.permission\?\.trim\(\) \|\| "folder_access"/);
  assert.match(appSource, /metadata: \{[\s\S]*requestedPath,[\s\S]*reason: input\.reason\?\.trim\(\) \|\| "E2E folder access request"/s);
  assert.match(appSource, /goToSession\(sessionId, \{ replace: true \}\)/);
});

test("app consumes synthetic E2E folder access permissions without calling the live permission API", () => {
  assert.match(appSource, /const \[e2eFolderAccessPermissionIds, setE2eFolderAccessPermissionIds\] = createSignal<Set<string>>/);
  assert.match(appSource, /async function respondPermissionForSessionView\(/);
  assert.match(appSource, /e2eFolderAccessPermissionIds\(\)\.has\(requestId\)/);
  assert.match(appSource, /setPendingPermissions\(pendingPermissions\(\)\.filter\(\(permission\) => permission\.id !== requestId\)\)/);
  assert.match(appSource, /__vesloE2ELastFolderAccessPermissionReply = \{ requestID: requestId, reply \}/);
  assert.match(appSource, /await respondPermission\(requestID, reply\)/);
  assert.match(appSource, /const respondPermissionForAppViewProps = respondPermissionForSessionView/);
  assert.match(viewPropsSource, /get respondPermission\(\) \{\s*return respondPermissionForAppViewProps;\s*\}/);
  assert.match(appSource, /await respondPermissionForSessionView\(requestID, reply\)/);
});
