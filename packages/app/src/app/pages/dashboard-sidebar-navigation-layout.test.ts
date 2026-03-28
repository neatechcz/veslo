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
    /<WorkspaceSessionList[\s\S]*<div class="mt-3 space-y-1 border-t border-gray-6\/70 pt-3">[\s\S]*navItem\("scheduled",[\s\S]*navItem\("soul",[\s\S]*navItem\("skills",[\s\S]*navItem\("mcp",[\s\S]*<SidebarStatusControls/,
  );
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
