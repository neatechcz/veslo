import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./skills.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");

test("skills page removes worker profile and mode stat cards", () => {
  assert.equal(source.includes('translate("skills.worker_profile")'), false);
  assert.equal(source.includes('translate("skills.stat_skill_creator")'), false);
  assert.equal(source.includes('translate("skills.stat_mode")'), false);
});

test("skills page keeps create skill in chat CTA", () => {
  assert.match(source, /translate\("skills\.create_in_chat"\)/);
});

test("skills page removes legacy new skill toolbar action", () => {
  assert.equal(source.includes('translate("skills.new_skill")'), false);
});

test("skills page install section uses org catalog placeholder text", () => {
  assert.match(source, /translate\("skills\.org_catalog_placeholder"\)/);
});

test("skills page receives app-wide skill inventory props", () => {
  assert.match(source, /skillInventory:\s*SkillInventoryItem\[\]/);
  assert.match(source, /refreshSkillInventory:\s*\(options\?: \{ force\?: boolean \}\) => void/);
  assert.match(dashboardSource, /skillInventory:\s*SkillInventoryItem\[\]/);
  assert.match(dashboardSource, /refreshSkillInventory:\s*\(options\?: \{ force\?: boolean \}\) => void/);
  assert.match(appSource, /\bskillInventory,\s*[\s\S]*\bskillInventoryStatus,\s*[\s\S]*\brefreshSkillInventory,/);
  assert.match(dashboardSource, /skillInventory=\{props\.skillInventory\}/);
  assert.match(dashboardSource, /refreshSkillInventory=\{props\.refreshSkillInventory\}/);
});

test("skills page uses inventory as primary installed source", () => {
  assert.match(source, /const installedInventoryItems = createMemo\(\(\) =>\s*props\.skillInventory/);
  assert.match(source, /const installedSkillCount = createMemo\(\(\) => installedInventoryItems\(\)\.length\)/);
  assert.match(source, /translate\("skills\.stat_installed"\)[\s\S]*\{installedSkillCount\(\)\}/);
  assert.doesNotMatch(source, /translate\("skills\.stat_installed"\)[\s\S]{0,500}\{props\.skills\.length\}/);
});

test("skills page separates global and workspace-specific inventory sections", () => {
  assert.match(source, /translate\("skills\.all_workspaces"\)/);
  assert.match(source, /translate\("skills\.workspace_specific"\)/);
  assert.match(source, /translate\("skills\.workspace_overrides"\)/);
  assert.match(enSource, /"skills\.all_workspaces":\s*"All workspaces"/);
  assert.match(enSource, /"skills\.workspace_specific":\s*"Workspace-specific"/);
  assert.match(enSource, /"skills\.workspace_overrides":\s*"Workspace overrides"/);
  assert.match(csSource, /"skills\.all_workspaces":/);
  assert.match(csSource, /"skills\.workspace_specific":/);
  assert.match(csSource, /"skills\.workspace_overrides":/);
  assert.match(zhSource, /"skills\.all_workspaces":/);
  assert.match(zhSource, /"skills\.workspace_specific":/);
  assert.match(zhSource, /"skills\.workspace_overrides":/);
});

test("workspace-specific rows come from workspaceInstances without expanding globals across workspaces", () => {
  assert.match(source, /const workspaceInventoryRows = createMemo\(\(\) =>\s*filteredInstalledInventoryItems\(\)\s*\.flatMap/);
  assert.match(source, /item\.workspaceInstances\.map/);
  assert.match(source, /item\.status === "mixed"\s*\?\s*translate\("skills\.workspace_overrides"\)/);
  assert.doesNotMatch(source, /props\.workspaces\.map\([\s\S]{0,500}globalInstance/);
});

test("local skill import refreshes the app-wide installed inventory", () => {
  assert.match(source, /const importLocalSkillAndRefreshInventory = \(\) =>\s*Promise\.resolve\(props\.importLocalSkill\(\)\)\s*\.finally\(\(\) => props\.refreshSkillInventory\(\{ force: true \}\)\)/);
  assert.match(source, /id: "import-local"[\s\S]*onClick: importLocalSkillAndRefreshInventory/);
  assert.doesNotMatch(source, /id: "import-local"[\s\S]{0,300}onClick: props\.importLocalSkill/);
});

test("ambiguous inventory uninstalls are guarded to active workspace-only rows", () => {
  assert.match(source, /activeWorkspaceId: string/);
  assert.match(source, /const canUninstallInventoryInstance = \(input: \{ item: SkillInventoryItem; instance: SkillInstance \}\) =>/);
  assert.match(source, /if \(input\.item\.globalInstance\) return false/);
  assert.match(source, /input\.item\.status === "workspace-only"/);
  assert.match(source, /input\.instance\.workspaceId === props\.activeWorkspaceId/);
  assert.match(source, /const uninstallDisabledReason = \(input: \{ item: SkillInventoryItem; instance: SkillInstance \}\)/);
  assert.match(source, /aria-label=\{uninstallTitle\(\)\}/);
  assert.match(source, /disabled=\{props\.busy \|\| !canUninstall\(\)\}/);
});

test("active remote workspace skills fall back into the workspace-specific inventory section", () => {
  assert.match(source, /isRemoteWorkspace: boolean/);
  assert.match(source, /const inventoryHasActiveWorkspaceRows = createMemo\(\(\) =>/);
  assert.match(source, /item\.workspaceInstances\.some\(\(instance\) => instance\.workspaceId === props\.activeWorkspaceId\)/);
  assert.match(source, /const activeRemoteInventoryItems = createMemo<SkillInventoryItem\[\]>\(\(\) =>/);
  assert.match(source, /if \(!props\.isRemoteWorkspace \|\| inventoryHasActiveWorkspaceRows\(\)\) return \[\]/);
  assert.match(source, /props\.skills\.map\(\(skill\) => \(/);
  assert.match(source, /status: "workspace-only"/);
  assert.match(source, /workspaceLabel: props\.workspaceName/);
});

test("skills page does not duplicate org catalog placeholder when hub status is shown", () => {
  assert.match(
    source,
    /fallback=\{\s*<Show when=\{!props\.hubSkillsStatus\}>[\s\S]*translate\("skills\.org_catalog_placeholder"\)/,
  );
});

test("skills toast messages stay visible for at least four seconds", () => {
  assert.match(
    source,
    /const SKILLS_TOAST_DISMISS_DELAY_MS = 4_000;/,
    "skills toast dismiss delay should be defined as at least four seconds",
  );
  assert.match(
    source,
    /window\.setTimeout\(\(\) => setToast\(null\), SKILLS_TOAST_DISMISS_DELAY_MS\)/,
    "skills toasts should use the four-second dismiss delay",
  );
  assert.equal(source.includes("setToast(null), 2400"), false);
});

test("settings overview remains present in dashboard", () => {
  assert.match(dashboardSource, /<SettingsView/);
  assert.match(dashboardSource, /<Match when=\{props\.tab === "settings"\}>/);
});
