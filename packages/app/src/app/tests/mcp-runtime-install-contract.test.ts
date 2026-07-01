import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowSource = readFileSync(new URL("../context/mcp-connection-workflow.ts", import.meta.url), "utf8");
const storeSource = readFileSync(new URL("../context/extensions.ts", import.meta.url), "utf8");

test("catalog MCP install refreshes MCP state after workspace config write", () => {
  const buildConfigSource = workflowSource.match(/function buildMcpAddConfig[\s\S]*?async function startServerManagedMcpOAuth/)?.[0] ?? "";
  const activateSource = workflowSource.match(/async function activateInstalledMcp[\s\S]*?async function connectMcp/)?.[0] ?? "";

  assert.match(workflowSource, /await deps\.refreshMcpServers\(\{ mode: "explicit", reason: "mcp-activate-installed" \}\)/);
  assert.match(workflowSource, /activeClient\.mcp\.add/);
  assert.match(workflowSource, /installHubMcpAndActivate/);
  assert.equal(buildConfigSource.length > 0, true);
  assert.match(
    buildConfigSource,
    /const oauth:[\s\S]*=\s*entry\.oauth === false \? false : typeof entry\.oauth === "object" \? entry\.oauth : \{\};[\s\S]*oauth,/,
  );
  assert.match(buildConfigSource, /entry\.headers \? \{ headers: entry\.headers \} : \{\}/);
  assert.doesNotMatch(buildConfigSource, /entry\.oauth\s*\?\s*\{\}\s*:\s*false/);
  assert.match(workflowSource, /async function startServerManagedMcpOAuth/);
  assert.match(workflowSource, /entry\.authorization\?\.type !== "veslo-server-oauth"/);
  assert.match(workflowSource, /Authorization: `Bearer \$\{denToken\}`/);
  assert.match(workflowSource, /await deps\.openDesktopAuthUrl\(payload\.authorizeUrl\)/);
  assert.match(activateSource, /if \(await startServerManagedMcpOAuth\(entry\)\)[\s\S]*\} else if \(entry\.oauth\)/);
  assert.match(
    workflowSource,
    /if \(entry\.authorization\?\.type === "veslo-server-oauth"\) \{[\s\S]*reason: "hub-mcp-server-oauth-installed"[\s\S]*await startServerManagedMcpOAuth\(entry\)[\s\S]*return result;[\s\S]*await activateInstalledMcp/,
  );
});

test("extensions store still reads den auth before hub MCP install", () => {
  assert.match(storeSource, /readDenAuth\(\)/);
  assert.match(storeSource, /installHubMcp/);
});
