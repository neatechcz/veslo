import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stagingModuleSource = readFileSync(new URL("./pages/session-attachment-staging.ts", import.meta.url), "utf8");
const sendWorkflowSource = readFileSync(new URL("./pages/session-send-workflow.ts", import.meta.url), "utf8");

function conversationRunCompatibilityBridgeSource(): string {
  const start = sendWorkflowSource.indexOf("export function createConversationRunCompatibilityBridge(");
  const end = sendWorkflowSource.indexOf("export function createSessionSendWorkflow(", start);
  assert.ok(start >= 0 && end > start, "conversation run compatibility bridge source should be present");
  return sendWorkflowSource.slice(start, end);
}

test("attachment staging validates explicit workspace ids against the active server list", () => {
  const resolverStart = stagingModuleSource.indexOf("const resolveWorkspaceIdForAttachmentStaging = async (");
  const resolverEnd = stagingModuleSource.indexOf("  const recoverWorkspaceReadyForAttachmentStaging = async (", resolverStart);
  assert.notEqual(resolverStart, -1, "workspace resolver should exist");
  assert.ok(resolverEnd > resolverStart, "workspace resolver should end before readiness helpers");
  const resolverSource = stagingModuleSource.slice(resolverStart, resolverEnd);

  assert.match(
    resolverSource,
    /const response = await client\.listWorkspaces\(\);[\s\S]*const listedWorkspaceId = \(workspaceId: string \| null \| undefined\) => \{/s,
    "attachment staging should validate explicit workspace ids against the current server workspace list",
  );
  assert.doesNotMatch(
    resolverSource,
    /findByPath|activeId|items\.length === 1|items\[0\]|entry\.path|entry\.directory|entry\.opencode\?\.directory/,
    "attachment staging must not infer workspace ids from path, activeId, or singleton server lists",
  );
});

test("attachment staging self-heals a missing server workspace once before failing", () => {
  const stagingStart = stagingModuleSource.indexOf("const stageAttachmentsIntoSessionDirectory = async (");
  const stagingEnd = stagingModuleSource.indexOf(
    "  const buildPromptParts = (draft: ComposerDraft): SessionAttachmentPartInput[] =>",
    stagingStart,
  );
  assert.notEqual(stagingStart, -1, "staging function should exist");
  assert.ok(stagingEnd > stagingStart, "staging function should end before prompt building");
  const stagingSource = stagingModuleSource.slice(stagingStart, stagingEnd);

  assert.match(
    stagingSource,
    /let ready: AttachmentStagingWorkspaceReady[\s\S]*resolution\?\.serverWorkspaceId[\s\S]*ensureWorkspaceReadyForAttachmentStaging\(client\)/s,
    "preflight server workspace resolution should be preserved before using the fallback resolver",
  );
  assert.match(
    stagingSource,
    /catch \(error\) \{[\s\S]*shouldRecoverAttachmentStagingWorkspace\(error\)[\s\S]*ready = await recoverWorkspaceReadyForAttachmentStaging\(ready\.client\);[\s\S]*ready\.client\.createFileSession\(ready\.workspaceId,/s,
    "staging should retry file-session creation once after refreshing the local workspace/server state",
  );

  const bridgeSource = conversationRunCompatibilityBridgeSource();
  const appStagingCallIndex = bridgeSource.search(
    /deps\.sendTraceStep\(\s*"sendPrompt:stage-attachments",\s*\(\)\s*=>\s*deps\.stageAttachmentsIntoSessionDirectory\(\s*resolvedDraft,\s*materializedSessionID,\s*input\.sendPreflight,?\s*\)/s,
  );
  const promptAsyncIndex = bridgeSource.indexOf('kind: "prompt_async"');
  assert.notEqual(appStagingCallIndex, -1, "send workflow should call the staging module");
  assert.notEqual(promptAsyncIndex, -1, "prompt_async conversation handoff should exist");
  assert.ok(
    appStagingCallIndex < promptAsyncIndex,
    "attachments must be staged after session materialization but before the conversation prompt starts",
  );
});
