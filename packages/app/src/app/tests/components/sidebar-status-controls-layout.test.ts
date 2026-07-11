import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../components/sidebar-status-controls.tsx", import.meta.url), "utf8");

test("sidebar status controls form one flat metadata row below a hairline divider", () => {
  assert.match(source, /class="mt-2 border-t border-dls-border pt-2"/);
  assert.match(
    source,
    /class="h-7 w-7 inline-flex items-center justify-center rounded-md border-0 bg-transparent text-gray-a8[^"]*hover:bg-cyan-a3 hover:text-dls-accent/,
    "settings should be a muted ghost control with an accent hover",
  );
  assert.match(
    source,
    /data-testid="sidebar-connection-status-button"[\s\S]*class="h-7 w-7 inline-flex items-center justify-center rounded-md border-0 bg-transparent[^"]*hover:bg-cyan-a3"/,
    "status should sit flat in the bottom row while keeping its round status dot",
  );
  assert.match(
    source,
    /class="h-7 w-full min-w-0 inline-flex items-center gap-1\.5 rounded-md border-0 bg-transparent[^"]*font-mono text-\[11\.5px\] text-gray-a9/,
    "account email should read as mono metadata instead of a bordered chip",
  );
  assert.match(source, /<span class=\{`h-2 w-2 rounded-full \$\{unifiedStatusMeta\(\)\.dot\}`\} \/>/);
});
