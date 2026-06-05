import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("attachment staging validates the active workspace before opening a file session", () => {
  const resolverStart = source.indexOf("const resolveWorkspaceIdForAttachmentStaging = async (");
  const resolverEnd = source.indexOf("  const stageAttachmentsIntoSessionDirectory = async (", resolverStart);
  assert.notEqual(resolverStart, -1, "workspace resolver should exist");
  assert.ok(resolverEnd > resolverStart, "workspace resolver should end before staging");
  const resolverSource = source.slice(resolverStart, resolverEnd);

  assert.doesNotMatch(
    resolverSource,
    /if \(workspaceId\) return workspaceId;/,
    "attachment staging must not trust a cached Veslo workspace id without checking the active server workspace list",
  );

  assert.match(
    resolverSource,
    /const response = await client\.listWorkspaces\(\);[\s\S]*findByPath\(workspaceStore\.activeWorkspaceRoot\(\)\.trim\(\)\)/s,
    "attachment staging should resolve the workspace against the current server list and active local root",
  );
});

test("attachment staging self-heals a missing server workspace once before failing", () => {
  const stagingStart = source.indexOf("const stageAttachmentsIntoSessionDirectory = async (");
  const stagingEnd = source.indexOf("  const buildPromptParts = (draft: ComposerDraft): PartInput[] =>", stagingStart);
  assert.notEqual(stagingStart, -1, "staging function should exist");
  assert.ok(stagingEnd > stagingStart, "staging function should end before prompt building");
  const stagingSource = source.slice(stagingStart, stagingEnd);

  assert.match(
    stagingSource,
    /let ready = await ensureWorkspaceReadyForAttachmentStaging\(client\);/,
    "staging should check that the active workspace is visible to Veslo server before writing attachments",
  );

  assert.match(
    stagingSource,
    /catch \(error\) \{[\s\S]*shouldRecoverAttachmentStagingWorkspace\(error\)[\s\S]*ready = await recoverWorkspaceReadyForAttachmentStaging\(ready\.client\);[\s\S]*fileSession = await ready\.client\.createFileSession\(ready\.workspaceId,/s,
    "staging should retry file-session creation once after refreshing the local workspace/server state",
  );

  const promptAsyncIndex = source.indexOf("const result = await c.session.promptAsync({");
  assert.notEqual(promptAsyncIndex, -1, "promptAsync call should exist");
  assert.ok(
    stagingStart < promptAsyncIndex,
    "attachments must be staged after session materialization but before the provider prompt starts",
  );
});
