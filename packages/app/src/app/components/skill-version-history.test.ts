import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const sourceUrl = new URL("./skill-version-history.tsx", import.meta.url);
const source = existsSync(sourceUrl) ? readFileSync(sourceUrl, "utf8") : "";

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
  assert.match(source, /formatSkillPackageHash\(version\.packageHash\)/);
  assert.match(source, /aria-label=\{`Restore \$/);
  assert.match(source, /onClick=\{\(\) => props\.onRestoreVersion\?\.\(version\)\}/);
});
