import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const leftSidebarSource = readFileSync(new URL("../../pages/session-left-sidebar.tsx", import.meta.url), "utf8");
const rightSidebarSource = readFileSync(new URL("../../pages/session-right-sidebar.tsx", import.meta.url), "utf8");

test("session relocates the dashboard nav into the left sidebar above settings", () => {
  assert.match(leftSidebarSource, /import SidebarDashboardNav from "\.\.\/components\/session\/sidebar-dashboard-nav";/);
  assert.match(
    leftSidebarSource,
    /<WorkspaceSessionList[\s\S]*<SidebarDashboardNav[\s\S]*<SidebarStatusControls/,
  );
  assert.match(source, /dashboardNavProps=\{\{[\s\S]*currentTab:\s*props\.tab/);
  assert.doesNotMatch(source, /showRightSidebarSelection/);
});

test("session keeps the right sidebar reserved for advanced nav and session panels", () => {
  assert.match(rightSidebarSource, /import SidebarAdvancedNav from "\.\.\/components\/session\/sidebar-advanced-nav";/);
  assert.match(rightSidebarSource, /import SessionCapabilitiesPanel from "\.\.\/components\/session\/session-capabilities-panel";/);
  assert.match(source, /advancedNavProps=\{\{[\s\S]*currentTab:\s*props\.tab/);
  assert.doesNotMatch(rightSidebarSource, /<SidebarDashboardNav/);
  assert.match(rightSidebarSource, /<ArtifactsPanel/);
  assert.match(rightSidebarSource, /<ArtifactsPanel[\s\S]*<SessionCapabilitiesPanel/);
});
