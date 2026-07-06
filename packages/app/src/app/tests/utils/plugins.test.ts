import assert from "node:assert/strict";
import test from "node:test";

import {
  addPluginSpecToContent,
  isPluginInstalled,
  normalizePluginList,
  parsePluginListFromContent,
  pluginConfigEntriesFromContent,
  removePluginSpecFromContent,
} from "../../utils/plugins.js";

test("normalizes string and tuple plugin config entries", () => {
  const normalized = normalizePluginList([
    " plain-plugin@1.0.0 ",
    ["tuple-plugin@2.0.0", { option: "value" }],
    ["tuple-without-options"],
    ["", { ignored: true }],
    ["invalid-options", ["not", "an", "object"]],
  ]);

  assert.deepEqual(normalized, [
    "plain-plugin@1.0.0",
    "tuple-plugin@2.0.0",
    "tuple-without-options",
  ]);
});

test("detects installed plugins from tuple config entries", () => {
  const pluginList = parsePluginListFromContent(JSON.stringify({
    plugin: [
      ["@scope/tuple-plugin@2.0.0", { option: "value" }],
      "plain-plugin@1.0.0",
    ],
  }));

  assert.equal(isPluginInstalled(pluginList, "@scope/tuple-plugin"), true);
  assert.equal(isPluginInstalled(pluginList, "plain-plugin"), true);
  assert.equal(isPluginInstalled(pluginList, "missing-plugin"), false);
});

test("app plugin config updates preserve tuple entries", () => {
  const initial = JSON.stringify({
    plugin: [
      ["@scope/tuple-plugin@2.0.0", { option: "value" }],
      "plain-plugin@1.0.0",
    ],
  }, null, 2);

  const added = addPluginSpecToContent(initial, "new-plugin");
  assert.equal(added.added, true);
  assert.deepEqual(pluginConfigEntriesFromContent(added.content), [
    ["@scope/tuple-plugin@2.0.0", { option: "value" }],
    "plain-plugin@1.0.0",
    "new-plugin",
  ]);

  const removed = removePluginSpecFromContent(added.content, "plain-plugin");
  assert.equal(removed.removed, true);
  assert.deepEqual(pluginConfigEntriesFromContent(removed.content), [
    ["@scope/tuple-plugin@2.0.0", { option: "value" }],
    "new-plugin",
  ]);
});
