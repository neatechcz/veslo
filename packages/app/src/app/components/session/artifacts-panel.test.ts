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

test("artifacts panel uses i18n keys instead of hardcoded English labels", () => {
  assert.match(source, /tr\("session\.artifacts"\)/, "artifacts heading should be localized");
  assert.match(source, /tr\("session\.no_artifacts"\)/, "empty-state message should be localized");
  assert.match(source, /tr\("session\.reveal"\)/, "reveal button should be localized");
  assert.match(source, /tr\("session\.artifact_status_updated"\)/, "updated status should be localized");
  assert.match(source, /tr\("session\.artifact_family_files"\)/, "Files family label should be localized");
});
