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
  assert.match(source, /import SidebarDashboardNav from "\.\.\/components\/session\/sidebar-dashboard-nav";/);
  assert.match(
    leftSidebar,
    /<WorkspaceSessionList[\s\S]*<SidebarDashboardNav[\s\S]*currentTab=\{props\.tab\}[\s\S]*<SidebarStatusControls/,
  );
  assert.doesNotMatch(source, /showRightSidebarSelection/);
});

test("session keeps the right sidebar reserved for advanced nav and session panels", () => {
  assert.match(source, /import SidebarAdvancedNav from "\.\.\/components\/session\/sidebar-advanced-nav";/);
  assert.match(source, /import SessionCapabilitiesPanel from "\.\.\/components\/session\/session-capabilities-panel";/);
  assert.match(rightSidebar, /<SidebarAdvancedNav[\s\S]*currentTab=\{props\.tab\}/);
  assert.doesNotMatch(rightSidebar, /<SidebarDashboardNav/);
  assert.match(rightSidebar, /<ArtifactsPanel/);
  assert.match(rightSidebar, /<ArtifactsPanel[\s\S]*<SessionCapabilitiesPanel/);
});
