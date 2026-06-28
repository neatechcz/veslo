import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveDashboardRouteTab } from "../controllers/app-startup-controller.js";

const extensionsSource = readFileSync(new URL("../pages/extensions.tsx", import.meta.url), "utf8");
const mcpSource = readFileSync(new URL("../pages/mcp.tsx", import.meta.url), "utf8");
const startupControllerSource = readFileSync(new URL("../controllers/app-startup-controller.ts", import.meta.url), "utf8");

test("extensions screen no longer imports plugin view or section state", () => {
  assert.doesNotMatch(extensionsSource, /import PluginsView/);
  assert.doesNotMatch(extensionsSource, /ExtensionsSection/);
  assert.doesNotMatch(extensionsSource, /extensions\.plugins/);
  assert.doesNotMatch(extensionsSource, /extensions\.plugins_opencode/);
  assert.doesNotMatch(extensionsSource, /tr\("extensions\.all"\)/);
  assert.doesNotMatch(extensionsSource, /tr\("extensions\.apps"\)/);
});

test("mcp screen no longer renders advanced settings or technical details", () => {
  assert.doesNotMatch(mcpSource, /mcp\.advanced_settings/);
  assert.doesNotMatch(mcpSource, /mcp\.technical_details/);
});

test("dashboard plugins route remains the plugins tab", () => {
  assert.doesNotMatch(startupControllerSource, /if \(normalized === "plugins"\) return "mcp";/);
  assert.equal(resolveDashboardRouteTab("plugins"), "plugins");
});
