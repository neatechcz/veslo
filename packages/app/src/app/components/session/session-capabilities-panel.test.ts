import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./session-capabilities-panel.tsx", import.meta.url), "utf8");

test("session capabilities panel renders Skills and MCP sections with test ids", () => {
  assert.match(source, /data-testid="session-capabilities-panel"/);
  assert.match(source, /data-testid="session-capabilities-skills"/);
  assert.match(source, /data-testid="session-capabilities-mcp"/);
  assert.match(source, /session\.capabilities_skills/);
  assert.match(source, /session\.capabilities_mcp/);
});
