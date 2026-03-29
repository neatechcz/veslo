import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");

const leftSidebarStart = source.indexOf('<Show when={leftSidebarVisible()}>');
const mainStart = source.indexOf('<main class="flex-1 flex flex-col overflow-hidden bg-dls-surface">');
const rightSidebarStart = source.indexOf('<Show when={rightSidebarVisible()}>');

const leftSidebar = leftSidebarStart >= 0 && mainStart >= 0 ? source.slice(leftSidebarStart, mainStart) : "";
const rightSidebar = rightSidebarStart >= 0 ? source.slice(rightSidebarStart) : "";

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

test("dashboard keeps the right sidebar reserved for advanced nav only", () => {
  assert.match(source, /import SidebarAdvancedNav from "\.\.\/components\/session\/sidebar-advanced-nav";/);
  assert.match(rightSidebar, /<SidebarAdvancedNav[\s\S]*currentTab=\{props\.tab\}/);
  assert.doesNotMatch(rightSidebar, /<SidebarDashboardNav/);
});

test("dashboard keeps the mobile bottom nav intact", () => {
  assert.match(
    source,
    /<nav class="md:hidden border-t border-dls-border bg-dls-surface">[\s\S]*Automations[\s\S]*Soul[\s\S]*Skills[\s\S]*Extensions/,
  );
});
