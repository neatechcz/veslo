import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const soulSource = readFileSync(new URL("./soul.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const enSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../i18n/locales/zh.ts", import.meta.url), "utf8");

test("SoulView consumes overview source summaries instead of legacy prompt setup state", () => {
  assert.match(soulSource, /import type \{ VesloSoulOverviewResponse,\s*VesloSoulSummary \} from "\.\.\/lib\/veslo-server"/);
  assert.match(soulSource, /soulOverview:\s*VesloSoulOverviewResponse\s*\|\s*null;/);
  assert.match(soulSource, /soulOverviewError:\s*string\s*\|\s*null;/);
  assert.match(soulSource, /soulOverviewBusy:\s*boolean;/);
  assert.doesNotMatch(soulSource, /runSoulPrompt/);
  assert.doesNotMatch(soulSource, /give-me-a-soul\.md/);
  assert.doesNotMatch(soulSource, /\.opencode\/soul\.md/);
  assert.doesNotMatch(soulSource, /cadenceOptions|focusInput|boundariesInput|update_focus_prompt/);
});

test("Dashboard passes Soul overview state and busy flag to SoulView", () => {
  assert.match(dashboardSource, /soulOverviewBusy:\s*boolean;/);
  assert.match(appSource, /const \[soulOverviewBusy,\s*setSoulOverviewBusy\] = createSignal\(false\)/);
  assert.match(appSource, /soulOverviewBusy:\s*soulOverviewBusy\(\)/);
  assert.match(dashboardSource, /<SoulView[\s\S]*soulOverview=\{props\.soulOverview\}/);
  assert.match(dashboardSource, /<SoulView[\s\S]*soulOverviewError=\{props\.soulOverviewError\}/);
  assert.match(dashboardSource, /<SoulView[\s\S]*soulOverviewBusy=\{props\.soulOverviewBusy\}/);
  assert.match(dashboardSource, /<SoulView[\s\S]*refresh=\{props\.refreshSoulData\}/);
  assert.doesNotMatch(dashboardSource, /<SoulView[\s\S]{0,500}runSoulPrompt=\{props\.runSoulPrompt\}/);
});

test("Soul source overview order is organization, user, then workspace table", () => {
  const orgIndex = soulSource.indexOf('"soul-organization-source"');
  const userIndex = soulSource.indexOf('"soul-user-source"');
  const workspaceIndex = soulSource.indexOf('"soul-workspace-sources-table"');

  assert.ok(orgIndex >= 0, "organization source panel should have a stable test id");
  assert.ok(userIndex >= 0, "user source panel should have a stable test id");
  assert.ok(workspaceIndex >= 0, "workspace sources table should have a stable test id");
  assert.ok(orgIndex < userIndex, "organization source should render before user source");
  assert.ok(userIndex < workspaceIndex, "user source should render before workspace sources");
});

test("Soul overview locale keys exist in all app locales", () => {
  const requiredKeys = [
    "soul.source_title",
    "soul.source_subtitle",
    "soul.organization_source",
    "soul.user_source",
    "soul.workspace_sources",
    "soul.status",
    "soul.heartbeat",
    "soul.updated",
    "soul.current_version",
    "soul.editable",
    "soul.read_only",
    "soul.empty_workspaces",
    "soul.not_available",
    "soul.loading_overview",
  ];

  for (const localeSource of [enSource, csSource, zhSource]) {
    for (const key of requiredKeys) {
      assert.match(localeSource, new RegExp(`"${key.replaceAll(".", "\\.")}":`), `${key} should be localized`);
    }
  }
});
