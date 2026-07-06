import assert from "node:assert/strict";
import test from "node:test";

import {
  isPluginInstalled,
  normalizePluginList,
  parsePluginListFromContent,
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
