import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./sidebar-dashboard-nav.tsx", import.meta.url), "utf8");

test("sidebar dashboard nav collapses from prefs and exposes a divider toggle", () => {
  assert.match(
    source,
    /import \{[\s\S]*readSidebarDashboardNavCollapsed,[\s\S]*writeSidebarDashboardNavCollapsed,[\s\S]*\} from "\.\/sidebar-dashboard-nav-prefs";/,
  );
  assert.match(source, /const \[collapsed, setCollapsed\] = createSignal\(readSidebarDashboardNavCollapsed\(\)\);/);
  assert.match(source, /writeSidebarDashboardNavCollapsed\(nextCollapsed\);/);
  assert.match(source, /<Show when=\{\!collapsed\(\)\}>[\s\S]*History[\s\S]*HeartPulse[\s\S]*Zap[\s\S]*Box[\s\S]*<\/Show>/);
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
