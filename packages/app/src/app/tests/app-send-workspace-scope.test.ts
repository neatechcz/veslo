import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sendWorkflowSource = readFileSync(new URL("../pages/session-send-workflow.ts", import.meta.url), "utf8");
const createWorkflowSource = readFileSync(new URL("../pages/session-creation-workflow.ts", import.meta.url), "utf8");
const readinessSource = readFileSync(new URL("../context/send-runtime-readiness.ts", import.meta.url), "utf8");
const workspaceSendTargetSource = readFileSync(new URL("../context/workspace-send-target.ts", import.meta.url), "utf8");
const mutationWorkflowSource = readFileSync(new URL("../pages/session-mutation-workflow.ts", import.meta.url), "utf8");

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
  assert.match(sendIntro, /sendPrompt:target-workspace-snapshot/, "sendPrompt should trace the scoped target used for this send");
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

test("skill command lookup follows the scoped target workspace", () => {
  assert.match(
    mutationWorkflowSource,
    /async function listCommands\(\s*scope: SessionMutationCommandListScope = \{\},[\s\S]*const scopedWorkspaceId = scope\.workspaceId\?\.trim\(\) \?\? "";[\s\S]*const c =\s*scopedWorkspaceId\s*\?\s*deps\.routedClient\(scopedWorkspaceId\)\s*:\s*deps\.routedClient\(\);/,
    "listCommands should use the explicitly scoped workspace client when one is provided",
  );
  assert.match(
    mutationWorkflowSource,
    /const directory =[\s\S]*scopedDirectory \|\|[\s\S]*deps\.workspaceRootForId\(scopedWorkspaceId, null\)[\s\S]*deps\.activeWorkspaceRoot\(\)\.trim\(\)[\s\S]*const list = \(await listCommandsTyped\(\s*c,\s*directory,\s*\)\)/,
    "listCommands should resolve command directory from the scoped workspace before the active workspace root",
  );
  assert.match(
    sendWorkflowSource,
    /const commandDirectory =[\s\S]*targetWorkspace\?\.directory\?\.trim\(\)[\s\S]*targetWorkspace\?\.workspaceRoot\?\.trim\(\)[\s\S]*deps\.listCommands\(\s*targetWorkspaceId\s*\?[\s\S]*workspaceId: targetWorkspaceId,[\s\S]*directory: commandDirectory,[\s\S]*: undefined,/,
    "skill auto-invocation should list skill commands from the same workspace used for skill resolution",
  );
});
