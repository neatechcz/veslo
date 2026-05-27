import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const sourceUrl = new URL("./skill-detail-drawer.tsx", import.meta.url);
const source = existsSync(sourceUrl) ? readFileSync(sourceUrl, "utf8") : "";

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
  assert.match(source, /aria-label="Close skill details"/);
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
  for (const tab of ["Overview", "Locations", "Versions", "Sharing", "Audit"]) {
    assert.match(source, new RegExp(`label: "${tab}"`));
  }
  assert.equal(source.includes("skills.tsx"), false);
});

test("skill detail drawer delegates version restore and target selection to skill version history", () => {
  assert.match(source, /import SkillVersionHistory/);
  assert.match(source, /versions=\{props\.versions \?\? \[\]\}/);
  assert.match(source, /selectedVersionId=\{props\.selectedVersionId\}/);
  assert.match(source, /selectedTargetId=\{props\.selectedVersionTargetId\}/);
  assert.match(source, /onRestoreVersion=\{props\.onRestoreVersion\}/);
  assert.match(source, /onSelectTarget=\{props\.onSelectVersionTarget\}/);
});
