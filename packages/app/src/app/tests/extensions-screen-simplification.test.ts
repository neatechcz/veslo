import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveDashboardRouteTab } from "../controllers/app-startup-controller.js";

const extensionsSource = readFileSync(new URL("../pages/extensions.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../pages/dashboard.tsx", import.meta.url), "utf8");
const mcpSource = readFileSync(new URL("../pages/mcp.tsx", import.meta.url), "utf8");
const startupControllerSource = readFileSync(new URL("../controllers/app-startup-controller.ts", import.meta.url), "utf8");

test("extensions screen remains MCP-only", () => {
  assert.doesNotMatch(extensionsSource, /import PluginsView/);
  assert.match(extensionsSource, /tr\("extensions\.title"\)/);
  assert.match(extensionsSource, /tr\("extensions\.subtitle"\)/);
  assert.match(extensionsSource, /<McpView\b/);
});

test("dashboard plugins tab renders PluginsView with plugin management props", () => {
  assert.match(dashboardSource, /import PluginsView from "\.\/plugins";/);
  assert.doesNotMatch(
    dashboardSource,
    /props\.tab === "plugins"\s*\|\|\s*props\.tab === "mcp"/,
  );

  const pluginsMatch = dashboardSource.match(
    /<Match when=\{props\.tab === "plugins"\}>([\s\S]*?)<\/Match>/,
  );
  assert.ok(pluginsMatch, "dashboard should have a dedicated plugins Match branch");

  const mcpMatch = dashboardSource.match(
    /<Match when=\{props\.tab === "mcp"\}>([\s\S]*?)<\/Match>/,
  );
  assert.ok(mcpMatch, "dashboard should have a dedicated MCP Match branch");

  const pluginsBranch = pluginsMatch[1];
  const mcpBranch = mcpMatch[1];
  assert.match(pluginsBranch, /<PluginsView\b/);
  assert.doesNotMatch(pluginsBranch, /<ExtensionsView\b/);
  assert.match(mcpBranch, /<ExtensionsView\b/);
  assert.match(pluginsBranch, /canEditPlugins=\{props\.canEditPlugins\}/);
  assert.match(pluginsBranch, /addPlugin=\{props\.addPlugin\}/);
  assert.match(pluginsBranch, /removePlugin=\{props\.removePlugin\}/);
});

test("mcp screen no longer renders advanced settings or technical details", () => {
  assert.doesNotMatch(mcpSource, /mcp\.advanced_settings/);
  assert.doesNotMatch(mcpSource, /mcp\.technical_details/);
});

test("dashboard plugins route remains the plugins tab", () => {
  assert.doesNotMatch(startupControllerSource, /if \(normalized === "plugins"\) return "mcp";/);
  assert.equal(resolveDashboardRouteTab("plugins"), "plugins");
});
