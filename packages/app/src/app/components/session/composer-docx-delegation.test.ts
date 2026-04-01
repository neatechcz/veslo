import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

test("composer keeps docx as attachment chips and does not inject path text on drop", () => {
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

test("docx staging happens in send pipeline, not in composer", () => {
  assert.match(
    appSource,
    /const stageDocxAttachmentsForDelegation = async \(draft: ComposerDraft\): Promise<ComposerDraft> =>/,
    "app send pipeline should stage docx attachments for delegation",
  );

  assert.match(
    appSource,
    /await client\.uploadInbox\(workspaceId, file\)/,
    "docx staging should upload to workspace inbox",
  );

  assert.match(
    appSource,
    /resolvedText: nextResolvedText,/,
    "send pipeline should append staged docx paths to resolved text",
  );

  assert.match(
    appSource,
    /const stagedDraft = await stageDocxAttachmentsForDelegation\(resolvedDraft\);/,
    "send pipeline should normalize draft before building prompt parts",
  );
});
