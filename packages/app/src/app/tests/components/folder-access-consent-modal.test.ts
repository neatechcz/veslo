import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const sourceUrl = new URL("../../components/folder-access-consent-modal.tsx", import.meta.url);
const source = existsSync(sourceUrl) ? readFileSync(sourceUrl, "utf8") : "";
const enSource = readFileSync(new URL("../../../i18n/locales/en.ts", import.meta.url), "utf8");
const csSource = readFileSync(new URL("../../../i18n/locales/cs.ts", import.meta.url), "utf8");
const zhSource = readFileSync(new URL("../../../i18n/locales/zh.ts", import.meta.url), "utf8");

const localeKeys = [
  "folder_access.title",
  "folder_access.body_intro",
  "folder_access.requested_path_label",
  "folder_access.access_label",
  "folder_access.access_read_only",
  "folder_access.duration_label",
  "folder_access.duration_workspace",
  "folder_access.picker_guidance",
  "folder_access.choose_folder",
  "folder_access.cancel",
  "folder_access.invalid_selection",
] as const;

test("folder access consent modal exports the approved prompt contract", () => {
  assert.match(source, /export type FolderAccessConsentModalProps = \{/);
  assert.match(source, /open: boolean/);
  assert.match(source, /requestedPath: string/);
  assert.match(source, /pickerStartPath: string/);
  assert.match(source, /accessMode: "read"/);
  assert.match(source, /duration: "workspace"/);
  assert.match(source, /error\?: string \| null/);
  assert.match(source, /onChooseFolder: \(\) => void/);
  assert.match(source, /onCancel: \(\) => void/);
});

test("folder access consent modal renders stable test hooks for the consent workflow", () => {
  for (const testId of [
    "folder-access-consent-modal",
    "folder-access-requested-path",
    "folder-access-mode",
    "folder-access-duration",
    "folder-access-picker-start",
    "folder-access-choose-folder",
    "folder-access-cancel",
  ]) {
    assert.match(source, new RegExp(`data-testid="${testId}"`));
  }
});

test("folder access consent modal surfaces request details before opening the picker", () => {
  assert.match(source, /props\.requestedPath/);
  assert.match(source, /props\.pickerStartPath/);
  assert.match(source, /props\.accessMode === "read"/);
  assert.match(source, /props\.duration === "workspace"/);
  assert.match(source, /<ModalError[\s\S]*props\.error/);
  assert.match(source, /onClick=\{props\.onChooseFolder\}/);
  assert.match(source, /onClick=\{props\.onCancel\}/);
});

test("folder access consent modal traps focus while the prompt is open", () => {
  assert.match(source, /import \{ useFocusTrap \} from "\.\/use-modal-focus"/);
  assert.match(source, /let dialogRef: HTMLDivElement \| undefined/);
  assert.match(source, /let chooseFolderRef: HTMLButtonElement \| undefined/);
  assert.match(source, /useFocusTrap\(\(\) => props\.open/);
  assert.match(source, /getInitialFocus: \(\) => chooseFolderRef/);
  assert.match(source, /ref=\{dialogRef\}/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /ref=\{chooseFolderRef\}/);
});

test("folder access consent modal localizes all prompt copy in current locales", () => {
  assert.match(source, /currentLocale/);
  assert.match(source, /t\(key, currentLocale\(\)\)/);
  for (const key of localeKeys) {
    assert.match(source, new RegExp(`translate\\("${key}"\\)`));
    assert.match(enSource, new RegExp(`"${key}":`));
    assert.match(csSource, new RegExp(`"${key}":`));
    assert.match(zhSource, new RegExp(`"${key}":`));
  }
});
