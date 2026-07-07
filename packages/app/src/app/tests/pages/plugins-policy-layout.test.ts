import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pluginsSource = readFileSync(new URL("../../pages/plugins.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../../pages/dashboard.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const constantsSource = readFileSync(new URL("../../constants.ts", import.meta.url), "utf8");

test("plugins page renders policy inventory grouped by ownership scope", () => {
  assert.match(pluginsSource, /PluginInventoryCard/);
  assert.match(pluginsSource, /const\s+PLUGIN_INVENTORY_GROUPS\s*=/);
  assert.match(pluginsSource, /key:\s*"platform"[\s\S]*labelKey:\s*"plugins\.inventory_group_platform"/);
  assert.match(pluginsSource, /key:\s*"organization"[\s\S]*labelKey:\s*"plugins\.inventory_group_organization"/);
  assert.match(pluginsSource, /key:\s*"user"[\s\S]*labelKey:\s*"plugins\.inventory_group_user"/);
  assert.match(pluginsSource, /key:\s*"project"[\s\S]*labelKey:\s*"plugins\.inventory_group_project"/);
  assert.match(pluginsSource, /props\.pluginInventory/);
  assert.match(pluginsSource, /groupedPluginInventoryRows/);
});

test("hidden platform plugin rows are gated by developer mode", () => {
  assert.match(pluginsSource, /developerMode:\s*boolean/);
  assert.match(
    pluginsSource,
    /item\.visibility !== "hidden-debug-only"[\s\S]*props\.developerMode/,
  );
  assert.match(pluginsSource, /data-testid=\{`plugin-inventory-group-\$\{group\.key\}`\}/);
});

test("plugin inventory rows expose stable policy metadata for desktop e2e", () => {
  assert.match(pluginsSource, /data-testid="plugin-inventory-refresh"/);
  assert.match(pluginsSource, /data-testid="plugin-inventory-row"/);
  assert.match(pluginsSource, /data-plugin-id=\{item\.id\}/);
  assert.match(pluginsSource, /data-plugin-scope=\{item\.scope\}/);
  assert.match(pluginsSource, /data-plugin-source=\{item\.source\}/);
  assert.match(pluginsSource, /data-plugin-lifecycle=\{item\.lifecycle\}/);
  assert.match(pluginsSource, /data-plugin-enabled-policy=\{item\.enabledPolicy\}/);
  assert.match(pluginsSource, /data-plugin-removal-policy=\{item\.removalPolicy\}/);
  assert.match(pluginsSource, /data-plugin-visibility=\{item\.visibility\}/);
});

test("scheduler stays out of suggested plugins", () => {
  const suggestedStart = constantsSource.indexOf("SUGGESTED_PLUGINS");
  assert.ok(suggestedStart >= 0, "SUGGESTED_PLUGINS export should exist");
  const suggestedSection = constantsSource.slice(suggestedStart, constantsSource.indexOf("export type", suggestedStart));
  assert.equal(suggestedSection.includes("opencode-scheduler"), false);
});

test("Superpowers is sourced from platform inventory instead of suggested manual install", () => {
  const suggestedStart = constantsSource.indexOf("SUGGESTED_PLUGINS");
  const suggestedSection = constantsSource.slice(suggestedStart, constantsSource.indexOf("export type", suggestedStart));
  assert.equal(suggestedSection.includes("superpowers"), false);
  assert.match(pluginsSource, /props\.pluginInventory/);
  assert.match(pluginsSource, /item\.scope === group\.key/);
});

test("locked and admin-only policy rows do not render user action controls", () => {
  assert.match(pluginsSource, /const\s+canTogglePluginInventoryCard\s*=/);
  assert.match(pluginsSource, /item\.enabledPolicy === "user-toggleable"/);
  assert.match(pluginsSource, /const\s+canRemovePluginInventoryCard\s*=/);
  assert.match(pluginsSource, /item\.removalPolicy === "user-removable"/);
  assert.match(pluginsSource, /const\s+canRestorePluginInventoryCard\s*=/);
  assert.match(pluginsSource, /item\.removalPolicy === "user-removable"/);
  assert.match(pluginsSource, /data-testid="plugin-inventory-toggle"/);
  assert.match(pluginsSource, /data-testid="plugin-inventory-remove"/);
});

test("plugin policy inventory and actions are wired through dashboard and app", () => {
  assert.match(dashboardSource, /PluginInventoryCard/);
  assert.match(dashboardSource, /pluginInventory\?:\s*PluginInventoryCard\[\]/);
  assert.match(dashboardSource, /setPluginEnabled\?:\s*\(pluginId: string, enabled: boolean\) => Promise<void>/);
  assert.match(dashboardSource, /removeManagedPlugin\?:\s*\(pluginId: string\) => Promise<void>/);
  assert.match(dashboardSource, /restoreManagedPlugin\?:\s*\(pluginId: string\) => Promise<void>/);
  assert.match(dashboardSource, /pluginInventory=\{props\.pluginInventory \?\? \[\]\}/);
  assert.match(dashboardSource, /developerMode=\{props\.developerMode\}/);
  assert.match(appSource, /pluginInventory=\{pluginInventory\(\)\}/);
  assert.match(appSource, /setPluginEnabled=\{setPluginEnabled\}/);
  assert.match(appSource, /removeManagedPlugin=\{removeManagedPlugin\}/);
  assert.match(appSource, /restoreManagedPlugin=\{restoreManagedPlugin\}/);
});

test("plugins tab refreshes policy inventory after local Veslo server connects", () => {
  assert.match(appSource, /lastPluginsConnectedRefreshKey/);
  assert.match(appSource, /tab\(\) !== "plugins"/);
  assert.match(appSource, /vesloServerStatus\(\) !== "connected"/);
  assert.match(appSource, /const workspaceId = vesloServerWorkspaceId\(\)\?\.trim\(\) \?\? "";/);
  assert.match(appSource, /if \(!workspaceId\) return;/);
  assert.doesNotMatch(appSource, /vesloServerWorkspaceId\(\)\?\.trim\(\) \|\| workspaceStore\.activeWorkspaceId\(\)\.trim\(\)/);
  assert.match(appSource, /refreshPlugins\(pluginScope\(\), \{ debug: developerMode\(\) \}\)/);
  assert.match(appSource, /plugins\.refresh\.connected/);
});
