import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionsSource = readFileSync(new URL("./pages/extensions.tsx", import.meta.url), "utf8");
const mcpSource = readFileSync(new URL("./pages/mcp.tsx", import.meta.url), "utf8");

test("extensions screen no longer imports plugin view or section state", () => {
  assert.doesNotMatch(extensionsSource, /import PluginsView/);
  assert.doesNotMatch(extensionsSource, /ExtensionsSection/);
  assert.doesNotMatch(extensionsSource, /extensions\.plugins/);
});

test("mcp screen no longer renders advanced settings or technical details", () => {
  assert.doesNotMatch(mcpSource, /mcp\.advanced_settings/);
  assert.doesNotMatch(mcpSource, /mcp\.technical_details/);
});
