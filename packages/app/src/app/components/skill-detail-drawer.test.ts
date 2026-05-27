import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const sourceUrl = new URL("./skill-detail-drawer.tsx", import.meta.url);
const source = existsSync(sourceUrl) ? readFileSync(sourceUrl, "utf8") : "";
const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");

test("skill detail drawer exports tab and data contracts", () => {
  assert.match(source, /export type SkillDetailTab = "overview" \| "locations" \| "versions" \| "sharing" \| "audit"/);
  assert.match(source, /export const SKILL_DETAIL_TABS = \[/);
  assert.match(source, /export type SkillDetailMetadata = \{/);
  assert.match(source, /export type SkillDetailLocation = \{/);
  assert.match(source, /export type SkillAuditEntry = \{/);
  assert.match(source, /export type SkillDetailDrawerProps = \{/);
});

test("skill detail drawer props support required operational callbacks", () => {
  assert.match(source, /onClose: \(\) => void/);
  assert.match(source, /actionUnavailableReason\?: Partial<Record<SkillDetailAction, string \| null \| undefined>>/);
  assert.match(source, /onCopySkill\?: \(input: SkillDetailActionInput\) => void/);
  assert.match(source, /onMoveSkill\?: \(input: SkillDetailActionInput\) => void/);
  assert.match(source, /onPublishSkill\?: \(input: SkillDetailActionInput\) => void/);
  assert.match(source, /onRequestApproval\?: \(input: SkillDetailActionInput\) => void/);
  assert.match(source, /onRestoreVersion\?: \(version: SkillVersionRow\) => void/);
  assert.match(source, /onDeleteSkill\?: \(input: SkillDetailActionInput\) => void/);
});

test("skill detail drawer exposes accessible dialog semantics and close control", () => {
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby=\{titleId\}/);
  assert.match(source, /aria-label=\{translate\("skills\.detail_close"\)\}/);
  assert.match(source, /onClick=\{props\.onClose\}/);
});

test("skill detail drawer closes from backdrop clicks and leaves titlebar clearance", () => {
  assert.match(source, /data-testid="skill-detail-drawer-backdrop"/);
  assert.match(source, /const closeFromBackdrop = \(event: MouseEvent & \{ currentTarget: HTMLDivElement; target: Element \}\) =>/);
  assert.match(source, /if \(event\.target === event\.currentTarget\) props\.onClose\(\)/);
  assert.match(source, /onClick=\{closeFromBackdrop\}/);
  assert.match(source, /class="border-b border-dls-border px-4 pb-3 pt-10"/);
});

test("skill detail drawer renders all requested tabs without wiring into the skills page", () => {
  for (const key of [
    "skills.detail_tab_overview",
    "skills.detail_tab_locations",
    "skills.detail_tab_versions",
    "skills.detail_tab_sharing",
    "skills.detail_tab_audit",
  ]) {
    assert.match(source, new RegExp(`labelKey: "${key}"`));
    assert.match(enSource, new RegExp(`"${key}":`));
    assert.match(csSource, new RegExp(`"${key}":`));
    assert.match(zhSource, new RegExp(`"${key}":`));
  }
  assert.equal(source.includes("skills.tsx"), false);
});

test("skill detail drawer localizes all visible static copy", () => {
  assert.match(source, /import \{ currentLocale, t \} from "\.\.\/\.\.\/i18n"/);
  assert.match(source, /const translate = \(key: string\) => t\(key, currentLocale\(\)\)/);
  for (const key of [
    "skills.detail_type",
    "skills.detail_overview",
    "skills.detail_description",
    "skills.detail_trigger",
    "skills.detail_status",
    "skills.detail_package_hash",
    "skills.detail_not_set",
    "skills.detail_copy_to_global",
    "skills.detail_move_to_global",
    "skills.detail_publish_organization",
    "skills.detail_request_system_approval",
    "skills.detail_delete",
    "skills.detail_locations",
    "skills.detail_no_locations",
    "skills.detail_sharing",
    "skills.detail_publisher",
    "skills.detail_approval",
    "skills.detail_audit",
    "skills.detail_no_audit_entries",
  ]) {
    assert.match(source, new RegExp(`translate\\("${key}"\\)`));
    assert.match(enSource, new RegExp(`"${key}":`));
    assert.match(csSource, new RegExp(`"${key}":`));
    assert.match(zhSource, new RegExp(`"${key}":`));
  }
  assert.doesNotMatch(source, />Skill</);
  assert.doesNotMatch(source, />Description</);
  assert.doesNotMatch(source, />Request approval</);
});

test("skill detail drawer disables unavailable local transfer actions with explicit reasons", () => {
  assert.match(source, /const actionUnavailableReason = \(action: SkillDetailAction\) =>/);
  assert.match(source, /const actionDisabled = \(action: SkillDetailAction, enabled: unknown\) =>/);
  assert.match(source, /disabled=\{actionDisabled\("copy", props\.onCopySkill\)\}/);
  assert.match(source, /title=\{actionTitle\("copy", "skills\.detail_copy_to_global"\)\}/);
  assert.match(source, /disabled=\{actionDisabled\("move", props\.onMoveSkill\)\}/);
  assert.match(source, /title=\{actionTitle\("move", "skills\.detail_move_to_global"\)\}/);
  assert.match(source, /location\.actionUnavailableReason\?\.copy/);
  assert.match(source, /location\.actionUnavailableReason\?\.move/);
});

test("skill detail drawer delegates version restore and target selection to skill version history", () => {
  assert.match(source, /import SkillVersionHistory/);
  assert.match(source, /versions=\{props\.versions \?\? \[\]\}/);
  assert.match(source, /selectedVersionId=\{props\.selectedVersionId\}/);
  assert.match(source, /selectedTargetId=\{props\.selectedVersionTargetId\}/);
  assert.match(source, /onRestoreVersion=\{props\.onRestoreVersion\}/);
  assert.match(source, /onSelectTarget=\{props\.onSelectVersionTarget\}/);
});
