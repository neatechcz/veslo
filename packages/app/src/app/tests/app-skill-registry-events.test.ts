import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const orchestratorSource = readFileSync(
  new URL("../context/skill-registry-orchestrator.ts", import.meta.url),
  "utf8",
);

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

test("app composes the skill registry event orchestrator after extension store setup", () => {
  assert.match(
    appSource,
    /import \{ createSkillRegistryOrchestrator \} from "\.\/context\/skill-registry-orchestrator";/,
    "App should import the skill registry orchestrator",
  );

  const extensionsStoreIndex = appSource.indexOf("const extensionsStore = createExtensionsStore");
  const orchestratorIndex = appSource.indexOf("createSkillRegistryOrchestrator({");
  assert.notEqual(extensionsStoreIndex, -1, "App should create the extensions store");
  assert.ok(
    orchestratorIndex > extensionsStoreIndex,
    "Skill registry orchestrator should be composed after the extensions store exists",
  );

  assert.match(
    appSource,
    /createSkillRegistryOrchestrator\(\{[\s\S]*vesloServerClient,[\s\S]*vesloServerStatus,[\s\S]*activeWorkspaceId:\s*\(\)\s*=>\s*workspaceStore\.activeWorkspaceId\(\),[\s\S]*workspaceBusy:\s*workspaceBusyForSkillRegistry,[\s\S]*denAuthRevision,[\s\S]*readDenAuth,[\s\S]*invalidateSkillRegistryInventory:\s*\(\)\s*=>\s*extensionsStore\.invalidateSkillRegistryInventory\(\),[\s\S]*markReloadRequired/s,
    "App should pass server connection, workspace, inventory, reload, and Den auth dependencies",
  );
  assert.match(
    appSource,
    /const workspaceBusyForSkillRegistry[\s\S]*sessionStatusById\(\)[\s\S]*conversationRunDiagnosticsBySessionKey\(\)[\s\S]*key\.indexOf\("\\0"\)[\s\S]*status\.trim\(\) === "idle"[\s\S]*"blocked"/,
    "Skill registry events should treat non-idle session state and blocked lifecycle diagnostics as active workspace runs",
  );
});

test("app keeps skill reload guard without legacy fallback auto-reload state", () => {
  assert.match(
    appSource,
    /import \{ createSkillReloadGuard \} from "\.\/lib\/skill-reload-guard";/,
    "App should keep the skill reload guard import",
  );
  assert.match(
    appSource,
    /createSkillReloadGuard\(\{[\s\S]*onFallbackNeeded:\s*\(trigger\)\s*=>\s*\{[\s\S]*lateMarkReloadRequired\.current\(\)\?\.\("skills",\s*trigger\);[\s\S]*\}/,
    "App should still surface the reload-required banner when hot reload does not arrive",
  );
  assert.match(
    appSource,
    /lateOnHotReloadApplied\.bind\(\(\)\s*=>\s*\{[\s\S]*skillReloadGuard\.hotReloadApplied\(\);[\s\S]*refreshSkills\(\{\s*force:\s*true\s*\}\)/,
    "Hot-reload confirmation should still cancel pending fallback and refresh skill views",
  );
  assert.doesNotMatch(
    appSource,
    /pendingSkillFallbackAutoReload|setPendingSkillFallbackAutoReload/,
    "Legacy fallback auto-reload state should not remain in app.tsx",
  );
  assert.doesNotMatch(
    appSource,
    /legacy reload-required events|Legacy skill-fallback auto-reload removed/,
    "Removed legacy fallback listeners should not leave empty explanatory blocks behind",
  );
});

test("skill registry orchestrator owns event polling, replay, and inventory refresh behavior", () => {
  const workspacePendingHandler = extractArrowObjectPropertyBody(orchestratorSource, "onWorkspaceUpdatePending");
  const globalUpdateHandler = extractArrowObjectPropertyBody(orchestratorSource, "onGlobalUpdate");

  assert.match(
    orchestratorSource,
    /createSkillRegistryEventsListener/,
    "Orchestrator should create the registry event listener",
  );
  assert.match(
    orchestratorSource,
    /deps\.invalidateSkillRegistryInventory\(\)/,
    "Registry events should invalidate skill inventory through the extensions store",
  );
  assert.match(
    workspacePendingHandler,
    /hasWorkspaceBusySessions\(deps\.workspaceBusy\(\), update\.workspaceId\)[\s\S]*syncWorkspaceSkillMaterialization\(update\.workspaceId,\s*\{[\s\S]*materializationAuthContext\(\)[\s\S]*activeRun: true[\s\S]*\}\)/s,
    "Active workspace updates must request pending materialization instead of mutating files under a running session",
  );
  assert.match(
    workspacePendingHandler,
    /queuePendingSkillRegistryWorkspaceReplay\(update\.workspaceId,\s*update\.event\.id\)/,
    "Active workspace updates under a running session should be replayed after the run is idle",
  );
  assert.match(
    orchestratorSource,
    /setPendingSkillRegistryWorkspaceReplays/,
    "Workspace registry replay state should be persisted until the workspace becomes idle",
  );
  assert.match(
    workspacePendingHandler,
    /syncWorkspaceSkillMaterialization\(\s*update\.workspaceId,\s*[\s\S]*materializationAuthContext\(\)[\s\S]*\)[\s\S]*refreshAfterSkillRegistryMaterialization\(result\)/s,
    "Active workspace updates with no running session should materialize immediately and refresh skills",
  );
  assert.match(
    globalUpdateHandler,
    /syncGlobalSkillMaterialization\(\{[\s\S]*materializationAuthContext\(\)[\s\S]*activeRun: true[\s\S]*\}\)[\s\S]*setPendingGlobalSkillRegistryReplay/s,
    "Global registry updates under active runs should request pending materialization and store a global replay",
  );
  assert.match(
    globalUpdateHandler,
    /syncGlobalSkillMaterialization\(materializationAuthContext\(\)\)[\s\S]*refreshAfterSkillRegistryMaterialization\(result\)/s,
    "Global registry updates should use the global materialization API and refresh skills",
  );
  assert.match(
    orchestratorSource,
    /refreshAfterSkillRegistryMaterialization[\s\S]*refreshSkills\(\{\s*force: true\s*\}\)[\s\S]*deps\.invalidateSkillRegistryInventory\(\)/s,
    "Registry materialization changes should refresh skills and invalidate inventory",
  );
  assert.match(
    orchestratorSource,
    /markReloadRequired\("skills"/,
    "Active workspace registry updates should surface a skill reload prompt",
  );
  assert.match(
    orchestratorSource,
    /pendingSkillRegistryWorkspaceReplays\(\)/,
    "Pending workspace registry replay state should be observed reactively",
  );
  assert.match(
    orchestratorSource,
    /if\s*\(hasWorkspaceBusySessions\(busyWorkspaces,\s*workspaceId\)\)\s*continue;[\s\S]*replayPendingSkillRegistryWorkspaceUpdate\(client,\s*workspaceId,\s*pending\)/s,
    "Pending workspace registry updates should wait until that workspace is no longer busy",
  );
  assert.match(
    orchestratorSource,
    /replayPendingSkillRegistryWorkspaceUpdate[\s\S]*syncWorkspaceSkillMaterialization\(\s*workspaceId,\s*[\s\S]*materializationAuthContext\(\)[\s\S]*\)/s,
    "Pending workspace registry updates should replay when that workspace is no longer busy",
  );
  assert.match(
    orchestratorSource,
    /pendingGlobalSkillRegistryReplay\(\)[\s\S]*hasAnyWorkspaceBusySessions\(deps\.workspaceBusy\(\)\)[\s\S]*syncGlobalSkillMaterialization\(materializationAuthContext\(\)\)/s,
    "Pending global registry updates should replay once every workspace is idle",
  );
  assert.match(
    orchestratorSource,
    /materializationAuthContext[\s\S]*denToken[\s\S]*denOrgId[\s\S]*denUserId/s,
    "Materialization sync calls should forward Den auth context for org workspace resolution",
  );
});
