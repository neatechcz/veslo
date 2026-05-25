import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./skills.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const extensionsSource = readFileSync(new URL("../context/extensions.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");
const renderInventoryCardSource = source.slice(
  source.indexOf("const renderInventoryCard"),
  source.indexOf("\n  return (\n    <section", source.indexOf("const renderInventoryCard")),
);

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
  assert.match(source, /const installedInventoryItems = createMemo\(\(\) =>\s*mergeRemoteFallbackIntoInventory\(\s*props\.skillInventory/);
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

test("inventory card uninstall is unavailable until scoped uninstall exists", () => {
  assert.match(source, /activeWorkspaceId: string/);
  assert.match(source, /const canUninstallInventoryInstance = \(_input: \{ item: SkillInventoryItem; instance: SkillInstance \}\) => false/);
  assert.match(source, /const uninstallDisabledReason = \(_input: \{ item: SkillInventoryItem; instance: SkillInstance \}\) =>\s*translate\("skills\.uninstall_scoped_pending"\)/);
  assert.match(renderInventoryCardSource, /disabled=\{props\.busy \|\| !canUninstall\(\)\}/);
  assert.match(source, /aria-label=\{uninstallTitle\(\)\}/);
  assert.doesNotMatch(renderInventoryCardSource, /setUninstallTarget/);
});

test("install-from-link overwrite is gated by active workspace conflicts only", () => {
  assert.match(source, /const activeWorkspaceInstalledNames = createMemo\(\(\) =>\s*new Set\(\s*installedInventoryItems\(\)\s*\.flatMap\(\(item\) =>\s*item\.workspaceInstances\.some\(\(instance\) => instance\.workspaceId === props\.activeWorkspaceId\)\s*\? \[item\.name\]\s*: \[\]\s*\)\s*\)\s*\)/);
  assert.doesNotMatch(source, /const activeWorkspaceInstalledNames = createMemo\(\(\) =>\s*new Set\(props\.skills\.map/);
  assert.match(source, /const activeOrGlobalInstalledNames = createMemo\(\(\) =>\s*new Set\(\s*installedInventoryItems\(\)\s*\.flatMap\(\(item\) =>\s*item\.globalInstance \|\| item\.workspaceInstances\.some\(\(instance\) => instance\.workspaceId === props\.activeWorkspaceId\)\s*\? \[item\.name\]\s*: \[\]\s*\)\s*\)\s*\)/);
  assert.match(source, /const installedNames = createMemo\(\(\) => activeOrGlobalInstalledNames\(\)\)/);
  assert.doesNotMatch(source, /const installedNames = createMemo\(\(\) => installedInventoryNames\(\)\)/);
  assert.match(source, /const canOverwriteInstallLinkBundle = \(name: string\) => activeWorkspaceInstalledNames\(\)\.has\(name\.trim\(\)\)/);
  assert.match(source, /const installLinkShouldRename = \(name: string, mode: "overwrite" \| "keep-both"\) =>\s*mode === "keep-both" \|\| \(installedNames\(\)\.has\(name\.trim\(\)\) && !canOverwriteInstallLinkBundle\(name\)\)/);
  assert.match(source, /const shouldRename = installLinkShouldRename\(desiredName, mode\)/);
  assert.match(source, /const taken = installedNames\(\)/);
  assert.match(source, /props\.hubSkills\.filter\(\(skill\) => !installedNames\(\)\.has\(skill\.name\)\)/);
  assert.match(source, /const activeWorkspaceConflict = canOverwriteInstallLinkBundle\(bundle\(\)\.name\)/);
  assert.match(source, /const globalOnlyConflict = installedNames\(\)\.has\(bundle\(\)\.name\.trim\(\)\) && !activeWorkspaceConflict/);
  assert.match(source, /translate\("skills\.global_conflict_warning"\)/);
  assert.match(source, /when=\{activeWorkspaceConflict\}/);
  assert.match(enSource, /"skills\.global_conflict_warning":/);
  assert.match(csSource, /"skills\.global_conflict_warning":/);
  assert.match(zhSource, /"skills\.global_conflict_warning":/);
  assert.doesNotMatch(source, /const conflict = installedNames\(\)\.has\(bundle\.name\.trim\(\)\);[\s\S]{0,500}translate\("skills\.overwrite"\)/);
});

test("install-from-link keeps the modal open when saveSkill reports failure", () => {
  assert.match(source, /import type \{[\s\S]*SkillSaveResult[\s\S]*\} from "\.\.\/types"/);
  assert.match(source, /saveSkill: \(input: \{ name: string; content: string; description\?: string \}\) => Promise<SkillSaveResult>/);
  assert.match(dashboardSource, /saveSkill: \(input: \{ name: string; content: string; description\?: string \}\) => Promise<SkillSaveResult>/);
  assert.match(source, /const result = await Promise\.resolve\(\s*props\.saveSkill\(\{/);
  assert.match(source, /if \(!result\.ok\) \{\s*setInstallLinkError\(result\.message \?\? translate\("skills\.failed_save_skill"\)\);\s*return;\s*\}/);
  assert.match(source, /if \(!result\.ok\)[\s\S]{0,220}return;[\s\S]{0,220}props\.refreshSkills\(\{ force: true \}\);/);
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

test("active remote fallback rows merge into existing inventory items by name", () => {
  assert.match(source, /const mergeRemoteFallbackIntoInventory = \(\s*inventoryItems: SkillInventoryItem\[\],\s*fallbackItems: SkillInventoryItem\[\],\s*\) =>/);
  assert.match(source, /\[\.\.\.inventoryItems, \.\.\.fallbackItems\]\.reduce<SkillInventoryItem\[\]>\(/);
  assert.match(source, /const existing = items\.find\(\(item\) => item\.name === next\.name\)/);
  assert.match(source, /workspaceInstances: \[\.\.\.existing\.workspaceInstances, \.\.\.next\.workspaceInstances\]/);
  assert.match(source, /globalInstance: mergedGlobalInstance/);
  assert.match(source, /hubItem: existing\.hubItem \?\? next\.hubItem/);
  assert.match(source, /status: mergedGlobalInstance \? "mixed" : "workspace-only"/);
  assert.doesNotMatch(source, /\.concat\(activeRemoteInventoryItems\(\)\)/);
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

test("skills inventory exposes stable desktop e2e selectors", () => {
  assert.match(source, /data-testid="skills-page"/);
  assert.match(renderInventoryCardSource, /data-testid="skill-inventory-card"/);
  assert.match(renderInventoryCardSource, /data-skill-inventory-name=\{input\.item\.name\}/);
  assert.match(renderInventoryCardSource, /data-skill-inventory-scope=\{input\.instance\.scope\}/);
  assert.match(renderInventoryCardSource, /data-skill-inventory-workspace-id=\{input\.instance\.workspaceId \?\? ""\}/);
  assert.match(source, /data-testid="skills-all-workspaces-section"/);
  assert.match(source, /data-testid="skills-workspace-specific-section"/);
  assert.match(source, /data-testid="skills-hub-section"/);
  assert.match(source, /data-testid="skills-hub-placeholder"/);
});

test("hub skill install requires an explicit target selection", () => {
  assert.match(source, /import type \{[\s\S]*HubSkillInstallTarget[\s\S]*\} from "\.\.\/types"/);
  assert.match(source, /installHubSkill:\s*\(name: string, target: HubSkillInstallTarget\) => Promise<InstallResult>/);
  assert.match(dashboardSource, /installHubSkill:\s*\(name: string, target: HubSkillInstallTarget\) => Promise<\{ ok: boolean; message: string \}>/);
  assert.match(extensionsSource, /activeWorkspaceId:\s*\(\) => string/);
  assert.match(extensionsSource, /async function installHubSkill\(name: string, target: HubSkillInstallTarget\)/);
  assert.match(extensionsSource, /if \(target\.scope === "global"\)/);
  assert.match(source, /const \[installTargetSkill, setInstallTargetSkill\] = createSignal<HubSkillCard \| null>\(null\)/);
  assert.match(source, /const \[selectedInstallScope, setSelectedInstallScope\] = createSignal<"global" \| "workspace">\("workspace"\)/);
  assert.match(source, /const \[selectedInstallWorkspaceId, setSelectedInstallWorkspaceId\] = createSignal<string \| null>\(null\)/);
  assert.match(source, /const openHubInstallTargetPicker = \(skill: HubSkillCard\) =>/);
  assert.match(source, /void installFromHub\(skill, \{\s*scope: "workspace",\s*workspaceId,/);
  assert.match(source, /props\.installHubSkill\(skill\.name, target\)/);
  assert.match(source, /setInstallTargetSkill\(skill\)/);
  assert.doesNotMatch(source, /void installFromHub\(skill\);/);
  assert.match(source, /translate\("skills\.install_target_title"/);
  assert.match(source, /translate\("skills\.install_target_all_workspaces"/);
  assert.match(source, /translate\("skills\.install_target_workspace"/);
  assert.match(source, /translate\("skills\.install_target_confirm"/);
  assert.match(enSource, /"skills\.install_target_title":/);
  assert.match(csSource, /"skills\.install_target_title":/);
  assert.match(zhSource, /"skills\.install_target_title":/);
});

test("skill edit and delete callbacks are targeted by inventory instance", () => {
  assert.match(source, /import \{ skillMutationTargetFromInstance \} from "\.\.\/lib\/skill-inventory"/);
  assert.match(source, /import type \{ SkillMutationTarget \} from "\.\.\/lib\/skill-inventory"/);
  assert.match(source, /readSkillInstance:\s*\(target: SkillMutationTarget\) => Promise<\{ name: string; path: string; content: string \} \| null>/);
  assert.match(source, /saveSkillInstance:\s*\(target: SkillMutationTarget, content: string\) => Promise<SkillSaveResult>/);
  assert.match(source, /deleteSkillInstance:\s*\(target: SkillMutationTarget\) => Promise<void>/);
  assert.match(dashboardSource, /readSkillInstance:\s*\(target: SkillMutationTarget\) => Promise<\{ name: string; path: string; content: string \} \| null>/);
  assert.match(dashboardSource, /saveSkillInstance:\s*\(target: SkillMutationTarget, content: string\) => Promise<SkillSaveResult>/);
  assert.match(dashboardSource, /deleteSkillInstance:\s*\(target: SkillMutationTarget\) => Promise<void>/);
  assert.match(extensionsSource, /async function readSkillInstance\(target: SkillMutationTarget\)/);
  assert.match(extensionsSource, /async function saveSkillInstance\(target: SkillMutationTarget, content: string\)/);
  assert.match(extensionsSource, /async function deleteSkillInstance\(target: SkillMutationTarget\)/);
  assert.match(source, /const mutationTargetForInstance = \(instance: SkillInstance\): SkillMutationTarget \| null =>/);
  assert.match(source, /skillMutationTargetFromInstance\(instance\)/);
  assert.match(source, /props\.readSkillInstance\(skill\.mutationTarget\)/);
  assert.match(source, /props\.saveSkillInstance\(skill\.mutationTarget, selectedContent\(\)\)/);
  assert.match(source, /props\.deleteSkillInstance\(target\)/);
  assert.doesNotMatch(source, /props\.readSkill\(skill\.name\)/);
  assert.doesNotMatch(source, /props\.saveSkill\(\{\s*name: skill\.name/);
  assert.doesNotMatch(source, /props\.uninstallSkill\(target\.name\)/);
});
