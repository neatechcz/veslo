import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

function managedAiConfigSyncEffectSource(): string {
  const marker = source.indexOf("const managedProfile = managedAiAccess();");
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
    /const managedDecision = resolveManagedAiConfigWriteDecision\(\{[\s\S]*managedProfilePresent: Boolean\(managedProfile\),[\s\S]*providerRoutingReady,[\s\S]*managedConfigAlreadyCurrent:[\s\S]*shouldPreserveManagedConfig:[\s\S]*defaultModelAlreadyCurrent:[\s\S]*\}\);/,
    "managed/server config branch should delegate write decisions",
  );

  assert.match(
    effectSource,
    /const fileDecision = resolveManagedAiConfigWriteDecision\(\{[\s\S]*managedProfilePresent: Boolean\(managedProfile\),[\s\S]*providerRoutingReady,[\s\S]*managedConfigAlreadyCurrent:[\s\S]*shouldPreserveManagedConfig:[\s\S]*defaultModelAlreadyCurrent:[\s\S]*\}\);/,
    "file config branch should delegate write decisions",
  );
});
