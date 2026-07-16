import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const runtimeConfigSource = readFileSync(
  new URL("../context/managed-ai-runtime-config.ts", import.meta.url),
  "utf8",
);

function managedAiRuntimeConfigSource(): string {
  const start = runtimeConfigSource.indexOf("const performWorkspaceManagedAiConfigSync = async");
  const end = runtimeConfigSource.indexOf("function managedConfigContentsMatch", start);
  assert.ok(
    start >= 0 && end > start,
    "managed AI runtime config sync source should be present",
  );
  return runtimeConfigSource.slice(start, end);
}

test("app delegates managed AI config sync side effects to the runtime config module", () => {
  assert.match(
    appSource,
    /import \{[\s\S]*createManagedAiRuntimeConfigSync,[\s\S]*\} from "\.\/context\/managed-ai-runtime-config";/,
    "app.tsx should import the managed AI runtime config module",
  );
  assert.match(
    appSource,
    /const managedAiRuntimeConfig = createManagedAiRuntimeConfigSync\(\{[\s\S]*activeWorkspaceDisplay: \(\) => workspaceStore\.activeWorkspaceDisplay\(\),[\s\S]*readOpencodeConfig,[\s\S]*writeOpencodeConfig,[\s\S]*markReloadRequired,[\s\S]*beginManagedAiBootstrap,[\s\S]*\}\);/,
    "app.tsx should compose the module with app-owned dependencies",
  );
  assert.match(
    runtimeConfigSource,
    /resolveManagedAiConfigSyncPreflight,[\s\S]*resolveManagedAiConfigWriteDecision,[\s\S]*from "\.\.\/controllers\/managed-ai-config-sync";/,
    "runtime config module should own managed AI config sync controller decisions",
  );
});

test("managed AI runtime config sync executes controller decisions", () => {
  const syncSource = managedAiRuntimeConfigSource();

  assert.match(
    syncSource,
    /const syncPreflight = resolveManagedAiConfigSyncPreflight\(\{[\s\S]*workspaceDefaultModelReady: deps\.workspaceDefaultModelReady\(\),[\s\S]*isDesktopRuntime: deps\.isTauriRuntime\(\),[\s\S]*defaultModelExplicit: deps\.defaultModelExplicit\(\),[\s\S]*workspaceType: workspaceKind\(workspace\),[\s\S]*workspaceRoot,[\s\S]*\}\);/,
    "sync preflight should be delegated to the config sync controller",
  );
  assert.match(
    syncSource,
    /const workspaceId = workspace\.id\?\.trim\(\) \|\| targetWorkspaceId \|\| activeWorkspaceId;[\s\S]*let vesloWorkspaceId = deps\.resolveConversationServerWorkspaceId\(workspaceId\);/,
    "sync should derive the initial Veslo workspace id from the current app workspace, not stale server active status",
  );
  assert.match(
    syncSource,
    /vesloWorkspaceId = await resolveManagedAiServerWorkspaceId\(\{[\s\S]*workspaceId,[\s\S]*register: deps\.ensureConversationReadWorkspaceRegistered,[\s\S]*\}\);/,
    "local fallback app ids should be replaced by acknowledged server workspace registration before config writes",
  );
  assert.doesNotMatch(
    syncSource,
    /const vesloWorkspaceId = deps\.vesloServerWorkspaceId\(\);/,
    "sync must not read the global server active workspace id while workspace activation is settling",
  );
  assert.match(
    syncSource,
    /const providerRoutingReady = Boolean\(routing\.providerRoutingTarget\?\.serverClientToken\);/,
    "managed provider routing should depend on the local server client token, not the cloud gateway bearer",
  );
  assert.match(
    syncSource,
    /const managedDecision = resolveManagedAiConfigWriteDecision\(\{[\s\S]*managedProfilePresent: Boolean\(input\.managedProfile\),[\s\S]*providerRoutingReady: input\.providerRoutingReady,[\s\S]*managedConfigAlreadyCurrent:[\s\S]*shouldPreserveManagedConfig:[\s\S]*defaultModelAlreadyCurrent:[\s\S]*\}\);/,
    "managed/server config branch should delegate write decisions",
  );
  assert.match(
    syncSource,
    /const fileDecision = resolveManagedAiConfigWriteDecision\(\{[\s\S]*managedProfilePresent: Boolean\(input\.managedProfile\),[\s\S]*providerRoutingReady: input\.providerRoutingReady,[\s\S]*managedConfigAlreadyCurrent:[\s\S]*shouldPreserveManagedConfig:[\s\S]*defaultModelAlreadyCurrent:[\s\S]*\}\);/,
    "file config branch should delegate write decisions",
  );
});

