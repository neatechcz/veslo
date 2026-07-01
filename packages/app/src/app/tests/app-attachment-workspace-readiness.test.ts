import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stagingModuleSource = readFileSync(new URL("../pages/session-attachment-staging.ts", import.meta.url), "utf8");
const sendWorkflowSource = readFileSync(new URL("../pages/session-send-workflow.ts", import.meta.url), "utf8");

test("attachment staging validates cached workspace ids against the active server list", () => {
  const resolverStart = stagingModuleSource.indexOf("const resolveWorkspaceIdForAttachmentStaging = async (");
  const resolverEnd = stagingModuleSource.indexOf("  const recoverWorkspaceReadyForAttachmentStaging = async (", resolverStart);
  assert.notEqual(resolverStart, -1, "workspace resolver should exist");
  assert.ok(resolverEnd > resolverStart, "workspace resolver should end before readiness helpers");
  const resolverSource = stagingModuleSource.slice(resolverStart, resolverEnd);

  assert.doesNotMatch(
    resolverSource,
    /if \(workspaceId\) return workspaceId;/,
    "attachment staging must not trust a cached Veslo workspace id without checking the active server workspace list",
  );
  assert.match(
    resolverSource,
    /const response = await client\.listWorkspaces\(\);[\s\S]*const cachedWorkspaceId = \(deps\.vesloServerWorkspaceId\(\) \?\? ""\)\.trim\(\);/s,
    "attachment staging should always inspect the current server workspace list before resolving a workspace id",
  );
  assert.match(
    resolverSource,
    /\(cachedWorkspaceId && items\.find\(\(entry\) => entry\.id === cachedWorkspaceId\)\?\.id\)/,
    "cached remote workspace ids should only be reused when the connected server still lists them",
  );
  assert.match(
    resolverSource,
    /findByPath\(activeRoot\)\?\.id \|\|[\s\S]*\(!activeRoot && items\.length === 1/s,
    "local attachment staging should prefer the active workspace root before falling back to a single listed workspace",
  );
});

test("attachment staging self-heals a missing local server workspace once before failing", () => {
  const stagingStart = stagingModuleSource.indexOf("const stageAttachmentsIntoSessionDirectory = async (");
  const stagingEnd = stagingModuleSource.indexOf(
    "  const buildPromptParts = (draft: ComposerDraft): SessionAttachmentPartInput[] =>",
    stagingStart,
  );
  assert.notEqual(stagingStart, -1, "staging function should exist");
  assert.ok(stagingEnd > stagingStart, "staging function should end before prompt building");
  const stagingSource = stagingModuleSource.slice(stagingStart, stagingEnd);

  assert.match(
    stagingModuleSource,
    /const ensureWorkspaceReadyForAttachmentStaging = async \([\s\S]*resolveWorkspaceIdForAttachmentStaging\(client\)[\s\S]*recoverWorkspaceReadyForAttachmentStaging\(client\)/s,
    "staging should recover local server workspace state when resolution cannot find a workspace id",
  );
  assert.match(
    stagingModuleSource,
    /const shouldRecoverAttachmentStagingWorkspace = \(error: unknown\) => \{[\s\S]*error instanceof VesloServerError[\s\S]*error\.status === 404[\s\S]*message\.includes\("workspace"\) && message\.includes\("not"\)/s,
    "missing workspace errors should be classified as one-shot recovery candidates",
  );
  assert.match(
    stagingSource,
    /let ready: AttachmentStagingWorkspaceReady[\s\S]*resolution\?\.serverWorkspaceId[\s\S]*ensureWorkspaceReadyForAttachmentStaging\(client\)/s,
    "preflight server workspace resolution should be preserved before using the fallback resolver",
  );
  assert.match(
    stagingSource,
    /catch \(error\) \{[\s\S]*shouldRecoverAttachmentStagingWorkspace\(error\)[\s\S]*ready = await recoverWorkspaceReadyForAttachmentStaging\(ready\.client\);[\s\S]*ready\.client\.createFileSession\(ready\.workspaceId,/s,
    "file-session creation should retry once after refreshing the local workspace/server state",
  );

  const appStagingCallIndex = sendWorkflowSource.indexOf(
    "deps.stageAttachmentsIntoSessionDirectory(resolvedDraft, sessionID, sendPreflight)",
  );
  const promptAsyncIndex = sendWorkflowSource.indexOf('kind: "prompt_async"');
  assert.notEqual(appStagingCallIndex, -1, "send workflow should call the staging module");
  assert.notEqual(promptAsyncIndex, -1, "prompt_async conversation handoff should exist");
  assert.ok(
    appStagingCallIndex < promptAsyncIndex,
    "attachments must be staged after session materialization but before the conversation prompt starts",
  );
});
