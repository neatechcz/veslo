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
  assert.match(
    leftSidebar,
    /<WorkspaceSessionList[\s\S]*<div class="mt-2 space-y-0\.5 border-t border-gray-6\/70 pt-2">[\s\S]*navItem\("scheduled",[\s\S]*navItem\("soul",[\s\S]*navItem\("skills",[\s\S]*navItem\("mcp",[\s\S]*<SidebarStatusControls/,
  );
});

test("dashboard uses compact sizing for the relocated left-sidebar nav items", () => {
  assert.match(source, /const navItem = \(tab: DashboardTab, label: string, icon: any, options\?: \{ compact\?: boolean \}\) =>/);
  assert.match(
    source,
    /compact \? "w-full h-8 flex items-center gap-2 px-2\.5 rounded-lg text-\[13px\] font-medium transition-colors"/,
  );
  assert.match(leftSidebar, /navItem\("scheduled",[\s\S]*\{ compact: true \}\)/);
});

test("dashboard keeps the right sidebar reserved for advanced nav only", () => {
  assert.match(rightSidebar, /navItem\("config", t\("nav\.advanced", currentLocale\(\)\), <SlidersHorizontal size=\{18\} \/>\)/);
  assert.doesNotMatch(rightSidebar, /navItem\("(scheduled|soul|skills|mcp)"/);
});

test("dashboard keeps the mobile bottom nav intact", () => {
  assert.match(
    source,
    /<nav class="md:hidden border-t border-dls-border bg-dls-surface">[\s\S]*Automations[\s\S]*Soul[\s\S]*Skills[\s\S]*Extensions/,
  );
});