test("managed AI config sync ignores stale async runs before writing config", () => {
  const syncSource = managedAiRuntimeConfigSource();

  assert.match(
    runtimeConfigSource,
    /const latestManagedAiConfigSyncFingerprintByScope = new Map<string, string>\(\);/,
    "sync should track the latest desired fingerprint independently for each workspace scope",
  );
  assert.match(
    runtimeConfigSource,
    /latestManagedAiConfigSyncFingerprintByScope\.set\(intent\.scopeKey, intent\.fingerprint\);[\s\S]*isCancelled: \(\) =>[\s\S]*latestManagedAiConfigSyncFingerprintByScope\.get\(intent\.scopeKey\) !== intent\.fingerprint/,
    "a newer desired fingerprint should invalidate only the stale flight for its workspace scope",
  );
  assert.match(
    syncSource,
    /const isCurrentManagedAiConfigSync = \(\) => !\(options\?\.isCancelled\?\.\(\) \?\? false\);/,
    "the config writer should honor the wrapper's scoped staleness decision",
  );
  assert.match(
    syncSource,
    /const config = await input\.vesloClient\.getConfig\(input\.vesloWorkspaceId\);\s*if \(!input\.isCurrentManagedAiConfigSync\(\)\) return;/,
    "server config reads must not continue into writes after the run is stale",
  );
  assert.match(
    syncSource,
    /if \(!input\.isCurrentManagedAiConfigSync\(\)\) return;\s*await input\.vesloClient\.patchConfig/s,
    "server config writes should be guarded by the current sync generation",
  );
  assert.match(
    syncSource,
    /const configFile = await deps\.readOpencodeConfig\("project", input\.root\);\s*if \(!input\.isCurrentManagedAiConfigSync\(\)\) return;/,
    "project config reads must not continue into writes after the run is stale",
  );
  assert.match(
    syncSource,
    /if \(!input\.isCurrentManagedAiConfigSync\(\)\) return;\s*const result = await deps\.writeOpencodeConfig/s,
    "project config writes should be guarded by the current sync generation",
  );
});

test("local Veslo workspace id uses only acknowledged server workspace mapping", () => {
  const effectMarker = appSource.indexOf("const active = workspaceStore.activeWorkspaceDisplay();");
  const localBranchStart = appSource.indexOf('if (active.workspaceType === "local") {', effectMarker);
  const localBranchEnd = appSource.indexOf("setVesloServerWorkspaceId(null);", localBranchStart);
  assert.ok(effectMarker >= 0 && localBranchStart > effectMarker && localBranchEnd > localBranchStart);
  const localBranchSource = appSource.slice(localBranchStart, localBranchEnd);

  assert.match(
    localBranchSource,
    /setVesloServerWorkspaceId\(active\.vesloWorkspaceId\?\.trim\(\) \|\| null\);/,
    "local Veslo workspace id should use only the acknowledged server-owned mapping",
  );
  assert.doesNotMatch(
    localBranchSource,
    /active\.id\?\.trim\(\) \|\|\s*workspaceStore\.activeWorkspaceId\(\)\.trim\(\)/,
    "local app workspace ids must not be published as server workspace ids",
  );
  assert.doesNotMatch(
    localBranchSource,
    /listWorkspaces\(/,
    "local workspace id resolution should not add a startup /workspaces request",
  );
});

test("project managed AI config comparison is semantic, not only byte-exact", () => {
  const syncSource = managedAiRuntimeConfigSource();

  assert.match(
    syncSource,
    /const managedConfigMatches =[\s\S]*exactContentMatches \|\|[\s\S]*managedConfigContentsMatch\(\s*configFile\.content,\s*content,[\s\S]*?\);/,
    "project config should use the same normalized managed-config comparison as server config",
  );
  assert.match(
    syncSource,
    /managedConfigAlreadyCurrent: managedConfigMatches,/,
    "semantic matches should skip project config rewrites",
  );
});
