import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const storeSource = readFileSync(new URL("../context/extensions.ts", import.meta.url), "utf8");

test("catalog MCP install refreshes MCP state after workspace config write", () => {
  const buildConfigSource = appSource.match(/function buildMcpAddConfig[\s\S]*?async function activateInstalledMcp/)?.[0] ?? "";
  const activateSource = appSource.match(/async function activateInstalledMcp[\s\S]*?async function connectMcp/)?.[0] ?? "";

  assert.match(appSource, /await refreshMcpServers\(\{ mode: "explicit", reason: "mcp-activate-installed" \}\)/);
  assert.match(appSource, /activeClient\.mcp\.add/);
  assert.match(appSource, /installHubMcpAndActivate/);
  assert.equal(buildConfigSource.length > 0, true);
  assert.match(
    buildConfigSource,
    /const oauth:[\s\S]*=\s*entry\.oauth === false \? false : typeof entry\.oauth === "object" \? entry\.oauth : \{\};[\s\S]*oauth,/,
  );
  assert.match(buildConfigSource, /entry\.headers \? \{ headers: entry\.headers \} : \{\}/);
  assert.doesNotMatch(buildConfigSource, /entry\.oauth\s*\?\s*\{\}\s*:\s*false/);
  assert.match(appSource, /async function startServerManagedMcpOAuth/);
  assert.match(appSource, /entry\.authorization\?\.type !== "veslo-server-oauth"/);
  assert.match(appSource, /Authorization: `Bearer \$\{denToken\}`/);
  assert.match(appSource, /await openDesktopAuthUrl\(payload\.authorizeUrl\)/);
  assert.match(activateSource, /if \(await startServerManagedMcpOAuth\(entry\)\)[\s\S]*\} else if \(entry\.oauth\)/);
  assert.match(
    appSource,
    /if \(entry\.authorization\?\.type === "veslo-server-oauth"\) \{[\s\S]*reason: "hub-mcp-server-oauth-installed"[\s\S]*await startServerManagedMcpOAuth\(entry\)[\s\S]*return result;[\s\S]*await activateInstalledMcp/,
  );
});

test("extensions store still reads den auth before hub MCP install", () => {
  assert.match(storeSource, /readDenAuth\(\)/);
  assert.match(storeSource, /installHubMcp/);
});
