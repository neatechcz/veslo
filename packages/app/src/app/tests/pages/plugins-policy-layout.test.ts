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
  assert.match(pluginsSource, /key:\s*"platform"[\s\S]*label:\s*"Platform"/);
  assert.match(pluginsSource, /key:\s*"organization"[\s\S]*label:\s*"Organization"/);
  assert.match(pluginsSource, /key:\s*"user"[\s\S]*label:\s*"User"/);
  assert.match(pluginsSource, /key:\s*"project"[\s\S]*label:\s*"Project"/);
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
  assert.match(appSource, /\bpluginInventory,\s*[\s\S]*\bsetPluginEnabled,\s*[\s\S]*\bremoveManagedPlugin,\s*[\s\S]*\brestoreManagedPlugin,/);
  assert.match(appSource, /pluginInventory=\{pluginInventory\(\)\}/);
  assert.match(appSource, /setPluginEnabled=\{setPluginEnabled\}/);
  assert.match(appSource, /removeManagedPlugin=\{removeManagedPlugin\}/);
  assert.match(appSource, /restoreManagedPlugin=\{restoreManagedPlugin\}/);
});
