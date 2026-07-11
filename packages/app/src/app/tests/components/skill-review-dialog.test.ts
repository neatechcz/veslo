import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const sourceUrl = new URL("../../components/skill-review-dialog.tsx", import.meta.url);
const source = existsSync(sourceUrl) ? readFileSync(sourceUrl, "utf8") : "";
const enSource = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../../i18n/locales/zh.ts", import.meta.url), "utf8");

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
    "skills.review_close",
    "skills.review_warnings",
    "skills.review_request_title",
    "skills.review_request_mode_label",
    "skills.review_review_mode_label",
    "skills.review_summary_skill",
    "skills.review_summary_version",
    "skills.review_summary_target",
    "skills.review_summary_approver",
    "skills.review_approver_organization",
    "skills.review_approver_system",
    "skills.review_service_unavailable_title",
    "skills.review_service_unavailable_body",
    "skills.review_what_will_be_submitted",
    "skills.review_valid_package",
    "skills.review_submitted_data_description",
    "skills.review_field_files",
    "skills.review_field_visibility",
    "skills.review_visibility_organization",
    "skills.review_visibility_system",
    "skills.review_changes_title",
    "skills.review_changes_metadata",
    "skills.review_changes_local_runtime",
    "skills.review_changes_reviewer_diff",
    "skills.review_catalog_target_title",
    "skills.review_approval_flow_title",
    "skills.review_approval_flow_create_request",
    "skills.review_approval_flow_reviewer_checks",
    "skills.review_approval_flow_approved_catalog",
    "skills.review_approval_flow_rejected_reason",
    "skills.review_preconditions_title",
    "skills.review_precondition_metadata",
    "skills.review_precondition_skill_file",
    "skills.review_precondition_name_conflicts",
    "skills.review_precondition_service_unavailable",
    "skills.review_reviewer_note",
    "skills.review_save_draft",
    "skills.review_footer_unavailable",
    "skills.review_request_intro",
    "skills.review_non_markdown",
    "skills.review_executable",
    "skills.review_script_path",
    "skills.review_scope_system",
    "skills.review_cancel",
    "skills.review_request_organization_publish",
    "skills.review_request_system_approval",
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

test("skill review dialog matches the Pencil publish proposal layout", () => {
  assert.match(source, /size="none"/);
  assert.match(source, /align="center"/);
  assert.match(source, /max-w-\[1080px\]/);
  assert.match(source, /max-h-\[calc\(100vh-2rem\)\]/);
  assert.match(source, /rounded-\[10px\] bg-gray-1/);
  assert.match(source, /class="flex h-full min-h-0 flex-col"/);
  assert.match(source, /class="shrink-0 px-7 pb-6 pt-6"/);
  assert.match(source, /<footer class="shrink-0 flex flex-wrap items-center gap-3 border-t border-dls-border px-7 py-4">/);
  assert.match(source, /translate\("skills\.review_request_title"\)/);
  assert.match(source, /translate\("skills\.review_summary_skill"\)/);
  assert.match(source, /translate\("skills\.review_summary_approver"\)/);
  assert.match(source, /requestServiceUnavailable/);
  assert.match(source, /translate\("skills\.review_service_unavailable_title"\)/);
  assert.match(source, /translate\("skills\.review_what_will_be_submitted"\)/);
  assert.match(source, /translate\("skills\.review_catalog_target_title"\)/);
  assert.match(source, /translate\("skills\.review_approval_flow_title"\)/);
  assert.match(source, /translate\("skills\.review_preconditions_title"\)/);
  assert.match(source, /translate\("skills\.review_reviewer_note"\)/);
  assert.match(source, /translate\("skills\.review_footer_unavailable"\)/);
  assert.match(source, /translate\("skills\.review_field_files"\)/);
  assert.match(source, /translate\("skills\.review_field_visibility"\)/);
  assert.match(source, /submittedRows/);
  assert.match(source, /fileSummary/);
  assert.match(source, /xl:grid-cols-\[minmax\(0,1fr\)_360px\]/);
  assert.match(source, /<div class="min-w-0 space-y-\[14px\]">/);
  assert.match(source, /<aside class="min-w-0 space-y-\[14px\]">/);
  assert.match(source, /translate\("skills\.review_request_intro"\)/);
  assert.match(source, /bg-gray-1 text-dls-text shadow-\[0_1px_2px_rgba\(15,23,42,0\.08\)\]/);
  assert.match(source, /sm:grid-cols-4/);
  assert.match(source, /border-amber-7 bg-amber-2/);
  assert.doesNotMatch(source, /max-w-none/);
  assert.doesNotMatch(source, /class="h-\[calc\(100vh-2rem\)\]/);
  assert.doesNotMatch(source, /align="start"/);
  assert.doesNotMatch(source, /translate\("skills\.review_previous_value"\)/);
  assert.doesNotMatch(source, /translate\("skills\.review_current_value"\)/);
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
  assert.match(source, /<Button variant="danger"[^>]*disabled=\{rejectDisabled\(\)\}/);
  assert.match(source, /<Button variant="primary"[^>]*disabled=\{approveDisabled\(\)\}/);
  assert.match(source, /onSaveDraft\?: \(input: SkillReviewActionInput\) => void/);
  assert.match(source, /props\.onSaveDraft\?\.\(actionInput\(\)\)/);
  assert.match(source, /translate\("skills\.review_save_draft"\)/);
  assert.match(source, /disabled=\{requestDisabled\(\)\}/);
});
