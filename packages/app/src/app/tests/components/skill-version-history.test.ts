import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const sourceUrl = new URL("../../components/skill-version-history.tsx", import.meta.url);
const source = existsSync(sourceUrl) ? readFileSync(sourceUrl, "utf8") : "";
const enSource = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../../i18n/locales/zh.ts", import.meta.url), "utf8");

test("skill version history exports the row, status, target, and props contracts", () => {
  assert.match(source, /export type SkillVersionApprovalStatus = "approved" \| "pending" \| "rejected"/);
  assert.match(source, /export type SkillVersionTargetScope = "global" \| "workspace" \| "organization"/);
  assert.match(source, /export type SkillVersionTargetMetadata = \{/);
  assert.match(source, /export type SkillVersionRow = \{/);
  assert.match(source, /packageHash\?: string \| null/);
  assert.match(source, /target\?: SkillVersionTargetMetadata \| null/);
  assert.match(source, /export type SkillVersionHistoryProps = \{/);
});

test("skill version history exposes model helpers for selection and hash display", () => {
  assert.match(source, /export const SKILL_VERSION_APPROVAL_STATUSES = \[/);
  assert.match(source, /export function getSelectedSkillVersion\(/);
  assert.match(source, /export function canRestoreSkillVersion\(/);
  assert.match(source, /export function formatSkillPackageHash\(/);
  assert.match(source, /export function getSkillVersionTargetLabel\(/);
});

test("skill version history props support selected version, restore, and target selection callbacks", () => {
  assert.match(source, /selectedVersionId\?: string \| null/);
  assert.match(source, /selectedTargetId\?: string \| null/);
  assert.match(source, /onSelectVersion\?: \(version: SkillVersionRow\) => void/);
  assert.match(source, /onRestoreVersion\?: \(version: SkillVersionRow\) => void/);
  assert.match(source, /onSelectTarget\?: \(target: SkillVersionTargetMetadata\) => void/);
});

test("skill version history renders approved, pending, rejected, package hash, and restore affordances", () => {
  assert.match(source, /case "approved"/);
  assert.match(source, /case "pending"/);
  assert.match(source, /case "rejected"/);
  assert.match(source, /formatSkillPackageHash\(version\.packageHash, translate\("skills\.detail_no_hash"\)\)/);
  assert.match(source, /aria-label=\{translate\("skills\.detail_restore_version", \{ version: version\.version \}\)\}/);
  assert.match(source, /onClick=\{\(\) => props\.onRestoreVersion\?\.\(version\)\}/);
});

test("skill version history localizes visible static copy inside the detail drawer", () => {
  assert.match(source, /import \{ currentLocale, t \} from "\.\.\/\.\.\/i18n"/);
  assert.match(source, /const translate = \(key: string, replacements\?: Record<string, string>\) =>/);
  for (const key of [
    "skills.detail_target",
    "skills.detail_version_target",
    "skills.detail_no_versions",
    "skills.detail_versions",
    "skills.detail_current",
    "skills.detail_by_author",
    "skills.detail_restore",
    "skills.detail_restore_version",
    "skills.detail_package_hash",
    "skills.detail_no_hash",
    "skills.detail_no_target",
    "skills.detail_scope_global",
    "skills.detail_scope_workspace",
    "skills.detail_scope_organization",
    "skills.detail_status_approved",
    "skills.detail_status_pending",
    "skills.detail_status_rejected",
  ]) {
    assert.match(source, new RegExp(`translate\\("${key}"`));
    assert.match(enSource, new RegExp(`"${key}":`));
    assert.match(csSource, new RegExp(`"${key}":`));
    assert.match(zhSource, new RegExp(`"${key}":`));
  }
  assert.doesNotMatch(source, />Target</);
  assert.doesNotMatch(source, />Current</);
  assert.doesNotMatch(source, />Restore</);
});
