import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sendWorkflowSource = readFileSync(
  new URL("../pages/session-send-workflow.ts", import.meta.url),
  "utf8",
);
const createWorkflowSource = readFileSync(
  new URL("../pages/session-creation-workflow.ts", import.meta.url),
  "utf8",
);
const readinessSource = readFileSync(new URL("../context/send-runtime-readiness.ts", import.meta.url), "utf8");
const workspaceSendTargetSource = readFileSync(
  new URL("../context/workspace-send-target.ts", import.meta.url),
  "utf8",
);
const mutationWorkflowSource = readFileSync(
  new URL("../pages/session-mutation-workflow.ts", import.meta.url),
  "utf8",
);

function conversationRunCompatibilityBridgePrepareSource(): string {
  const bridgeStart = sendWorkflowSource.indexOf("export function createConversationRunCompatibilityBridge(");
  const prepareStart = sendWorkflowSource.indexOf("  const prepare = async", bridgeStart);
  const submitStart = sendWorkflowSource.indexOf("  const submit = async", prepareStart);
  assert.ok(prepareStart >= 0 && submitStart > prepareStart, "compatibility bridge prepare source should be present");
  return sendWorkflowSource.slice(prepareStart, submitStart);
}

test("send preflight snapshots the target workspace before cold-start awaits", () => {
  const sendStart = sendWorkflowSource.indexOf("async function sendPrompt(");
  const sendEnd = sendWorkflowSource.indexOf("    const sendPromptBusyOwnership", sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart, "sendPrompt source should be present");
  const sendIntro = sendWorkflowSource.slice(sendStart, sendEnd);

  assert.match(
    sendIntro,
    /let sendTargetWorkspace =[\s\S]*pendingSidebarTargetWorkspace \?\?[\s\S]*deps\.resolveSendTargetWorkspaceScope\(sessionID\);[\s\S]*sendPreflight\.targetWorkspace = sendTargetWorkspace;/,
    "sendPrompt should snapshot the target workspace before awaits can observe a different active workspace",
  );
  assert.match(
    sendIntro,
    /sendPrompt:target-workspace-snapshot/,
    "sendPrompt should trace the scoped target used for this send",
  );
});

