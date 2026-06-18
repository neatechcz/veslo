import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

const sourceBetween = (source: string, startNeedle: string, endNeedle: string) => {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `source should contain ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `source should contain ${endNeedle} after ${startNeedle}`);
  return source.slice(start, end);
};

test("rename routes through the selected session workspace scope", () => {
  const source = sourceBetween(
    appSource,
    "  async function renameSessionTitle(",
    "  async function deleteSessionById(",
  );

  assert.match(source, /resolveSelectedSessionBrowseScope\(sessionID\)\?\.workspaceId/);
  assert.match(source, /await renameSession\(sessionID, trimmed, targetWorkspaceId \|\| undefined\)/);
  assert.doesNotMatch(source, /await renameSession\(sessionID, trimmed\);/);
});

test("delete uses the explicit or selected session workspace client", () => {
  const source = sourceBetween(
    appSource,
    "  async function deleteSessionById(",
    "  async function listAgents()",
  );

  assert.match(source, /resolveSelectedSessionBrowseScope\(trimmed\)\?\.workspaceId/);
  assert.match(source, /const c = routedClient\(workspaceId\);/);
  assert.doesNotMatch(source, /const c = routedClient\(\);/);
});
