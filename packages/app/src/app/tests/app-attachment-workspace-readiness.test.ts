import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("attachment staging validates cached workspace ids against the active server list", () => {
  const resolverStart = source.indexOf("const resolveWorkspaceIdForAttachmentStaging = async (");
  const resolverEnd = source.indexOf("  type AttachmentStagingWorkspaceReady = {", resolverStart);
  assert.notEqual(resolverStart, -1, "workspace resolver should exist");
  assert.ok(resolverEnd > resolverStart, "workspace resolver should end before readiness helpers");
  const resolverSource = source.slice(resolverStart, resolverEnd);

  assert.doesNotMatch(
    resolverSource,
    /if \(workspaceId\) return workspaceId;/,
    "attachment staging must not trust a cached Veslo workspace id without checking the active server workspace list",
  );
  assert.match(
    resolverSource,
    /const response = await client\.listWorkspaces\(\);[\s\S]*const cachedWorkspaceId = \(vesloServerWorkspaceId\(\) \?\? ""\)\.trim\(\);/s,
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
  const stagingStart = source.indexOf("const stageAttachmentsIntoSessionDirectory = async (");
  const stagingEnd = source.indexOf("  const buildPromptParts = (draft: ComposerDraft): PartInput[] =>", stagingStart);
  assert.notEqual(stagingStart, -1, "staging function should exist");
  assert.ok(stagingEnd > stagingStart, "staging function should end before prompt building");
  const stagingSource = source.slice(stagingStart, stagingEnd);

  assert.match(
    source,
    /const ensureWorkspaceReadyForAttachmentStaging = async \([\s\S]*resolveWorkspaceIdForAttachmentStaging\(client\)[\s\S]*recoverWorkspaceReadyForAttachmentStaging\(client\)/s,
    "staging should recover local server workspace state when resolution cannot find a workspace id",
  );
  assert.match(
    source,
    /const shouldRecoverAttachmentStagingWorkspace = \(error: unknown\) => \{[\s\S]*error instanceof VesloServerError[\s\S]*error\.status === 404[\s\S]*message\.includes\("workspace"\) && message\.includes\("not"\)/s,
    "missing workspace errors should be classified as one-shot recovery candidates",
  );
  assert.match(
    stagingSource,
    /let ready: AttachmentStagingWorkspaceReady = resolution\?\.serverWorkspaceId[\s\S]*ensureWorkspaceReadyForAttachmentStaging\(client\)/s,
    "preflight server workspace resolution should be preserved before using the fallback resolver",
  );
  assert.match(
    stagingSource,
    /catch \(error\) \{[\s\S]*shouldRecoverAttachmentStagingWorkspace\(error\)[\s\S]*ready = await recoverWorkspaceReadyForAttachmentStaging\(ready\.client\);[\s\S]*ready\.client\.createFileSession\(ready\.workspaceId,/s,
    "file-session creation should retry once after refreshing the local workspace/server state",
  );

  const promptAsyncIndex = source.indexOf('kind: "prompt_async"');
  assert.notEqual(promptAsyncIndex, -1, "prompt_async conversation handoff should exist");
  assert.ok(
    stagingStart < promptAsyncIndex,
    "attachments must be staged after session materialization but before the conversation prompt starts",
  );
});
