import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/dashboard.tsx", import.meta.url), "utf8");
const sidebarDashboardNavSource = readFileSync(new URL("../../components/session/sidebar-dashboard-nav.tsx", import.meta.url), "utf8");

const leftSidebarStart = source.indexOf('<Show when={leftSidebarVisible()}>');
const mainStart = source.indexOf('<main class="flex-1 flex flex-col overflow-hidden bg-dls-surface pt-12">');
const rightSidebarStart = source.indexOf('<Show when={rightSidebarVisible()}>');

const leftSidebar = leftSidebarStart >= 0 && mainStart >= 0 ? source.slice(leftSidebarStart, mainStart) : "";
const rightSidebar = rightSidebarStart >= 0 ? source.slice(rightSidebarStart) : "";
const mobileBottomNavSource =
  source.match(/<nav class="md:hidden border-t border-dls-border bg-dls-surface">[\s\S]*?<\/nav>/)?.[0] ?? "";

test("dashboard relocates the product nav into the left sidebar above settings", () => {
  assert.match(source, /import SidebarDashboardNav from "\.\.\/components\/session\/sidebar-dashboard-nav";/);
  assert.match(
    leftSidebar,
    /<WorkspaceSessionList[\s\S]*<SidebarDashboardNav[\s\S]*currentTab=\{props\.tab\}[\s\S]*<SidebarStatusControls/,
  );
});

test("dashboard uses compact sizing for the relocated left-sidebar nav items", () => {
  assert.doesNotMatch(source, /const navItem =/);
  assert.match(leftSidebar, /<SidebarDashboardNav[\s\S]*onSelect=\{handleDashboardTabSelection\}/);
});

test("dashboard left sidebar omits Soul and Extensions links", () => {
  assert.match(sidebarDashboardNavSource, /props\.onSelect\("scheduled"\)/);
  assert.match(sidebarDashboardNavSource, /props\.onSelect\("skills"\)/);
  assert.doesNotMatch(sidebarDashboardNavSource, /props\.onSelect\("soul"\)/);
  assert.doesNotMatch(sidebarDashboardNavSource, /props\.onSelect\("mcp"\)/);
  assert.doesNotMatch(sidebarDashboardNavSource, /t\("nav\.soul"/);
  assert.doesNotMatch(sidebarDashboardNavSource, /t\("nav\.extensions"/);
});

test("dashboard keeps the right sidebar reserved for advanced nav only", () => {
  assert.match(source, /import SidebarAdvancedNav from "\.\.\/components\/session\/sidebar-advanced-nav";/);
  assert.match(rightSidebar, /<SidebarAdvancedNav[\s\S]*currentTab=\{props\.tab\}/);
  assert.doesNotMatch(rightSidebar, /<SidebarDashboardNav/);
});

test("dashboard mobile bottom nav hides automations", () => {
  assert.match(
    source,
    /<nav class="md:hidden border-t border-dls-border bg-dls-surface">[\s\S]*\{t\("nav\.soul", currentLocale\(\)\)\}[\s\S]*\{t\("nav\.skills", currentLocale\(\)\)\}[\s\S]*\{t\("nav\.extensions", currentLocale\(\)\)\}[\s\S]*\{t\("nav\.plugins", currentLocale\(\)\)\}/,
  );
  assert.doesNotMatch(
    source,
    /<nav class="md:hidden border-t border-dls-border bg-dls-surface">[\s\S]*\{t\("nav\.automations", currentLocale\(\)\)\}/,
  );
});

test("dashboard mobile bottom nav keeps MCP active state separate from plugins", () => {
  assert.match(
    mobileBottomNavSource,
    /onClick=\{\(\) => handleDashboardTabSelection\("mcp"\)\}[\s\S]*\{t\("nav\.extensions", currentLocale\(\)\)\}/,
  );
  assert.match(mobileBottomNavSource, /props\.tab === "mcp" \? "text-gray-12" : "text-gray-10"/);
  assert.doesNotMatch(mobileBottomNavSource, /props\.tab === "mcp"\s*\|\|\s*props\.tab === "plugins"/);
  assert.match(
    mobileBottomNavSource,
    /onClick=\{\(\) => handleDashboardTabSelection\("plugins"\)\}[\s\S]*\{t\("nav\.plugins", currentLocale\(\)\)\}/,
  );
  assert.match(mobileBottomNavSource, /props\.tab === "plugins" \? "text-gray-12" : "text-gray-10"/);
  assert.doesNotMatch(mobileBottomNavSource, /props\.tab === "plugins"\s*\|\|\s*props\.tab === "mcp"/);
});

test("dashboard reserves a titlebar-safe top strip for shell columns", () => {
  assert.match(
    leftSidebar,
    /class=\{`relative hidden md:flex flex-col bg-dls-sidebar border-r border-dls-border p-4 pt-12/,
    "left sidebar content should start below the fixed shared titlebar controls",
  );
  assert.match(
    source,
    /<main class="flex-1 flex flex-col overflow-hidden bg-dls-surface pt-12">/,
    "main dashboard content should start below the fixed shared titlebar controls",
  );
  assert.match(
    rightSidebar,
    /<aside class="w-56 hidden md:flex flex-col bg-dls-sidebar border-l border-dls-border p-4 pt-12">/,
    "right sidebar content should start below the fixed shared titlebar controls",
  );
});
