import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const storeSource = readFileSync(new URL("./context/extensions.ts", import.meta.url), "utf8");

test("catalog MCP install refreshes MCP state after workspace config write", () => {
  assert.match(appSource, /await refreshMcpServers\(\)/);
  assert.match(appSource, /activeClient\.mcp\.add/);
  assert.match(appSource, /installHubMcpAndActivate/);
});

test("extensions store still reads den auth before hub MCP install", () => {
  assert.match(storeSource, /readDenAuth\(\)/);
  assert.match(storeSource, /installHubMcp/);
});
