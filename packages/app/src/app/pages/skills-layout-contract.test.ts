import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./skills.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const extensionsSource = readFileSync(new URL("../context/extensions.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../types.ts", import.meta.url), "utf8");
const skillInventoryFiltersSource = readFileSync(new URL("../lib/skill-inventory-filters.ts", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");
const skillDetailDrawerSource = readFileSync(new URL("../components/skill-detail-drawer.tsx", import.meta.url), "utf8");
const renderInventoryCardSource = source.slice(
  source.indexOf("const renderInventoryCard"),
  source.indexOf("\n  return (\n    <section", source.indexOf("const renderInventoryCard")),
);

test("skills page removes worker profile and mode stat cards", () => {
  assert.equal(source.includes('translate("skills.worker_profile")'), false);
  assert.equal(source.includes('translate("skills.stat_skill_creator")'), false);
  assert.equal(source.includes('translate("skills.stat_mode")'), false);
});

test("skills page removes redundant top summary block", () => {
  assert.doesNotMatch(source, /translate\("skills\.title"\)/);
  assert.doesNotMatch(source, /translate\("skills\.subtitle"\)/);
  assert.doesNotMatch(source, /translate\("skills\.create_in_chat"\)/);
  assert.doesNotMatch(source, /translate\("skills\.stat_installed"\)/);
  assert.doesNotMatch(source, /translate\("skills\.stat_hub_available"\)/);
  assert.doesNotMatch(source, /const installedSkillCount = createMemo/);
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
  assert.match(source, /const installedInventoryItems = createMemo\(\(\) =>\s*mergeRemoteFallbackIntoInventory\(\s*filterSkillInventoryItems\(\s*props\.skillInventory/);
  assert.doesNotMatch(source, /\{props\.skills\.length\}/);
});

test("skills page derives installed inventory from visible active lifecycle state", () => {
  assert.match(
    source,
    /const installedInventoryItems = createMemo\(\(\) =>\s*mergeRemoteFallbackIntoInventory\(\s*filterSkillInventoryItems\(\s*props\.skillInventory,\s*\{\s*includeDeleted:\s*false\s*\}\s*\)\s*\.filter\(\(item\) => item\.status !== "hub-only"\)/,
  );
});

test("skills page separates user and workspace-specific inventory sections", () => {
  assert.match(source, /translate\("skills\.all_workspaces"\)/);
  assert.match(source, /translate\("skills\.workspace_specific"\)/);
  assert.match(enSource, /"skills\.all_workspaces":\s*"User skills"/);
  assert.match(enSource, /"skills\.workspace_specific":\s*"Workspace-specific"/);
  assert.match(csSource, /"skills\.all_workspaces":/);
  assert.match(csSource, /"skills\.workspace_specific":/);
  assert.match(zhSource, /"skills\.all_workspaces":/);
  assert.match(zhSource, /"skills\.workspace_specific":/);
});

test("skills inventory cards avoid duplicate placement badges", () => {
  assert.equal(source.includes("VESLO_DEFAULT_SKILL_NAMES"), false);
  assert.equal(source.includes("isVesloInjectedSkill"), false);
  assert.doesNotMatch(renderInventoryCardSource, />\s*Veslo\s*</);
  assert.doesNotMatch(source, /const workspaceDirectoryNameForInstance = \(instance: SkillInstance\) =>/);
  assert.doesNotMatch(source, /const workspaceDirectoryNamesForItem = \(item: SkillInventoryItem\) =>/);
  assert.doesNotMatch(source, /const workspaceDirectoryTooltipLinesForItem = \(item: SkillInventoryItem\) =>/);
  assert.doesNotMatch(source, /const skillInventoryScopeBadge = \(input: \{ item: SkillInventoryItem; instance: SkillInstance \}\) =>/);
  assert.match(source, /const skillDirectoryPathForLocation = \(path: string\) =>/);
  assert.equal(source.includes('path.trim().replace(/[\\\\/](?:SKILL\\.md|AGENTS\\.md)$/i, "")'), true);
  assert.match(source, /const openInventoryInstanceLocation = async \(path: string\) =>/);
  assert.match(source, /await import\("@tauri-apps\/plugin-opener"\)/);
  assert.match(source, /await openPath\(target\)/);
  assert.match(source, /await revealItemInDir\(originalTarget \|\| target\)/);
  assert.doesNotMatch(renderInventoryCardSource, /scopeBadge/);
  assert.match(renderInventoryCardSource, /<h4[\s\S]*?title=\{input\.item\.name\}[\s\S]*?>[\s\S]*?\{input\.item\.name\}[\s\S]*?<\/h4>/);
  assert.doesNotMatch(renderInventoryCardSource, /translate\("skills\.scope_global"\)/);
  assert.doesNotMatch(renderInventoryCardSource, /translate\("skills\.workspace_scope_multiple"\)/);
  assert.match(renderInventoryCardSource, /<FolderOpen size=\{13\}/);
  assert.match(renderInventoryCardSource, /openInventoryInstanceLocation\(input\.instance\.path\)/);
  assert.match(renderInventoryCardSource, /title=\{translate\("skills\.reveal_skill_location"\)\}/);
  assert.match(renderInventoryCardSource, /e\.stopPropagation\(\)/);
  assert.doesNotMatch(renderInventoryCardSource, /\{input\.instance\.path\}<\/div>/);
  assert.match(enSource, /"skills\.reveal_skill_location":/);
  assert.match(csSource, /"skills\.reveal_skill_location":/);
  assert.match(zhSource, /"skills\.reveal_skill_location":/);
});

test("workspace-specific rows come from workspaceInstances without expanding globals across workspaces", () => {
  assert.match(source, /const workspaceInventoryRows = createMemo\(\(\) =>\s*filteredInstalledInventoryItems\(\)\s*\.flatMap/);
  assert.match(source, /item\.workspaceInstances\.map/);
  assert.doesNotMatch(source, /sectionLabel:/);
  assert.doesNotMatch(source, /item\.status === "mixed"\s*\?\s*translate\("skills\.workspace_overrides"\)/);
  assert.doesNotMatch(source, /props\.workspaces\.map\([\s\S]{0,500}globalInstance/);
});

test("default inventory view does not render global-backed skills again as workspace rows", () => {
  assert.match(source, /item\.globalInstance\s*\?\s*\[\]\s*:\s*item\.workspaceInstances\.map/);
});

test("bulk selection only targets visible inventory rows", () => {
  assert.match(source, /const currentInventorySelectionIds = createMemo\(\(\) =>\s*inventoryTableRows\(\)\.map\(\(row\) => skillInventoryInstanceId\(row\.instance\)\)\s*\)/);
});

test("local skill import refreshes the app-wide installed inventory", () => {
  assert.match(source, /const importLocalSkillAndRefreshInventory = \(\) =>\s*Promise\.resolve\(props\.importLocalSkill\(\)\)\s*\.finally\(\(\) => props\.refreshSkillInventory\(\{ force: true \}\)\)/);
  assert.match(source, /id: "import-local"[\s\S]*onClick: importLocalSkillAndRefreshInventory/);
  assert.doesNotMatch(source, /id: "import-local"[\s\S]{0,300}onClick: props\.importLocalSkill/);
});

test("inventory card uninstall targets writable active workspace instances", () => {
  assert.match(source, /activeWorkspaceId: string/);
  assert.match(source, /const canUninstallInventoryInstance = \(input: \{ item: SkillInventoryItem; instance: SkillInstance \}\) =>\s*Boolean\(mutationTargetForInstance\(input\.instance\)\)/);
  assert.match(source, /if \(input\.instance\.writable === false\) return translate\("skills\.uninstall_read_only"\)/);
  assert.match(source, /if \(input\.instance\.scope !== "workspace"\) return translate\("skills\.uninstall_scope_ambiguous"\)/);
  assert.match(source, /if \(input\.instance\.workspaceId !== props\.activeWorkspaceId\) return translate\("skills\.uninstall_not_active_workspace"\)/);
  assert.match(renderInventoryCardSource, /disabled=\{props\.busy \|\| !canUninstall\(\)\}/);
  assert.match(source, /aria-label=\{uninstallTitle\(\)\}/);
  assert.match(renderInventoryCardSource, /setUninstallTarget/);
});

test("removed inventory rows reserve restore metadata for a later UI affordance", () => {
  assert.match(typesSource, /export type SkillInventoryLifecycle = "active" \| "removed"/);
  assert.match(typesSource, /restoreTarget\?:\s*\{/);
  assert.match(skillInventoryFiltersSource, /metadata\.lifecycle === "removed"/);
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
  assert.match(source, /saveSkill: \(input: \{ name: string; path\?: string; content: string; description\?: string \}\) => Promise<SkillSaveResult>/);
  assert.match(dashboardSource, /saveSkill: \(input: \{ name: string; path\?: string; content: string; description\?: string \}\) => Promise<SkillSaveResult>/);
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

test("skills inventory item clicks toggle selection while pencil opens detail drawer", () => {
  assert.match(renderInventoryCardSource, /const toggleCurrentSelection = \(\) => toggleInventorySelection\(selectionId\(\), !selected\(\)\)/);
  assert.match(renderInventoryCardSource, /onClick=\{toggleCurrentSelection\}/);
  assert.match(renderInventoryCardSource, /toggleCurrentSelection\(\);/);
  assert.doesNotMatch(renderInventoryCardSource, /onClick=\{openDetails\}/);
  assert.match(renderInventoryCardSource, /data-testid="skill-inventory-detail-button"/);
  assert.match(renderInventoryCardSource, /openDetails\(\);/);
  assert.match(source, /const toggleTableRowSelection = \(instance: SkillInstance\) =>/);
  assert.match(source, /onClick=\{\(\) => toggleTableRowSelection\(row\.instance\)\}/);
  assert.doesNotMatch(source, /<tr[\s\S]{0,500}onClick=\{\(\) => openSkillDetail\(row\.item, row\.instance\)\}/);
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
  assert.match(extensionsSource, /const skillEntryFilePathForMutationPath = \(value: string \| undefined\) =>/);
  assert.match(extensionsSource, /readSkill\(resolved\.skill\.name, resolved\.skill\.path\)/);
  assert.match(extensionsSource, /writeLocalSkillAtPath/);
  assert.match(extensionsSource, /path: resolved\.skill\.path/);
  assert.match(extensionsSource, /async function deleteSkillInstance\(target: SkillMutationTarget\)/);
  assert.match(extensionsSource, /deleteSkill\(vesloWorkspaceId, resolved\.skill\.name, \{ path: resolved\.skill\.path \}\)/);
  assert.match(extensionsSource, /uninstallSkillAtPath\(root, resolved\.skill\.name, resolved\.entryFilePath\)/);
  assert.match(source, /const mutationTargetForInstance = \(instance: SkillInstance\): SkillMutationTarget \| null =>/);
  assert.match(source, /skillMutationTargetFromInstance\(instance\)/);
  assert.match(source, /props\.readSkillInstance\(skill\.mutationTarget\)/);
  assert.match(source, /props\.saveSkillInstance\(skill\.mutationTarget, selectedContent\(\)\)/);
  assert.match(source, /props\.deleteSkillInstance\(target\)/);
  assert.doesNotMatch(source, /props\.readSkill\(skill\.name\)/);
  assert.doesNotMatch(source, /props\.saveSkill\(\{\s*name: skill\.name/);
  assert.doesNotMatch(source, /props\.uninstallSkill\(target\.name\)/);
});

test("workspace skill copy and move are local scope transfer actions, not disabled placeholders", () => {
  assert.match(source, /copySkillInstanceToGlobal:\s*\(target: SkillMutationTarget, options\?: \{ deleteSource\?: boolean \}\) => Promise<SkillSaveResult>/);
  assert.match(source, /copySkillInstanceToWorkspace:\s*\(target: SkillMutationTarget, workspaceId: string\) => Promise<SkillSaveResult>/);
  assert.match(dashboardSource, /copySkillInstanceToGlobal:\s*\(target: SkillMutationTarget, options\?: \{ deleteSource\?: boolean \}\) => Promise<SkillSaveResult>/);
  assert.match(dashboardSource, /copySkillInstanceToWorkspace:\s*\(target: SkillMutationTarget, workspaceId: string\) => Promise<SkillSaveResult>/);
  assert.match(
    extensionsSource,
    /async function copySkillInstanceToGlobal\(\s*target: SkillMutationTarget,\s*optionsOverride\?: \{ deleteSource\?: boolean \},?\s*\): Promise<SkillSaveResult>/,
  );
  assert.match(
    extensionsSource,
    /async function copySkillInstanceToWorkspace\(\s*target: SkillMutationTarget,\s*workspaceId: string,?\s*\): Promise<SkillSaveResult>/,
  );
  assert.match(appSource, /\bcopySkillInstanceToGlobal,/);
  assert.match(appSource, /\bcopySkillInstanceToWorkspace,/);
  assert.match(appSource, /\bdeleteSkillInstance,/);
  assert.match(source, /const globalTransferDisabledReasonForInstance = \(instance: SkillInstance\) =>/);
  assert.match(source, /if \(instance\.scope === "user-global"\) return translate\("skills\.copy_to_global_already_global"\)/);
  assert.match(source, /const detailInstanceForAction = \(input\?: SkillDetailActionInput\): SkillInstance \| null =>/);
  assert.match(source, /const copySelectedSkillToGlobal = \(deleteSource: boolean, input\?: SkillDetailActionInput\) =>/);
  assert.match(source, /const actionInstance = detailInstanceForAction\(input\)/);
  assert.match(source, /props\.copySkillInstanceToGlobal\(target, \{ deleteSource: true \}\)/);
  assert.match(source, /const selectedDetailCanTransferToUserSkill = createMemo/);
  assert.match(source, /const selectedDetailCanInstallToWorkspace = createMemo/);
  assert.match(source, /copy: selectedDetailCanTransferToUserSkill\(\) \? null : selectedDetailGlobalTransferDisabledReason\(\)/);
  assert.match(source, /move: selectedDetailCanTransferToUserSkill\(\) \? null : selectedDetailGlobalTransferDisabledReason\(\)/);
  assert.match(source, /onCopySkill=\{selectedDetailIsWorkspaceSkill\(\) \? \(input\) => copySelectedSkillToGlobal\(true, input\) : undefined\}/);
  assert.match(source, /onMoveSkill=\{selectedDetailIsWorkspaceSkill\(\) \? \(input\) => copySelectedSkillToGlobal\(true, input\) : undefined\}/);
  assert.match(source, /onCopyToWorkspaceSkill=\{selectedDetailCanInstallToWorkspace\(\) \? openWorkspaceInstallTargetPicker : undefined\}/);
  assert.match(source, /props\.copySkillInstanceToWorkspace\(target, workspaceId\)/);
  assert.doesNotMatch(source, /transferSelectedSkillsToGlobal\(false\)/);
  assert.doesNotMatch(source, /copySelectedSkillToGlobal\(false/);
  assert.doesNotMatch(source, /translate\("skills\.bulk_copy"\)[\s\S]{0,240}<Button[\s\S]{0,180}\sdisabled\s/);
  assert.doesNotMatch(source, /translate\("skills\.bulk_move"\)[\s\S]{0,240}<Button[\s\S]{0,180}\sdisabled\s/);
});

test("workspace install target picker is an elevated cancellable modal with constrained height", () => {
  assert.match(source, /import ModalShell from "\.\.\/components\/modal-shell"/);
  assert.match(source, /const workspaceInstallTitleId = "skill-install-workspace-title"/);
  assert.match(
    source,
    /<ModalShell\s+open=\{Boolean\(workspaceInstallAction\(\)\)\}\s+onClose=\{closeWorkspaceInstallTargetPicker\}\s+layer="elevated"[\s\S]*ariaLabelledBy=\{workspaceInstallTitleId\}[\s\S]*class="[^"]*max-h-\[calc\(100vh-2rem\)\]/,
  );
  assert.match(
    source,
    /data-testid="skill-install-workspace-modal"[\s\S]*class="flex max-h-\[calc\(100vh-2rem\)\] min-h-0 flex-col"/,
  );
  assert.match(source, /id=\{workspaceInstallTitleId\}/);
  assert.match(source, /data-testid="skill-install-workspace-close"/);
  assert.match(source, /aria-label=\{translate\("common\.close"\)\}[\s\S]*onClick=\{closeWorkspaceInstallTargetPicker\}[\s\S]*<X size=\{18\}/);
  assert.match(source, /class="min-h-0 flex-1 overflow-y-auto px-6 py-5"/);
  assert.doesNotMatch(source, /<Show when=\{workspaceInstallAction\(\)\}>[\s\S]{0,220}<div class="fixed inset-0 z-50/);
});

test("skills page wires registry inventory filters, table mode, bulk selection, and detail drawer", () => {
  assert.match(source, /filterSkillInventoryItems/);
  assert.match(source, /currentInventorySelectionIds/);
  assert.match(source, /data-testid="skills-inventory-table"/);
  assert.match(source, /data-testid="skills-bulk-toolbar"/);
  assert.doesNotMatch(source, /translate\("skills\.bulk_adopt"\)/);
  assert.match(source, /<SkillDetailDrawer/);
  assert.match(source, /<SkillReviewDialog/);
  assert.match(source, /const selectedDetailCanPublishFromLocal = createMemo/);
  assert.match(source, /onPublishSkill=\{selectedDetailCanPublishFromLocal\(\) \? \(action\) => openSkillReviewDialog\("organization", action\) : undefined\}/);
  assert.match(source, /onRequestApproval=\{selectedDetailCanPublishFromLocal\(\) \? \(action\) => openSkillReviewDialog\("system", action\) : undefined\}/);
});

test("skills page removes single-skill sharing and public skill link publishing", () => {
  assert.doesNotMatch(source, /Share2/);
  assert.doesNotMatch(source, /publishVesloBundleJson/);
  assert.doesNotMatch(source, /DEFAULT_VESLO_PUBLISHER_BASE_URL/);
  assert.doesNotMatch(source, /shareTarget|shareOpen|shareBusy|shareUrl|shareError/);
  assert.doesNotMatch(source, /openShareLink|publishShareLink|copyShareLink/);
  assert.doesNotMatch(source, /translate\("skills\.share_action"\)/);
  assert.doesNotMatch(source, /translate\("skills\.share_title"\)/);
  assert.doesNotMatch(enSource, /"skills\.share_action":/);
  assert.doesNotMatch(enSource, /"skills\.share_title":/);
  assert.doesNotMatch(csSource, /"skills\.share_action":/);
  assert.doesNotMatch(zhSource, /"skills\.share_title":/);
});

test("skills page uses install and user-skill terminology instead of adopt or global labels", () => {
  assert.doesNotMatch(source, /bulk_adopt/);
  assert.doesNotMatch(enSource, /Adopt|Copy to global|Move to global|"skills\.filter_scope_global":\s*"Global"/);
  assert.doesNotMatch(csSource, /Adoptovat|globálních|"skills\.filter_scope_global":\s*"Globální"/);
  assert.doesNotMatch(zhSource, /采用|复制到全局|移动到全局|"skills\.filter_scope_global":\s*"全局"/);
  assert.match(enSource, /"skills\.add_hub":\s*"Install"/);
  assert.match(enSource, /"skills\.copy_to_global":\s*"Copy to user skills"/);
  assert.match(enSource, /"skills\.move_to_global":\s*"Move to user skills"/);
  assert.match(csSource, /"skills\.add_hub":\s*"Nainstalovat"/);
  assert.match(csSource, /"skills\.copy_to_global":\s*"Kopírovat do user skills"/);
  assert.match(csSource, /"skills\.move_to_global":\s*"Přesunout do user skills"/);
});

test("skill detail drawer hides unavailable actions instead of rendering irrelevant disabled buttons", () => {
  assert.match(skillDetailDrawerSource, /<Show when=\{props\.onCopySkill\}>/);
  assert.match(skillDetailDrawerSource, /<Show when=\{props\.onMoveSkill\}>/);
  assert.match(skillDetailDrawerSource, /<Show when=\{props\.onCopyToWorkspaceSkill\}>/);
  assert.match(skillDetailDrawerSource, /<Show when=\{props\.onPublishSkill\}>/);
  assert.match(skillDetailDrawerSource, /<Show when=\{props\.onRequestApproval\}>/);
  assert.match(skillDetailDrawerSource, /<Show when=\{props\.onDeleteSkill\}>/);
  assert.doesNotMatch(skillDetailDrawerSource, /disabled=\{!props\.onCopySkill/);
  assert.doesNotMatch(skillDetailDrawerSource, /disabled=\{!props\.onMoveSkill/);
  assert.doesNotMatch(skillDetailDrawerSource, /disabled=\{!props\.onCopyToWorkspaceSkill/);
  assert.doesNotMatch(skillDetailDrawerSource, /disabled=\{!props\.onPublishSkill/);
  assert.doesNotMatch(skillDetailDrawerSource, /disabled=\{!props\.onRequestApproval/);
  assert.doesNotMatch(skillDetailDrawerSource, /disabled=\{!props\.onDeleteSkill/);
});

test("skills page gives user skills and workspace skills different relevant detail actions", () => {
  assert.match(source, /const selectedDetailIsWorkspaceSkill = createMemo\(\(\) =>[\s\S]*detail\?\.instance\.scope === "workspace"/);
  assert.match(source, /const selectedDetailCanTransferToUserSkill = createMemo\(\(\) =>[\s\S]*detail\.instance\.scope === "workspace"[\s\S]*\)/);
  assert.match(source, /const selectedDetailCanInstallToWorkspace = createMemo\(\(\) =>[\s\S]*detail\.instance\.scope === "user-global"[\s\S]*\)/);
  assert.match(source, /const selectedDetailDeleteDisabledReason = createMemo\(\(\) =>/);
  assert.match(source, /delete: selectedDetailDeleteDisabledReason\(\)/);
  assert.match(source, /onEditSkill=\{selectedDetailIsWorkspaceSkill\(\) \? editSelectedSkill : undefined\}/);
  assert.match(source, /onCopySkill=\{selectedDetailIsWorkspaceSkill\(\) \? \(input\) => copySelectedSkillToGlobal\(true, input\) : undefined\}/);
  assert.match(source, /onMoveSkill=\{selectedDetailIsWorkspaceSkill\(\) \? \(input\) => copySelectedSkillToGlobal\(true, input\) : undefined\}/);
  assert.match(source, /onDeleteSkill=\{selectedDetailIsWorkspaceSkill\(\) \? requestDetailDelete : undefined\}/);
  assert.match(enSource, /"skills\.detail_copy_to_workspace":\s*"Install to workspace"/);
  assert.match(csSource, /"skills\.detail_copy_to_workspace":\s*"Nainstalovat do workspace"/);
  assert.match(zhSource, /"skills\.detail_copy_to_workspace":/);
});

test("skills page stores skill review drafts while registry publishing is unavailable", () => {
  assert.match(source, /const \[reviewDrafts, setReviewDrafts\] = createSignal<Record<string, string>>\(\{\}\)/);
  assert.match(source, /const skillReviewDraftKey = \(targetScope: SkillReviewTargetScope, action: SkillDetailActionInput\) =>/);
  assert.match(source, /setReviewReason\(reviewDrafts\(\)\[skillReviewDraftKey\(targetScope, action\)\] \?\? ""\)/);
  assert.match(source, /const saveSkillReviewDraft = \(input: SkillReviewActionInput\) =>/);
  assert.match(source, /setReviewDrafts\(\(current\) => \(\{/);
  assert.match(source, /setToast\(translate\("skills\.review_draft_saved"\)\)/);
  assert.match(source, /onSaveDraft=\{saveSkillReviewDraft\}/);
  assert.doesNotMatch(source, /onRequestOrganizationPublish=\{\(\) => \{\s*showRegistryActionPending\(\);/);
  assert.match(enSource, /"skills\.review_draft_saved":/);
  assert.match(csSource, /"skills\.review_draft_saved":/);
  assert.match(zhSource, /"skills\.review_draft_saved":/);
});

test("skills page localizes skill review metadata field labels", () => {
  assert.match(source, /field: translate\("skills\.review_field_name"\)/);
  assert.match(source, /field: translate\("skills\.review_field_description"\)/);
  assert.match(source, /field: translate\("skills\.review_field_trigger"\)/);
  assert.doesNotMatch(source, /field: "Name"/);
  assert.doesNotMatch(source, /field: "Description"/);
  assert.doesNotMatch(source, /field: "Trigger"/);
});

test("skills page review file diff points at the skill entry file", () => {
  assert.ok(source.includes("const reviewFilePath = detail.instance.path"));
  assert.ok(source.includes('${detail.instance.path.replace(/\\/$/, "")}/SKILL.md'));
  assert.match(source, /path: reviewFilePath/);
  assert.doesNotMatch(source, /path: detail\.instance\.path \|\| "SKILL\.md"/);
});
