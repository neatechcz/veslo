import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

const leftSidebarStart = source.indexOf("const leftSidebarContent = () => (");
const rightSidebarStart = source.indexOf("const rightSidebarContent = () => (");
const sessionReturnStart = source.indexOf("return (", rightSidebarStart);

const leftSidebar = leftSidebarStart >= 0 && rightSidebarStart >= 0 ? source.slice(leftSidebarStart, rightSidebarStart) : "";
const rightSidebar =
  rightSidebarStart >= 0 && sessionReturnStart >= 0 ? source.slice(rightSidebarStart, sessionReturnStart) : "";

test("session relocates the dashboard nav into the left sidebar above settings", () => {
  assert.match(
    leftSidebar,
    /<WorkspaceSessionList[\s\S]*<div class="mt-2 space-y-0\.5 border-t border-gray-6\/70 pt-2">[\s\S]*Automations[\s\S]*Soul[\s\S]*Skills[\s\S]*Extensions[\s\S]*<SidebarStatusControls/,
  );
  assert.match(
    leftSidebar,
    /class=\{`w-full h-8 flex items-center gap-2 px-2\.5 rounded-lg text-\[13px\] font-medium transition-colors/,
  );
});

test("session keeps the right sidebar reserved for advanced nav and session panels", () => {
  assert.match(rightSidebar, /Advanced/);
  assert.doesNotMatch(rightSidebar, /Automations[\s\S]*Soul[\s\S]*Skills[\s\S]*Extensions/);
  assert.match(rightSidebar, /<ArtifactsPanel/);
});
