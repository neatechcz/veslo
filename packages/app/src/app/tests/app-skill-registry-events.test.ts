import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

function extractArrowObjectPropertyBody(text: string, propertyName: string): string {
  const propertyIndex = text.indexOf(`${propertyName}:`);
  assert.notEqual(propertyIndex, -1, `Expected ${propertyName} callback to exist`);

  const arrowIndex = text.indexOf("=>", propertyIndex);
  assert.notEqual(arrowIndex, -1, `Expected ${propertyName} to use an arrow callback`);

  const bodyStart = text.indexOf("{", arrowIndex);
  assert.notEqual(bodyStart, -1, `Expected ${propertyName} arrow callback to have a block body`);

  let depth = 0;
  for (let index = bodyStart; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(bodyStart, index + 1);
      }
    }
  }

  assert.fail(`Could not find end of ${propertyName} callback body`);
}

test("app wires registry event polling into skill inventory and materialization handling", () => {
  const workspacePendingHandler = extractArrowObjectPropertyBody(source, "onWorkspaceUpdatePending");
  const globalUpdateHandler = extractArrowObjectPropertyBody(source, "onGlobalUpdate");

  assert.match(
    source,
    /createSkillRegistryEventsListener/,
    "App should create the registry event listener",
  );
  assert.match(
    source,
    /extensionsStore\.invalidateSkillRegistryInventory\(\)/,
    "Registry events should invalidate skill inventory through the extensions store",
  );
  assert.match(
    workspacePendingHandler,
    /workspaceStore\.workspaceBusy\(\)\[update\.workspaceId\][\s\S]*syncWorkspaceSkillMaterialization\(update\.workspaceId,\s*\{[\s\S]*skillRegistryMaterializationAuthContext\(\)[\s\S]*activeRun: true[\s\S]*\}\)/s,
    "Active workspace updates must request pending materialization instead of mutating files under a running session",
  );
  assert.match(
    workspacePendingHandler,
    /queuePendingSkillRegistryWorkspaceReplay\(update\.workspaceId,\s*update\.event\.id\)/,
    "Active workspace updates under a running session should be replayed after the run is idle",
  );
  assert.match(
    source,
    /setPendingSkillRegistryWorkspaceReplays/,
    "Workspace registry replay state should be persisted until the workspace becomes idle",
  );
  assert.match(
    workspacePendingHandler,
    /syncWorkspaceSkillMaterialization\(\s*update\.workspaceId,\s*[\s\S]*skillRegistryMaterializationAuthContext\(\)[\s\S]*\)[\s\S]*refreshAfterSkillRegistryMaterialization\(result\)/s,
    "Active workspace updates with no running session should materialize immediately and refresh skills",
  );
  assert.match(
    globalUpdateHandler,
    /syncGlobalSkillMaterialization\(\{[\s\S]*skillRegistryMaterializationAuthContext\(\)[\s\S]*activeRun: true[\s\S]*\}\)[\s\S]*setPendingGlobalSkillRegistryReplay/s,
    "Global registry updates under active runs should request pending materialization and store a global replay",
  );
  assert.match(
    globalUpdateHandler,
    /syncGlobalSkillMaterialization\(skillRegistryMaterializationAuthContext\(\)\)[\s\S]*refreshAfterSkillRegistryMaterialization\(result\)/s,
    "Global registry updates should use the global materialization API and refresh skills",
  );
  assert.match(
    source,
    /refreshAfterSkillRegistryMaterialization[\s\S]*refreshSkills\(\{\s*force: true\s*\}\)[\s\S]*extensionsStore\.invalidateSkillRegistryInventory\(\)/s,
    "Registry materialization changes should refresh skills and invalidate inventory",
  );
  assert.match(
    source,
    /markReloadRequired\("skills"/,
    "Active workspace registry updates should surface a skill reload prompt",
  );
  assert.match(
    source,
    /pendingSkillRegistryWorkspaceReplays\(\)/,
    "Pending workspace registry replay state should be observed reactively",
  );
  assert.match(
    source,
    /if\s*\(busyWorkspaces\[workspaceId\]\)\s*continue;[\s\S]*replayPendingSkillRegistryWorkspaceUpdate\(client,\s*workspaceId,\s*pending\)/s,
    "Pending workspace registry updates should wait until that workspace is no longer busy",
  );
  assert.match(
    source,
    /replayPendingSkillRegistryWorkspaceUpdate[\s\S]*syncWorkspaceSkillMaterialization\(\s*workspaceId,\s*[\s\S]*skillRegistryMaterializationAuthContext\(\)[\s\S]*\)/s,
    "Pending workspace registry updates should replay when that workspace is no longer busy",
  );
  assert.match(
    source,
    /pendingGlobalSkillRegistryReplay\(\)[\s\S]*Object\.values\(workspaceStore\.workspaceBusy\(\)\)\.some\(Boolean\)[\s\S]*syncGlobalSkillMaterialization\(skillRegistryMaterializationAuthContext\(\)\)/s,
    "Pending global registry updates should replay once every workspace is idle",
  );
  assert.match(
    source,
    /skillRegistryMaterializationAuthContext[\s\S]*denToken[\s\S]*denOrgId[\s\S]*denUserId/s,
    "Materialization sync calls should forward Den auth context for org workspace resolution",
  );
});
