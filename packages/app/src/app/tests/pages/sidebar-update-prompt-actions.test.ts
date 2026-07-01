import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(new URL("../../pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const appViewPropsSource = readFileSync(new URL("../../app-view-props.ts", import.meta.url), "utf8");
const enLocale = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");
const csLocale = readFileSync(new URL("../../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhLocale = readFileSync(new URL("../../../i18n/locales/zh.ts", import.meta.url), "utf8");

const dashboardLeftSidebarStart = dashboardSource.indexOf("<Show when={leftSidebarVisible()}>");
const dashboardMainStart = dashboardSource.indexOf('<main class="flex-1 flex flex-col overflow-hidden bg-dls-surface pt-12">');
const dashboardLeftSidebar =
  dashboardLeftSidebarStart >= 0 && dashboardMainStart >= 0
    ? dashboardSource.slice(dashboardLeftSidebarStart, dashboardMainStart)
    : "";

test("left-menu update prompts expose direct download and update actions", () => {
  assert.match(dashboardSource, /settings\.sidebar_download_update/);
  assert.match(dashboardSource, /settings\.sidebar_install_update/);
  assert.match(dashboardLeftSidebar, /updatePillActionLabel\(\)/);
  assert.match(dashboardLeftSidebar, /props\.downloadUpdate\(\)/);
  assert.match(dashboardLeftSidebar, /props\.installUpdateAndRestart\(\)/);

  assert.match(sessionSource, /downloadUpdate: \(\) => void;/);
  assert.match(sessionSource, /settings\.sidebar_download_update/);
  assert.match(sessionSource, /settings\.sidebar_install_update/);
  assert.match(sessionSource, /updatePillActionLabel\(\)/);
  assert.match(sessionSource, /props\.downloadUpdate\(\)/);
  assert.match(sessionSource, /props\.installUpdateAndRestart\(\)/);
});

test("left-menu manual download action is only exposed when auto-download is disabled", () => {
  assert.match(dashboardSource, /state === "available" && !props\.updateAutoDownload/);
  assert.match(sessionSource, /state === "available" && !props\.updateAutoDownload/);
  assert.match(sessionSource, /updateAutoDownload: boolean;/);
  assert.match(appViewPropsSource, /updateAutoDownload: updateAutoDownload\(\)/);
  assert.match(dashboardSource, /updateAutoDownload={props\.updateAutoDownload}/);
});

test("left-menu update prompts expose exhausted download retry", () => {
  assert.match(dashboardSource, /state === "error"[\s\S]*retry\?\.kind === "exhausted"/);
  assert.match(sessionSource, /state === "error"[\s\S]*retry\?\.kind === "exhausted"/);
  assert.match(dashboardSource, /props\.retryUpdateDownload\(\)/);
  assert.match(sessionSource, /props\.retryUpdateDownload\(\)/);
});

test("left-menu update action copy is localized", () => {
  for (const source of [enLocale, csLocale, zhLocale]) {
    assert.match(source, /"settings\.sidebar_download_update"/);
    assert.match(source, /"settings\.sidebar_install_update"/);
    assert.match(source, /"settings\.sidebar_update_available"/);
    assert.match(source, /"settings\.sidebar_update_ready"/);
  }
});

test("left-menu preparing update copy is localized", () => {
  for (const source of [enLocale, csLocale, zhLocale]) {
    assert.match(source, /"settings\.sidebar_update_preparing"/);
  }
  assert.match(dashboardSource, /settings\.sidebar_update_preparing/);
  assert.match(sessionSource, /settings\.sidebar_update_preparing/);
});

test("updater retry copy is localized", () => {
  for (const source of [enLocale, csLocale, zhLocale]) {
    assert.match(source, /"settings\.update_retrying_download"/);
    assert.match(source, /"settings\.update_retrying_in"/);
    assert.match(source, /"settings\.update_download_failed"/);
    assert.match(source, /"settings\.retry_update_download"/);
  }
});
