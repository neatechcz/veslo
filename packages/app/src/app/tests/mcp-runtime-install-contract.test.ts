import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const storeSource = readFileSync(new URL("../context/extensions.ts", import.meta.url), "utf8");

test("catalog MCP install refreshes MCP state after workspace config write", () => {
  const buildConfigSource = appSource.match(/function buildMcpAddConfig[\s\S]*?async function activateInstalledMcp/)?.[0] ?? "";

  assert.match(appSource, /await refreshMcpServers\(\{ mode: "explicit", reason: "mcp-activate-installed" \}\)/);
  assert.match(appSource, /activeClient\.mcp\.add/);
  assert.match(appSource, /installHubMcpAndActivate/);
  assert.equal(buildConfigSource.length > 0, true);
  assert.match(
    buildConfigSource,
    /const oauth:[\s\S]*=\s*entry\.oauth\s*\?\s*\{\}\s*:\s*false;[\s\S]*oauth,/,
  );
});

test("extensions store still reads den auth before hub MCP install", () => {
  assert.match(storeSource, /readDenAuth\(\)/);
  assert.match(storeSource, /installHubMcp/);
});
