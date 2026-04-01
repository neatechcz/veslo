import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("composer keeps dropped files as attachment chips and does not inject path text on drop", () => {
  assert.doesNotMatch(
    composerSource,
    /insertPlainTextAtCursorOrEnd\(/,
    "composer should not inject staged docx paths into editor text",
  );

  assert.match(
    composerSource,
    /setAttachments\(\(current: ComposerAttachment\[\]\) => \[\.\.\.current, \.\.\.next\]\);/,
    "composer should keep dropped files as attachment chips",
  );
});

test("all attachment staging happens in send pipeline, not in composer", () => {
  assert.match(
    appSource,
    /const stageAttachmentsForDelegation = async \(draft: ComposerDraft\): Promise<ComposerDraft> =>/,
    "app send pipeline should stage all attachments for delegation",
  );

  assert.match(
    appSource,
    /const attachmentsToStage = draft\.attachments;/,
    "staging should process every composer attachment, not only specific MIME types",
  );

  assert.doesNotMatch(
    appSource,
    /isWordAttachment\(/,
    "send pipeline should not use Word-only attachment filters",
  );

  assert.match(
    appSource,
    /await client\.uploadInbox\(workspaceId, file\)/,
    "attachment staging should upload to workspace inbox",
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
    /const stagedDraft = await stageAttachmentsForDelegation\(resolvedDraft\);/,
    "send pipeline should normalize draft before building prompt parts",
  );
});
