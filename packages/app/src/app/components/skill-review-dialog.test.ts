import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const sourceUrl = new URL("./skill-review-dialog.tsx", import.meta.url);
const source = existsSync(sourceUrl) ? readFileSync(sourceUrl, "utf8") : "";

test("skill review dialog exports scope, mode, diff, and action contracts", () => {
  assert.match(source, /export type SkillReviewTargetScope = "organization" \| "system"/);
  assert.match(source, /export type SkillReviewMode = "request" \| "review"/);
  assert.match(source, /export type SkillReviewDecision = "approve" \| "reject"/);
  assert.match(source, /export type SkillReviewMetadataDiff = \{/);
  assert.match(source, /export type SkillReviewFileDiff = \{/);
  assert.match(source, /export type SkillReviewActionInput = \{/);
  assert.match(source, /export type SkillReviewDialogProps = \{/);
});

test("skill review dialog props support org/system request and approval callbacks", () => {
  assert.match(source, /targetScope: SkillReviewTargetScope/);
  assert.match(source, /mode: SkillReviewMode/);
  assert.match(source, /onRequestOrganizationPublish\?: \(input: SkillReviewActionInput\) => void/);
  assert.match(source, /onRequestSystemApproval\?: \(input: SkillReviewActionInput\) => void/);
  assert.match(source, /onApproveOrganizationVersion\?: \(input: SkillReviewActionInput\) => void/);
  assert.match(source, /onRejectOrganizationVersion\?: \(input: SkillReviewActionInput\) => void/);
  assert.match(source, /onApproveSystemVersion\?: \(input: SkillReviewActionInput\) => void/);
  assert.match(source, /onRejectSystemVersion\?: \(input: SkillReviewActionInput\) => void/);
});

test("skill review dialog renders required review evidence", () => {
  for (const label of [
    "Metadata diff",
    "File tree diff",
    "Executable and script warnings",
    "Target scope",
    "Changelog / reason",
  ]) {
    assert.match(source, new RegExp(label));
  }

  assert.match(source, /props\.metadataDiff/);
  assert.match(source, /props\.fileDiffs/);
  assert.match(source, /executableWarnings/);
  assert.match(source, /<textarea/);
});

test("skill review dialog identifies non-Markdown files and executable scripts", () => {
  assert.match(source, /isMarkdownFile\(/);
  assert.match(source, /isScriptFile\(/);
  assert.match(source, /Non-Markdown/);
  assert.match(source, /Executable/);
  assert.match(source, /Script path/);
});

test("skill review dialog uses operational button actions for request and review states", () => {
  assert.match(source, /Request organization publish/);
  assert.match(source, /Request system approval/);
  assert.match(source, /Approve organization version/);
  assert.match(source, /Reject organization version/);
  assert.match(source, /Approve system version/);
  assert.match(source, /Reject system version/);
  assert.match(source, /variant="danger"/);
});
