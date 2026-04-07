import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("composer keeps dropped files as attachment chips and does not inject path text on drop", () => {
  assert.doesNotMatch(
    composerSource,
    /insertPlainTextAtCursorOrEnd\(/,
    "composer should not inject staged paths into editor text",
  );

  assert.match(
    composerSource,
    /setAttachments\(\(current: ComposerAttachment\[\]\) => \[\.\.\.current, \.\.\.next\]\);/,
    "composer should keep dropped files as attachment chips",
  );
});

test("all attachment staging happens in session-directory send pipeline, not in composer", () => {
  assert.match(
    appSource,
    /const stageAttachmentsIntoSessionDirectory = async \(draft: ComposerDraft, sessionID: string\): Promise<ComposerDraft> =>/,
    "app send pipeline should stage attachments into the active session directory",
  );

  assert.match(
    appSource,
    /const attachmentsToStage = draft\.attachments;/,
    "staging should process every composer attachment",
  );

  assert.doesNotMatch(
    appSource,
    /uploadInbox\(/,
    "composer send flow should not stage attachments through inbox uploads",
  );

  assert.match(
    appSource,
    /await client\.createFileSession\(workspaceId, \{[\s\S]*write: true,/,
    "staging should open a writable file session",
  );

  assert.match(
    appSource,
    /await client\.readFileBatch\([^,]+, \[candidatePath\]\)/,
    "staging should probe for filename collisions in the session directory",
  );

  assert.match(
    appSource,
    /await client\.writeFileBatch\([^,]+, \[/,
    "staging should write attachments into the session directory",
  );

  assert.match(
    appSource,
    /resolvedText: nextResolvedText,/,
    "send pipeline should append staged paths to resolved text",
  );

  assert.match(
    appSource,
    /attachments: \[\],/,
    "after staging, inline attachment blobs should be removed from outbound provider parts",
  );

  assert.match(
    appSource,
    /const stagedDraft = await stageAttachmentsIntoSessionDirectory\(resolvedDraft, sessionID\);/,
    "send pipeline should normalize draft after session selection and before provider calls",
  );
});
