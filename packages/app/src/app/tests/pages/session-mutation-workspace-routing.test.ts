import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
const mutationWorkflowSource = readFileSync(new URL("../../pages/session-mutation-workflow.ts", import.meta.url), "utf8");

const sourceBetween = (source: string, startNeedle: string, endNeedle: string) => {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `source should contain ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.notEqual(end, -1, `source should contain ${endNeedle} after ${startNeedle}`);
  return source.slice(start, end);
};

test("rename routes through the authoritative send-target workspace scope", () => {
  const source = sourceBetween(mutationWorkflowSource, "  async function renameSessionTitle(", "  async function deleteSessionById(");

  assert.match(source, /const targetWorkspaceId =\s*deps\.resolveSendTargetWorkspaceScope\(sessionID\)\?\.workspaceId\?\.trim\(\) \|\|\s*"";/);
  assert.match(source, /await deps\.renameSession\(sessionID, trimmed, targetWorkspaceId\)/);
  assert.doesNotMatch(source, /deps\.resolveSelectedSessionBrowseScope\(sessionID\)/);
  assert.doesNotMatch(source, /await deps\.renameSession\(sessionID, trimmed\);/);
});

test("delete uses the explicit or authoritative send-target workspace client", () => {
  const source = sourceBetween(mutationWorkflowSource, "  async function deleteSessionById(", "  async function listAgents()");

  assert.match(source, /const sendTargetWorkspace = deps\.resolveSendTargetWorkspaceScope\(trimmed\);/);
  assert.match(source, /const workspaceId =[\s\S]*\(workspaceID \?\? ""\)\.trim\(\) \|\|[\s\S]*sendTargetWorkspace\?\.workspaceId\?\.trim\(\) \|\|/);
  assert.match(source, /const c = deps\.routedClient\(workspaceId\);/);
  assert.doesNotMatch(source, /deps\.resolveSelectedSessionBrowseScope\(trimmed\)/);
  assert.doesNotMatch(source, /const c = deps\.routedClient\(\);/);
});
