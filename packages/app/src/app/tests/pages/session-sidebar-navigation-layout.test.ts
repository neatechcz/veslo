import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const leftSidebarSource = readFileSync(new URL("../../pages/session-left-sidebar.tsx", import.meta.url), "utf8");
const rightSidebarSource = readFileSync(new URL("../../pages/session-right-sidebar.tsx", import.meta.url), "utf8");

test("session relocates the dashboard nav into the left sidebar above settings", () => {
  assert.match(source, /import SessionLeftSidebar from "\.\/session-left-sidebar";/);
  assert.match(leftSidebarSource, /import SidebarDashboardNav from "\.\.\/components\/session\/sidebar-dashboard-nav";/);
  assert.match(
    leftSidebarSource,
    /<WorkspaceSessionList\s+\{\.\.\.props\.workspaceSessionListProps\}[\s\S]*<SidebarDashboardNav\s+\{\.\.\.props\.dashboardNavProps\}[\s\S]*<SidebarStatusControls\s+\{\.\.\.props\.statusControlsProps\}/,
  );
  assert.match(source, /dashboardNavProps=\{\{\s*currentTab:\s*props\.tab,\s*onSelect:\s*openDashboardTab,\s*\}\}/s);
  assert.doesNotMatch(source, /showRightSidebarSelection/);
});

test("session keeps the right sidebar reserved for advanced nav and session panels", () => {
  assert.match(source, /import SessionRightSidebar from "\.\/session-right-sidebar";/);
  assert.match(rightSidebarSource, /import SidebarAdvancedNav from "\.\.\/components\/session\/sidebar-advanced-nav";/);
  assert.match(rightSidebarSource, /import SessionCapabilitiesPanel from "\.\.\/components\/session\/session-capabilities-panel";/);
  assert.match(rightSidebarSource, /<SidebarAdvancedNav\s+\{\.\.\.props\.advancedNavProps\}/);
  assert.doesNotMatch(rightSidebarSource, /<SidebarDashboardNav/);
  assert.match(rightSidebarSource, /<ArtifactsPanel\s+\{\.\.\.props\.artifactsPanelProps\}/);
  assert.match(
    rightSidebarSource,
    /<ArtifactsPanel\s+\{\.\.\.props\.artifactsPanelProps\}[\s\S]*<SessionCapabilitiesPanel\s+\{\.\.\.props\.sessionCapabilitiesPanelProps\}/,
  );
  assert.match(source, /advancedNavProps=\{\{\s*currentTab:\s*props\.tab,\s*onSelect:\s*openConfig,\s*\}\}/s);
});
