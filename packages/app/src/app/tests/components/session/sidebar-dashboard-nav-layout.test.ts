import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../components/session/sidebar-dashboard-nav.tsx", import.meta.url), "utf8");

test("sidebar dashboard nav collapses from prefs and exposes a divider toggle", () => {
  assert.match(
    source,
    /import \{[\s\S]*readSidebarDashboardNavCollapsed,[\s\S]*writeSidebarDashboardNavCollapsed,[\s\S]*\} from "\.\/sidebar-dashboard-nav-prefs";/,
  );
  assert.match(source, /const \[collapsed, setCollapsed\] = createSignal\(readSidebarDashboardNavCollapsed\(\)\);/);
  assert.match(source, /writeSidebarDashboardNavCollapsed\(nextCollapsed\);/);
  assert.match(source, /<Show when=\{\!collapsed\(\)\}>[\s\S]*History[\s\S]*Zap[\s\S]*<\/Show>/);
  assert.match(source, /nav\.automations/);
  assert.match(source, /onSelect\("scheduled"\)/);
  assert.doesNotMatch(source, /HeartPulse/);
  assert.doesNotMatch(source, /nav\.soul/);
  assert.doesNotMatch(source, /onSelect\("soul"\)/);
  assert.match(source, /onClick=\{toggleCollapsed\}/);
  assert.match(source, /const collapseLabel = \(\) =>[\s\S]*t\("nav\.expand_dashboard_nav", currentLocale\(\)\)[\s\S]*t\("nav\.collapse_dashboard_nav", currentLocale\(\)\);/);
  assert.match(
    source,
    /aria-label=\{collapseLabel\(\)\}/,
  );
  assert.match(
    source,
    /title=\{collapseLabel\(\)\}/,
  );
  assert.match(source, /aria-expanded=\{\!collapsed\(\)\}/);
  assert.match(
    source,
    /<Show when=\{collapsed\(\)\} fallback=\{<ChevronDown size=\{11\} \/>\}>\s*<ChevronUp size=\{11\} \/>\s*<\/Show>/,
  );
});

test("sidebar dashboard nav uses the same product typography tokens as sidebar action buttons", () => {
  assert.match(source, /font-product/);
  assert.match(source, /text-\[12\.5px\]/);
  assert.match(source, /font-medium/);
  assert.match(source, /w-full h-7 flex items-center gap-1\.5 px-2 rounded-md/);
});

test("active sidebar dashboard nav uses a cyan tint and icon with ink text", () => {
  assert.match(source, /rounded-md/);
  assert.match(
    source,
    /active\s*\? "bg-cyan-a3 text-dls-text font-medium"/,
    "active navigation should use the accent tint with medium ink text",
  );
  assert.match(
    source,
    /class=\{isActiveTab\(props\.currentTab, "scheduled"\) \? "text-dls-accent" : "text-gray-a8"\}/,
    "the Automations icon should turn cyan only while active",
  );
  assert.match(
    source,
    /class=\{isActiveTab\(props\.currentTab, "skills"\) \? "text-dls-accent" : "text-gray-a8"\}/,
    "the Skills icon should turn cyan only while active",
  );
  assert.match(
    source,
    /class="absolute left-1\/2 top-0[^"]*rounded-md border-0 bg-transparent text-gray-a8[^"]*hover:bg-cyan-a3 hover:text-dls-accent"/,
    "the nav divider toggle should be a ghost rectangle rather than a bordered circle",
  );
});
