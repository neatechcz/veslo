import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

function managedAiConfigSyncEffectSource(): string {
  const marker = source.indexOf("const syncPreflight = resolveManagedAiConfigSyncPreflight");
  const start = source.lastIndexOf("createEffect(() => {", marker);
  const end = source.indexOf("  // VSLO-86: heal stale gateway baseURL", marker);
  assert.ok(marker >= 0 && start >= 0 && end > start, "managed AI config sync effect should be present");
  return source.slice(start, end);
}

test("app delegates managed AI config sync decisions to the config sync controller", () => {
  assert.match(
    source,
    /import \{\s*resolveManagedAiConfigSyncPreflight,\s*resolveManagedAiConfigWriteDecision,\s*\} from "\.\/controllers\/managed-ai-config-sync";/,
    "app.tsx should import managed AI config sync controller helpers",
  );
});

test("managed AI config sync effect executes controller decisions", () => {
  const effectSource = managedAiConfigSyncEffectSource();

  assert.match(
    effectSource,
    /const syncPreflight = resolveManagedAiConfigSyncPreflight\(\{[\s\S]*workspaceDefaultModelReady: workspaceDefaultModelReady\(\),[\s\S]*isDesktopRuntime: isTauriRuntime\(\),[\s\S]*defaultModelExplicit: defaultModelExplicit\(\),[\s\S]*workspaceType: workspace\.workspaceType,[\s\S]*workspaceRoot: workspaceStore\.activeWorkspacePath\(\),[\s\S]*\}\);/,
    "sync preflight should be delegated to the config sync controller",
  );
  assert.match(
    effectSource,
    /const workspaceId = workspace\.id\?\.trim\(\) \|\| workspaceStore\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*const vesloWorkspaceId = resolveConversationServerWorkspaceId\(workspaceId\);/,
    "sync should derive the Veslo workspace id from the current app workspace, not stale server active status",
  );
  assert.doesNotMatch(
    effectSource,
    /const vesloWorkspaceId = vesloServerWorkspaceId\(\);/,
    "sync must not read the global server active workspace id while workspace activation is settling",
  );

  assert.match(
    effectSource,
    /const managedDecision = resolveManagedAiConfigWriteDecision\(\{[\s\S]*managedProfilePresent: Boolean\(managedProfile\),[\s\S]*providerRoutingReady,[\s\S]*managedConfigAlreadyCurrent:[\s\S]*shouldPreserveManagedConfig:[\s\S]*defaultModelAlreadyCurrent:[\s\S]*\}\);/,
    "managed/server config branch should delegate write decisions",
  );

  assert.match(
    effectSource,
    /const fileDecision = resolveManagedAiConfigWriteDecision\(\{[\s\S]*managedProfilePresent: Boolean\(managedProfile\),[\s\S]*providerRoutingReady,[\s\S]*managedConfigAlreadyCurrent:[\s\S]*shouldPreserveManagedConfig:[\s\S]*defaultModelAlreadyCurrent:[\s\S]*\}\);/,
    "file config branch should delegate write decisions",
  );
});

test("managed AI config sync ignores stale async runs before writing config", () => {
  const effectSource = managedAiConfigSyncEffectSource();

  assert.match(
    source,
    /let managedAiConfigSyncGeneration = 0;/,
    "sync should track async generations across effect reruns",
  );
  assert.match(
    effectSource,
    /const syncGeneration = \+\+managedAiConfigSyncGeneration;[\s\S]*const isCurrentManagedAiConfigSync = \(\) =>[\s\S]*!cancelled && syncGeneration === managedAiConfigSyncGeneration;/,
    "each sync run should be invalidated when a newer reactive run starts",
  );
  assert.match(
    effectSource,
    /const config = await vesloClient\.getConfig\(vesloWorkspaceId\);\s*if \(!isCurrentManagedAiConfigSync\(\)\) return;/,
    "server config reads must not continue into writes after the run is stale",
  );
  assert.match(
    effectSource,
    /if \(!isCurrentManagedAiConfigSync\(\)\) return;\s*await vesloClient\.patchConfig/s,
    "server config writes should be guarded by the current sync generation",
  );
  assert.match(
    effectSource,
    /const configFile = await readOpencodeConfig\("project", root\);\s*if \(!isCurrentManagedAiConfigSync\(\)\) return;/,
    "project config reads must not continue into writes after the run is stale",
  );
  assert.match(
    effectSource,
    /if \(!isCurrentManagedAiConfigSync\(\)\) return;\s*const result = await writeOpencodeConfig/s,
    "project config writes should be guarded by the current sync generation",
  );
});

test("project managed AI config comparison is semantic, not only byte-exact", () => {
  const effectSource = managedAiConfigSyncEffectSource();

  assert.match(
    effectSource,
    /const managedConfigMatches =[\s\S]*exactContentMatches \|\| managedConfigContentsMatchForServerPatch\(configFile\.content, content\);/,
    "project config should use the same normalized managed-config comparison as server config",
  );
  assert.match(
    effectSource,
    /managedConfigAlreadyCurrent: managedConfigMatches,/,
    "semantic matches should skip project config rewrites",
  );
});
