import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");

test("composer stages docx files via inbox callback instead of client-side parsing", () => {
  assert.match(
    composerSource,
    /stageAttachmentToInbox\?: \(file: File\) => Promise<string \| null>/,
    "composer should expose inbox staging callback for routed document attachments",
  );

  assert.match(
    composerSource,
    /const stagedPath = await props\.stageAttachmentToInbox\(file\);/,
    "composer should stage docx files to workspace inbox",
  );

  assert.match(
    composerSource,
    /insertPlainTextAtCursorOrEnd\(stagedPath\);/,
    "composer should insert staged docx workspace path into prompt text",
  );

  assert.doesNotMatch(
    composerSource,
    /maybeConvertDocxToTextAttachment/,
    "composer must not parse docx content on the client",
  );
});

test("session view wires inbox staging into composer", () => {
  assert.match(
    sessionSource,
    /stageAttachmentToInbox=\{stageAttachmentToInbox\}/,
    "session should provide docx inbox staging callback to composer",
  );

  assert.match(
    sessionSource,
    /const stageAttachmentToInbox = async \(file: File\): Promise<string \| null> =>/,
    "session should implement inbox staging callback",
  );
});