test("createSessionAndOpen uses preflight target only when send preflight provides one", () => {
  const start = createWorkflowSource.indexOf("const runCreateSessionFlow = async (");
  const end = createWorkflowSource.indexOf("const createSession = (", start);
  assert.ok(start >= 0 && end > start, "createSessionAndOpen source should be present");
  const createSource = createWorkflowSource.slice(start, end);

  assert.match(
    createSource,
    /const targetWorkspace =[\s\S]*preflight\?\.targetWorkspace \?\?[\s\S]*deps\.resolveSendTargetWorkspaceScope\(null\)/,
    "createSessionAndOpen should consume the preflight target workspace",
  );
  assert.doesNotMatch(
    createSource,
    /preflight\?\.targetWorkspace \?\?[\s\S]*resolveSendTargetWorkspaceScope\(selectedSessionId\(\)\)/,
    "direct session creation should not inherit the previously browsed selected session scope",
  );
  assert.match(
    createSource,
    /const sessionDirectory =[\s\S]*pendingSidebarSession\?\.workspaceRoot\?\.trim\(\) \|\|[\s\S]*targetWorkspace\?\.directory \|\|[\s\S]*targetWorkspace\?\.workspaceRoot \|\|[\s\S]*deps\.workspace\.activeWorkspaceRoot\(\)\.trim\(\);/,
    "session creation should prefer the target directory over the current active workspace root",
  );
  assert.match(
    createSource,
    /const activeWorkspaceId =[\s\S]*targetWorkspace\?\.workspaceId \|\|[\s\S]*deps\.workspace\.activeWorkspaceId\(\)\.trim\(\);/,
    "conversation creation should prefer the target workspace id over the current active workspace id",
  );
  assert.match(
    createSource,
    /const createdWorkspaceId = resolveCreatedSessionWorkspaceId\(\{[\s\S]*pendingSidebarSession,[\s\S]*targetWorkspaceId: targetWorkspace\?\.workspaceId,[\s\S]*connectingWorkspaceId: deps\.workspace\.connectingWorkspaceId\(\),[\s\S]*activeWorkspaceId: deps\.workspace\.activeWorkspaceId\(\),[\s\S]*\}\);[\s\S]*workspaceScope: \{[\s\S]*workspaceId: createdWorkspaceId,/,
    "sidebar injection should attach the new session to the target workspace",
  );
});

test("send engine startup uses the snapshotted target workspace", () => {
  const prepareSource = conversationRunCompatibilityBridgePrepareSource();

  assert.match(
    prepareSource,
    /deps\.prepareSendRuntimeForSend\(\s*"sendPrompt",\s*input\.sendPreflight,?\s*\)/,
    "browsing-mode compatibility bridge should delegate engine startup to the send runtime readiness owner",
  );
  assert.match(
    readinessSource,
    /deps\.ensureEngineForWorkspace\(targetWorkspaceId \|\| undefined, \{[\s\S]*reason: `\$\{reason\}-runtime-initial-ensure`,[\s\S]*loadSessions: false,[\s\S]*skipManagedAiConfig: true,/s,
    "initial send runtime readiness should start the snapshotted target workspace instead of whichever workspace is currently active",
  );
  assert.match(
    readinessSource,
    /deps\.requestServerRuntimeRecovery\?\.\(\{[\s\S]*workspaceId: recoveryWorkspaceId,[\s\S]*reason: recoveryReason,/,
    "a later recovery should delegate to the server operation owner with the same scoped workspace",
  );
});

test("scoped send and session creation do not fall back to the active client", () => {
  assert.match(
    source,
    /const workspaceSendTarget = createWorkspaceSendTarget<Client>\(\{[\s\S]*resolveSessionSendTargetScope:[\s\S]*workspaceSessionSelection\.resolveSendTargetWorkspaceScope,[\s\S]*routedClient,[\s\S]*\}\);/,
    "app should wire scoped send target routing through the workspace send target controller",
  );
  assert.match(
    workspaceSendTargetSource,
    /const workspaceId = input\.targetWorkspace\?\.workspaceId\?\.trim\(\) \?\? "";[\s\S]*return workspaceId \? input\.routedClient\(workspaceId\) \?\? null : input\.routedClient\(\) \?\? null;/,
    "explicitly scoped sends should return null when the target workspace client is missing instead of using the active workspace client",
  );
  assert.match(
    conversationRunCompatibilityBridgePrepareSource(),
    /const c = deps\.routedClientForSendTarget\(input\.sendTargetWorkspace\);/,
    "compatibility bridge prepare should use the scoped client resolver",
  );
  assert.match(
    createWorkflowSource,
    /const client = deps\.routedClientForSendTarget\(targetWorkspace\);/,
    "createSessionAndOpen should use the scoped client resolver",
  );
  assert.doesNotMatch(
    `${sendWorkflowSource}\n${createWorkflowSource}`,
    /routedClient\(sendTargetWorkspace\?\.workspaceId\) \?\? routedClient\(\)|routedClient\(targetWorkspace\?\.workspaceId\) \?\? routedClient\(\)/,
    "scoped send/create must not fall back to the active client after an explicit target lookup",
  );
});

test("skill command lookup follows the scoped target workspace", () => {
  assert.match(
    mutationWorkflowSource,
    /async function listCommands\(\s*scope: SessionMutationCommandListScope = \{\},[\s\S]*const scopedWorkspaceId = scope\.workspaceId\?\.trim\(\) \?\? "";[\s\S]*const c = scopedWorkspaceId \? deps\.routedClient\(scopedWorkspaceId\) : deps\.routedClient\(\);/,
    "listCommands should use the explicitly scoped workspace client when one is provided",
  );
  assert.match(
    mutationWorkflowSource,
    /const directory =[\s\S]*scopedDirectory \|\|[\s\S]*deps\.workspaceRootForId\(scopedWorkspaceId, null\)[\s\S]*deps\.activeWorkspaceRoot\(\)\.trim\(\)[\s\S]*const list = await listCommandsTyped\(c, directory\)/,
    "listCommands should resolve command directory from the scoped workspace before the active workspace root",
  );
  assert.match(
    sendWorkflowSource,
    /const commandDirectory =[\s\S]*targetWorkspace\?\.directory\?\.trim\(\)[\s\S]*targetWorkspace\?\.workspaceRoot\?\.trim\(\)[\s\S]*deps\.listCommands\(\s*targetWorkspaceId\s*\?[\s\S]*workspaceId: targetWorkspaceId,[\s\S]*directory: commandDirectory,[\s\S]*: undefined,/,
    "skill auto-invocation should list skill commands from the same workspace used for skill resolution",
  );
});
