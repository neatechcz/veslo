import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");
const enLocaleSource = readFileSync(new URL("../../i18n/locales/en.ts", import.meta.url), "utf8");
const csLocaleSource = readFileSync(new URL("../../i18n/locales/cs.ts", import.meta.url), "utf8");
const generalSection = source.match(/<Match when=\{activeTab\(\) === "general"\}>[\s\S]*?<\/Match>/)?.[0] ?? "";

test("settings exposes archived and model tabs with the expected content split", () => {
  assert.match(source, /const tabs: SettingsTab\[\] = \["general", "archived"\]/);
  assert.match(source, /if \(props\.developerMode\) tabs\.push\("debug"\);/);
  assert.match(source, /<Match when=\{activeTab\(\) === "archived"\}>/);
  assert.match(generalSection, /translate\("settings\.appearance_title"\)/);
  assert.match(generalSection, /translate\("settings\.appearance_hint"\)/);
  assert.match(generalSection, /translate\("settings\.theme_system"\)/);
  assert.match(generalSection, /translate\("settings\.theme_light"\)/);
  assert.match(generalSection, /translate\("settings\.theme_dark"\)/);
  assert.doesNotMatch(generalSection, /System mode follows your OS preference automatically\./);
  assert.doesNotMatch(generalSection, /Providers/);
  assert.doesNotMatch(generalSection, /settings\.archived_sessions_label/);
});

test("settings removes the compact update controls from the body layout", () => {
  assert.doesNotMatch(
    source,
    /flex flex-col gap-3 md:flex-row md:items-center md:justify-between rounded-2xl border border-gray-6\/40 bg-gray-1\/40 px-3 py-2/,
  );
  assert.doesNotMatch(source, /updateToolbarLabel\(\)|updateToolbarActionLabel\(\)|handleUpdateToolbarAction/);
  assert.doesNotMatch(generalSection, /settings\.check_update|settings\.download_update|settings\.install_restart/);
  assert.doesNotMatch(source, /"Checking for updates"|"Up to date"|"Check"|"Download"|"Install"|"Retry"|"Last checked"/);
});

test("settings locales include the archived tab label", () => {
  assert.match(enLocaleSource, /"settings\.archived": "Archived"/);
  assert.match(csLocaleSource, /"settings\.archived": "Archivované"/);
});
