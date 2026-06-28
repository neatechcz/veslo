import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const enLocaleSource = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");
const csLocaleSource = readFileSync(new URL("../../../i18n/locales/cs.ts", import.meta.url), "utf8");
const generalSection = source.match(/<Match when=\{activeTab\(\) === "general"\}>[\s\S]*?<\/Match>/)?.[0] ?? "";
const generalUpdateControlsRow = source.match(/<div class="flex flex-wrap items-center gap-2">[\s\S]*?settings\.auto_update_label[\s\S]*?<\/button>/)?.[0] ?? "";
const dashboardTabRailPath = new URL("../../components/dashboard-tab-rail.tsx", import.meta.url);
const dashboardTabRailSource = existsSync(dashboardTabRailPath) ? readFileSync(dashboardTabRailPath, "utf8") : "";

test("settings exposes archived tab and keeps developer tabs unavailable", () => {
  assert.match(source, /import DashboardTabRail/);
  assert.match(source, /<DashboardTabRail[\s\S]*activeDashboardTab="settings"[\s\S]*activeSettingsTab=\{activeTab\(\)\}/);
  assert.match(source, /onOpenDashboardTab=\{\(tab\) => props\.onOpenDashboardTab\?\.\(tab\)\}/);
  assert.match(dashboardTabRailSource, /\{\s*kind:\s*"settings",\s*tab:\s*"general"\s*\}/);
  assert.match(dashboardTabRailSource, /\{\s*kind:\s*"settings",\s*tab:\s*"archived"\s*\}/);
  assert.doesNotMatch(dashboardTabRailSource, /\{\s*kind:\s*"dashboard",\s*tab:\s*"scheduled"\s*\}/);
  assert.match(dashboardTabRailSource, /\{\s*kind:\s*"dashboard",\s*tab:\s*"soul"\s*\}/);
  assert.match(dashboardTabRailSource, /\{\s*kind:\s*"dashboard",\s*tab:\s*"skills"\s*\}/);
  assert.match(dashboardTabRailSource, /\{\s*kind:\s*"dashboard",\s*tab:\s*"mcp"\s*\}/);
  assert.match(dashboardTabRailSource, /tab === "soul"/);
  assert.doesNotMatch(source, /type SettingsNavItem/);
  assert.doesNotMatch(source, /const\s+settingsTabs\s*=/);
  assert.doesNotMatch(source, /const\s+dashboardLinkTabs\s*=/);
  assert.doesNotMatch(source, /<ExtensionsOverview/);
  assert.doesNotMatch(source, /<Match when=\{activeTab\(\) === "extensions"\}>/);
  assert.doesNotMatch(source, /if \(props\.developerMode\) tabs\.push\("advanced", "debug"\);/);
  assert.match(source, /<Match when=\{activeTab\(\) === "archived"\}>/);
  assert.doesNotMatch(source, /<Match when=\{activeTab\(\) === "model"\}>/);
  assert.match(source, /<Match when=\{activeTab\(\) === "advanced"\}>/);
  assert.match(source, /const\s+showGeneralUpdateControls\s*=\s*createMemo\s*\(\s*\(\)\s*=>/);
  assert.match(source, /const\s+generalUpdateLabel\s*=\s*createMemo\s*\(\s*\(\)\s*=>/);
  assert.match(source, /const\s+generalUpdateActionLabel\s*=\s*createMemo\s*\(\s*\(\)\s*=>/);
  assert.match(source, /const\s+handleGeneralUpdateAction\s*=\s*\(\)\s*=>/);
  assert.match(
    generalSection,
    /<Show when=\{showGeneralUpdateControls\(\)\}>[\s\S]*generalUpdateLabel\(\)[\s\S]*generalUpdateActionLabel\(\)[\s\S]*onClick=\{handleGeneralUpdateAction\}[\s\S]*translate\("settings\.appearance_title"\)/,
  );
  assert.match(generalSection, /translate\("settings\.appearance_title"\)/);
  assert.match(generalSection, /translate\("settings\.appearance_hint"\)/);
  assert.match(generalSection, /translate\("settings\.theme_system"\)/);
  assert.match(generalSection, /translate\("settings\.theme_light"\)/);
  assert.match(generalSection, /translate\("settings\.theme_dark"\)/);
  assert.doesNotMatch(generalSection, /System mode follows your OS preference automatically\./);
  assert.match(
    generalSection,
    /<Show when=\{props\.developerMode\}>[\s\S]*ui\.literal\.ai_access_1fcmzn[\s\S]*ui\.literal\.provider_and_model_assignment_is_managed_by__ekvlg6/,
  );
  assert.doesNotMatch(generalSection, /settings\.archived_sessions_label/);
});

test("settings no longer offers a developer mode entry point", () => {
  assert.doesNotMatch(source, /toggleDeveloperMode/);
  assert.doesNotMatch(generalSection, /Developer mode|Enable Developer Mode|Disable Developer Mode/);
  assert.doesNotMatch(generalSection, /Developer panel enabled\.|Enable this to access the Developer panel\./);
  assert.doesNotMatch(appSource, /setDeveloperMode/);
  assert.doesNotMatch(appSource, /veslo\.developerMode/);
});

test("settings keeps compact update controls in general instead of a floating toolbar layout", () => {
  assert.doesNotMatch(
    source,
    /flex flex-col gap-3 md:flex-row md:items-center md:justify-between rounded-2xl border border-gray-6\/40 bg-gray-1\/40 px-3 py-2/,
  );
  assert.doesNotMatch(source, /updateToolbarLabel\(\)|updateToolbarActionLabel\(\)|handleUpdateToolbarAction/);
  assert.match(source, /translate\("settings\.check_update"\)/);
  assert.match(source, /translate\("settings\.download_update"\)/);
  assert.match(source, /translate\("settings\.install_restart"\)/);
  assert.match(source, /settings\.sidebar_update_preparing/);
  assert.match(source, /updateState\(\) === "available" && props\.updateAutoDownload/);
  assert.match(generalUpdateControlsRow, /settings\.auto_update_label/, "general update action row should include the automatic update download switch");
  assert.match(generalUpdateControlsRow, /onClick=\{props\.toggleUpdateAutoDownload\}/);
  assert.doesNotMatch(source, /settings\.auto_update_hint/, "settings should not explain the automatic update download switch inline");
  assert.doesNotMatch(source, /settings\.automatic_checks_label|settings\.automatic_checks_hint/);
  assert.doesNotMatch(source, /props\.updateAutoCheck|props\.toggleUpdateAutoCheck/);
  assert.match(
    generalSection,
    /<Show when=\{showGeneralUpdateControls\(\)\}>[\s\S]*onClick=\{props\.toggleUpdateAutoDownload\}/,
    "general settings update card should wire the automatic update download switch",
  );
  assert.match(
    source,
    /if \(updateState\(\) === "available" && !props\.updateAutoDownload\) \{[\s\S]*?props\.downloadUpdate\(\);/,
  );
  assert.match(source, /settings\.pause_update_download/);
  assert.match(source, /updateState\(\) === "downloading" && props\.updateAutoDownload/);
  assert.match(source, /if \(updateState\(\) === "downloading" && props\.updateAutoDownload\) \{[\s\S]*?props\.toggleUpdateAutoDownload\(\);/);
  assert.doesNotMatch(source, /"Checking for updates"|"Up to date"|"Check"|"Download"|"Install"|"Retry"|"Last checked"/);
});

test("settings does not expose automatic context compaction as a menu option", () => {
  assert.doesNotMatch(source, /ui\.literal\.auto_context_compaction_yefaae/);
  assert.doesNotMatch(source, /ui\.literal\.automatically_compact_after_a_run_completes_1cibgg/);
  assert.doesNotMatch(generalSection, /autoCompactContext|toggleAutoCompactContext/);
});

test("settings exposes updater download retry states", () => {
  assert.match(source, /settings\.update_retrying_download/);
  assert.match(source, /settings\.update_retrying_in/);
  assert.match(source, /settings\.update_download_failed/);
  assert.doesNotMatch(source, /formatRelativeTime\(retry\.nextRetryAt\)/);
  assert.match(source, /retry\.nextRetryAt\s*-\s*Date\.now\(\)/);
  assert.match(source, /props\.retryUpdateDownload\(\)/);
});

test("settings locales include Settings and dashboard labels", () => {
  assert.match(enLocaleSource, /"settings\.archived": "Archived"/);
  assert.match(csLocaleSource, /"settings\.archived": "Archivované"/);
  assert.doesNotMatch(dashboardTabRailSource, /case\s+"scheduled":(?:(?!\s*(?:case\s+"|default\s*:))[\s\S])*t\("nav\.automations", currentLocale\(\)\)/);
  assert.match(dashboardTabRailSource, /case\s+"soul":(?:(?!\s*(?:case\s+"|default\s*:))[\s\S])*t\("nav\.soul", currentLocale\(\)\)/);
  assert.match(dashboardTabRailSource, /case\s+"skills":(?:(?!\s*(?:case\s+"|default\s*:))[\s\S])*t\("nav\.skills", currentLocale\(\)\)/);
  assert.match(dashboardTabRailSource, /case\s+"mcp":(?:(?!\s*(?:case\s+"|default\s*:))[\s\S])*t\("nav\.extensions", currentLocale\(\)\)/);
  assert.match(dashboardTabRailSource, /data-settings-nav-kind=\{item\.kind\}/);
  assert.match(dashboardTabRailSource, /data-settings-nav-tab=\{item\.tab\}/);
});
