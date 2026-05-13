import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const enLocaleSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const csLocaleSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const generalSection = source.match(/<Match when=\{activeTab\(\) === "general"\}>[\s\S]*?<\/Match>/)?.[0] ?? "";

test("settings exposes archived tab and keeps developer tabs unavailable", () => {
  assert.match(source, /const tabs: SettingsTab\[\] = \["general", "extensions", "archived"\]/);
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
    /<Show when=\{props\.developerMode\}>[\s\S]*>AI access<[\s\S]*managed by the platform admin/i,
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
  assert.match(
    source,
    /if \(updateState\(\) === "available" && !props\.updateAutoDownload\) \{[\s\S]*?props\.downloadUpdate\(\);/,
  );
  assert.doesNotMatch(source, /"Checking for updates"|"Up to date"|"Check"|"Download"|"Install"|"Retry"|"Last checked"/);
});

test("settings locales include the archived tab label", () => {
  assert.match(enLocaleSource, /"settings\.archived": "Archived"/);
  assert.match(csLocaleSource, /"settings\.archived": "Archivované"/);
});
