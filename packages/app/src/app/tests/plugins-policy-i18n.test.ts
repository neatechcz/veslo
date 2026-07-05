import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import cs from "../../i18n/locales/cs.js";
import en from "../../i18n/locales/en.js";
import zh from "../../i18n/locales/zh.js";

const pluginsSource = readFileSync(new URL("../pages/plugins.tsx", import.meta.url), "utf8");

const pluginPolicyKeys = [
  "plugins.inventory_group_platform",
  "plugins.inventory_group_organization",
  "plugins.inventory_group_user",
  "plugins.inventory_group_project",
  "plugins.lifecycle_enabled",
  "plugins.lifecycle_disabled",
  "plugins.lifecycle_removed",
  "plugins.lifecycle_conflict",
  "plugins.visibility_debug",
  "plugins.owner_opencode_config",
  "plugins.owner_managed_policy",
  "plugins.owner_manual_plugin",
  "plugins.action_disable",
  "plugins.action_enable",
  "plugins.action_restore",
  "plugins.action_remove",
] as const;

const locales = [
  ["English", en],
  ["Czech", cs],
  ["Chinese", zh],
] as const;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("plugin policy UI keys are present in all supported locale files", () => {
  for (const key of pluginPolicyKeys) {
    for (const [label, locale] of locales) {
      assert.ok(key in locale, `missing ${label} plugin policy translation: ${key}`);
    }
  }
});

test("plugin product terminology stays locale-specific", () => {
  assert.equal(en["plugins.title"], "OpenCode Plugins");
  assert.equal(cs["plugins.title"], "OpenCode Pluginy");
  assert.equal(cs["plugins.suggested_label"], "Doporučené Pluginy");
});

test("plugins page uses localized keys for policy inventory labels and actions", () => {
  for (const key of pluginPolicyKeys) {
    assert.match(pluginsSource, new RegExp(`["']${escapeRegExp(key)}["']`), `plugins page does not use ${key}`);
  }

  for (const forbiddenPattern of [
    /label:\s*"Platform"/,
    /label:\s*"Organization"/,
    /label:\s*"User"/,
    /label:\s*"Project"/,
    /return "Removed"/,
    /return "Conflict"/,
    /return "Disabled"/,
    /return "Enabled"/,
    /return "OpenCode config"/,
    /return item\.managed \? "Managed policy" : "Manual plugin"/,
    />\s*Debug\s*</,
    /\?\s*"Disable"\s*:\s*"Enable"/,
    />\s*Restore\s*</,
    /"mcp\.remove_app"/,
  ]) {
    assert.doesNotMatch(pluginsSource, forbiddenPattern);
  }
});
