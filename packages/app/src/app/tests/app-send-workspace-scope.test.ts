import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const workspaceSendTargetSource = readFileSync(
  new URL("../context/workspace-send-target.ts", import.meta.url),
  "utf8",
);

test("send preflight snapshots the target workspace before cold-start awaits", () => {
  const sendStart = source.indexOf("async function sendPrompt(");
  const sendEnd = source.indexOf("    const blockAppDuringPromptSend", sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart, "sendPrompt source should be present");
  const sendIntro = source.slice(sendStart, sendEnd);

  assert.match(
    sendIntro,
    /let sendTargetWorkspace = pendingSidebarTargetWorkspace \?\? resolveSendTargetWorkspaceScope\(sessionID\);[\s\S]*sendPreflight\.targetWorkspace = sendTargetWorkspace;/,
    "sendPrompt should snapshot the target workspace before awaits can observe a different active workspace",
  );
  assert.match(
    sendIntro,
    /sendPrompt:target-workspace-snapshot/,
    "sendPrompt should trace the scoped target used for this send",
  );
});

test("createSessionAndOpen uses preflight target only when send preflight provides one", () => {
  const start = source.indexOf("async function createSessionAndOpen(");
  const end = source.indexOf("  const chooseFolderForCurrentSession = async () =>", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const createSource = source.slice(start, end);

  assert.match(
    createSource,
    /const targetWorkspace =[\s\S]*preflight\?\.targetWorkspace \?\?[\s\S]*resolveSendTargetWorkspaceScope\(null\)/,
    "createSessionAndOpen should consume the preflight target workspace",
  );
  assert.doesNotMatch(
    createSource,
    /preflight\?\.targetWorkspace \?\?[\s\S]*resolveSendTargetWorkspaceScope\(selectedSessionId\(\)\)/,
    "direct session creation should not inherit the previously browsed selected session scope",
  );
  assert.match(
    createSource,
    /const sessionDirectory =[\s\S]*pendingSidebarSession\?\.workspaceRoot\?\.trim\(\) \|\|[\s\S]*targetWorkspace\?\.directory \|\|[\s\S]*targetWorkspace\?\.workspaceRoot \|\|[\s\S]*workspaceStore\.activeWorkspaceRoot\(\)\.trim\(\);/,
    "session creation should prefer the target directory over the current active workspace root",
  );
  assert.match(
    createSource,
    /const activeWorkspaceId = targetWorkspace\?\.workspaceId \|\| workspaceStore\.activeWorkspaceId\(\)\.trim\(\);/,
    "conversation creation should prefer the target workspace id over the current active workspace id",
  );
  assert.match(
    createSource,
    /const wsId =[\s\S]*pendingSidebarSession\?\.workspaceId\?\.trim\(\) \|\|[\s\S]*targetWorkspace\?\.workspaceId \|\|[\s\S]*\(workspaceStore\.connectingWorkspaceId\(\) \?\? workspaceStore\.activeWorkspaceId\(\)\)\.trim\(\);/,
    "sidebar injection should attach the new session to the target workspace",
  );
});

test("send engine startup uses the snapshotted target workspace", () => {
  const start = source.indexOf("async function sendPrompt(");
  const end = source.indexOf("async function abortSession", start);
  assert.ok(start >= 0 && end > start, "sendPrompt source should be present");
  const sendSource = source.slice(start, end);

  assert.match(
    sendSource,
    /workspaceStore\.ensureEngineForWorkspace\(sendTargetWorkspace\?\.workspaceId\)/,
    "browsing-mode send should start the target workspace engine instead of whichever workspace is currently active",
  );
});

test("scoped send and session creation do not fall back to the active client", () => {
  assert.match(
    source,
    /const workspaceSendTarget = createWorkspaceSendTarget<Client>\(\{[\s\S]*resolveSessionSendTargetScope: workspaceSessionSelection\.resolveSendTargetWorkspaceScope,[\s\S]*routedClient,[\s\S]*\}\);/,
    "app should wire scoped send target routing through the workspace send target controller",
  );
  assert.match(
    workspaceSendTargetSource,
    /const workspaceId = input\.targetWorkspace\?\.workspaceId\?\.trim\(\) \?\? "";[\s\S]*return workspaceId \? input\.routedClient\(workspaceId\) \?\? null : input\.routedClient\(\) \?\? null;/,
    "explicitly scoped sends should return null when the target workspace client is missing instead of using the active workspace client",
  );
  assert.match(
    source,
    /const c = routedClientForSendTarget\(sendTargetWorkspace\);/,
    "sendPrompt should use the scoped client resolver",
  );
  assert.match(
    source,
    /const c = routedClientForSendTarget\(targetWorkspace\);/,
    "createSessionAndOpen should use the scoped client resolver",
  );
  assert.doesNotMatch(
    source,
    /routedClient\(sendTargetWorkspace\?\.workspaceId\) \?\? routedClient\(\)|routedClient\(targetWorkspace\?\.workspaceId\) \?\? routedClient\(\)/,
    "scoped send/create must not fall back to the active client after an explicit target lookup",
  );
});
