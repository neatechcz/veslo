import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionsSource = readFileSync(new URL("../context/extensions.ts", import.meta.url), "utf8");
const mcpSource = readFileSync(new URL("../pages/mcp.tsx", import.meta.url), "utf8");

test("extensions store wires hub mcp auth and actions", () => {
  const refreshHubMcpSource = extensionsSource.match(/async function refreshHubMcp[\s\S]*?async function refreshHubSkills/)?.[0] ?? "";
  const noAuthBranchSource = refreshHubMcpSource.match(/if \(!denToken \|\| !denOrgId\)\s*\{[\s\S]*?return;/)?.[0] ?? "";

  assert.match(extensionsSource, /readDenAuth\(\)/);
  assert.match(extensionsSource, /listHubMcp/);
  assert.match(extensionsSource, /installHubMcp/);
  assert.match(extensionsSource, /hubMcpCards/);
  assert.match(refreshHubMcpSource, /translate\("mcp\.org_catalog_placeholder"\)/);
  assert.doesNotMatch(refreshHubMcpSource, /translate\("skills\.org_catalog_placeholder"\)/);
  assert.equal(noAuthBranchSource.length > 0, true);
  assert.doesNotMatch(noAuthBranchSource, /hubMcpLoaded = true/);
});

test("mcp page renders hub mcp catalog entries after built-in quick connect", () => {
  assert.match(mcpSource, /props\.hubMcpCards/);
  assert.match(mcpSource, /props\.refreshHubMcp/);
  assert.match(mcpSource, /props\.installHubMcp/);
  assert.match(mcpSource, /props\.quickConnect/);
});
