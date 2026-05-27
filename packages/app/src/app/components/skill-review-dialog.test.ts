import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const sourceUrl = new URL("./skill-review-dialog.tsx", import.meta.url);
const source = existsSync(sourceUrl) ? readFileSync(sourceUrl, "utf8") : "";
const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");

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

test("skill review dialog localizes all visible static copy", () => {
  assert.match(source, /import \{ currentLocale, t \} from "\.\.\/\.\.\/i18n"/);
  assert.match(source, /const translate = \(key: string\) => t\(key, currentLocale\(\)\)/);
  for (const key of [
    "skills.review_publish_request",
    "skills.review_approval_review",
    "skills.review_close",
    "skills.review_metadata_diff",
    "skills.review_file_tree_diff",
    "skills.review_warnings",
    "skills.review_target_scope",
    "skills.review_changelog_reason",
    "skills.review_request_intro",
    "skills.review_no_metadata_changes",
    "skills.review_no_file_changes",
    "skills.review_no_warnings",
    "skills.review_non_markdown",
    "skills.review_executable",
    "skills.review_script_path",
    "skills.review_scope",
    "skills.review_target",
    "skills.review_cancel",
    "skills.review_request_organization_publish",
    "skills.review_request_system_approval",
    "skills.review_previous_value",
    "skills.review_current_value",
    "skills.review_approve_organization_version",
    "skills.review_reject_organization_version",
    "skills.review_approve_system_version",
    "skills.review_reject_system_version",
    "skills.review_field_not_set",
  ]) {
    assert.match(source, new RegExp(`translate\\("${key}"\\)`));
    assert.match(enSource, new RegExp(`"${key}":`));
    assert.match(csSource, new RegExp(`"${key}":`));
    assert.match(zhSource, new RegExp(`"${key}":`));
  }
  assert.doesNotMatch(source, />Metadata diff</);
  assert.doesNotMatch(source, /"Request organization publish"/);
  assert.doesNotMatch(source, /"Request system approval"/);
});

test("skill review dialog renders required review evidence", () => {
  assert.match(source, /props\.metadataDiff/);
  assert.match(source, /props\.fileDiffs/);
  assert.match(source, /executableWarnings/);
  assert.match(source, /<textarea/);
});

test("skill review dialog uses a wider review layout with readable metadata rows", () => {
  assert.match(source, /class="max-w-6xl rounded-lg bg-gray-1"/);
  assert.match(source, /<div class="space-y-4">/);
  assert.match(source, /md:grid-cols-\[minmax\(0,1fr\)_220px\]/);
  assert.match(source, /xl:grid-cols-\[minmax\(560px,1fr\)_320px\]/);
  assert.match(source, /<div class="min-w-0 space-y-4">/);
  assert.match(source, /<aside class="min-w-0 space-y-4">/);
  assert.match(source, /translate\("skills\.review_request_intro"\)/);
  assert.match(source, /translate\("skills\.review_previous_value"\)/);
  assert.match(source, /translate\("skills\.review_current_value"\)/);
  assert.match(source, /border-blue-6 bg-blue-2/);
  assert.match(source, /sm:grid-cols-2/);
  assert.doesNotMatch(source, /sm:grid-cols-\[120px_minmax\(0,1fr\)\]/);
  assert.doesNotMatch(source, /md:grid-cols-2/);
});

test("skill review dialog identifies non-Markdown files and executable scripts", () => {
  assert.match(source, /isMarkdownFile\(/);
  assert.match(source, /isScriptFile\(/);
  assert.match(source, /nonMarkdown: translate\("skills\.review_non_markdown"\)/);
  assert.match(source, /executable: translate\("skills\.review_executable"\)/);
  assert.match(source, /scriptPath: translate\("skills\.review_script_path"\)/);
});

test("skill review dialog uses operational button actions for request and review states", () => {
  assert.match(source, /translate\("skills\.review_request_organization_publish"\)/);
  assert.match(source, /translate\("skills\.review_request_system_approval"\)/);
  assert.match(source, /translate\("skills\.review_approve_organization_version"\)/);
  assert.match(source, /translate\("skills\.review_reject_organization_version"\)/);
  assert.match(source, /translate\("skills\.review_approve_system_version"\)/);
  assert.match(source, /translate\("skills\.review_reject_system_version"\)/);
  assert.match(source, /variant="danger"/);
});
