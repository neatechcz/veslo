import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./artifacts-panel.tsx", import.meta.url), "utf8");

test("artifact file rows expose a tooltip for the filename", () => {
  assert.match(
    source,
    /<div class="truncate text-xs font-medium text-gray-11" title=\{displayTitle\(\)\}>/,
    "artifacts panel should expose the full filename on the title row tooltip",
  );
});

test("artifact file rows expose a tooltip for the directory subtitle", () => {
  assert.match(
    source,
    /<div class="truncate text-\[11px\] text-gray-9" title=\{subtitle\(\)\}>/,
    "artifacts panel should expose the directory subtitle on the tooltip",
  );
});

test("artifact file rows stack filename, tags, then directory", () => {
  assert.match(
    source,
    /<div class="min-w-0 flex-1 space-y-1">[\s\S]*?<div class="truncate text-xs font-medium text-gray-11" title=\{displayTitle\(\)\}>[\s\S]*?<div class="flex flex-wrap items-center gap-1\.5">[\s\S]*?<Show when=\{subtitle\(\)\}>[\s\S]*?<div class="truncate text-\[11px\] text-gray-9" title=\{subtitle\(\)\}>/,
    "artifacts rows should render filename above tags and directory below tags",
  );
});

test("artifacts panel renders localized modified and opened file groups", () => {
  assert.match(
    source,
    /data-testid=\{props\.testId\}/,
    "file groups should render their stable test id",
  );
  assert.match(
    source,
    /testId="session-artifact-files-modified"/,
    "modified file group should expose a stable test id",
  );
  assert.match(
    source,
    /testId="session-artifact-files-opened"/,
    "opened file group should expose a stable test id",
  );
  assert.match(
    source,
    /tr\("session\.artifact_files_modified"\)/,
    "modified file group heading should be localized",
  );
  assert.match(
    source,
    /tr\("session\.artifact_files_opened"\)/,
    "opened file group heading should be localized",
  );
});

test("file artifact rows use file interaction status labels", () => {
  assert.match(
    source,
    /fileStatusLabel/,
    "file artifact rows should use a dedicated status label helper",
  );
  assert.match(
    source,
    /item\.fileInteraction === "modified"/,
    "modified files should use the modified interaction label",
  );
  assert.match(
    source,
    /item\.fileInteraction === "opened"/,
    "opened files should use the opened interaction label",
  );
});

test("file groups fall back to file artifact kind when interaction metadata is absent", () => {
  assert.match(
    source,
    /fileGroupInteraction/,
    "file grouping should use a helper that can handle missing optional metadata",
  );
  assert.match(
    source,
    /item\.kind === "file_output"/,
    "legacy file output rows without fileInteraction should still render as modified",
  );
  assert.match(
    source,
    /item\.kind === "file_discovered"/,
    "legacy discovered file rows without fileInteraction should still render as opened",
  );
  assert.match(
    source,
    /modifiedFiles = \(\) => family\.items\.filter\(\(item\) => fileGroupInteraction\(item\) === "modified"\)/,
    "modified group should use the fallback-aware interaction helper",
  );
  assert.match(
    source,
    /openedFiles = \(\) => family\.items\.filter\(\(item\) => fileGroupInteraction\(item\) === "opened"\)/,
    "opened group should use the fallback-aware interaction helper",
  );
});

test("artifacts panel uses i18n keys instead of hardcoded English labels", () => {
  assert.match(source, /tr\("session\.artifacts"\)/, "artifacts heading should be localized");
  assert.match(source, /tr\("session\.no_artifacts"\)/, "empty-state message should be localized");
  assert.match(source, /tr\("session\.reveal"\)/, "reveal button should be localized");
  assert.match(source, /tr\("session\.artifact_status_updated"\)/, "updated status should be localized");
  assert.match(source, /tr\("session\.artifact_family_files"\)/, "Files family label should be localized");
  assert.match(source, /tr\("session\.artifact_files_modified"\)/, "Modified file group should be localized");
  assert.match(source, /tr\("session\.artifact_files_opened"\)/, "Opened file group should be localized");
});
