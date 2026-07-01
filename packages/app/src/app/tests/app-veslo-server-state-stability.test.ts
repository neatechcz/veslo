import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const connectionSource = readFileSync(
  new URL("../context/veslo-server-connection.ts", import.meta.url),
  "utf8",
);
const runtimeConfigSource = readFileSync(
  new URL("../context/managed-ai-runtime-config.ts", import.meta.url),
  "utf8",
);

const countMatches = (haystack: string, pattern: RegExp) => [...haystack.matchAll(pattern)].length;

function inactiveWorkspaceBaseUrlHealEffectSource(): string {
  const start = runtimeConfigSource.indexOf("const healInactiveManagedAiWorkspaceConfigs = async");
  const end = runtimeConfigSource.indexOf("effect(() => {", start);
  assert.ok(start >= 0 && end > start, "inactive workspace baseURL heal effect should be present");
  return runtimeConfigSource.slice(start, end);
}

test("Veslo server polling stores stable capability and host-info signal values", () => {
  assert.match(
    connectionSource,
    /const setVesloServerCapabilitiesStable = \(next: VesloServerCapabilities \| null\) => \{[\s\S]*setVesloServerCapabilities\(\(current\) =>[\s\S]*stateKey\(current\) === nextKey \? current : next[\s\S]*\};/,
    "capabilities should keep the previous signal value when polled content is unchanged",
  );
  assert.match(
    connectionSource,
    /const setVesloServerHostInfoStable = \(next: VesloServerInfo \| null\) => \{[\s\S]*setVesloServerHostInfo\(\(current\) =>[\s\S]*stateKey\(current\) === nextKey \? current : next[\s\S]*\};/,
    "host info should keep the previous signal value when polled content is unchanged",
  );
  assert.equal(
    countMatches(connectionSource, /\bsetVesloServerCapabilities\(/g),
    1,
    "runtime code should update capabilities through the stable setter only",
  );
  assert.equal(
    countMatches(connectionSource, /\bsetVesloServerHostInfo\(/g),
    1,
    "runtime code should update host info through the stable setter only",
  );
});

test("Veslo server routing effects ignore host-info diagnostic churn", () => {
  assert.match(
    connectionSource,
    /const activeVesloServerRoutingInfo = createMemo\([\s\S]*baseUrl: hostInfo\.baseUrl\?\.trim\(\) \?\? "",[\s\S]*engineUrl: hostInfo\.engineUrl\?\.trim\(\) \?\? "",[\s\S]*clientToken: hostInfo\.clientToken\?\.trim\(\) \?\? "",[\s\S]*equals: \(prev, next\) =>[\s\S]*prev\?\.baseUrl[\s\S]*next\?\.baseUrl[\s\S]*prev\?\.engineUrl[\s\S]*next\?\.engineUrl[\s\S]*prev\?\.clientToken[\s\S]*next\?\.clientToken/s,
    "routing effects should depend on stable routing fields instead of the full host-info object",
  );
  assert.match(
    runtimeConfigSource,
    /const providerRoutingLocalHost = deps\.activeVesloServerRoutingInfo\(\);[\s\S]*managed-ai-config-sync:preflight/s,
    "managed config sync should use stable routing info",
  );
});

test("inactive workspace baseURL healing skips active workspace and stale async runs", () => {
  const effectSource = inactiveWorkspaceBaseUrlHealEffectSource();

  assert.match(
    runtimeConfigSource,
    /let inactiveWorkspaceBaseUrlHealGeneration = 0;/,
    "inactive workspace healing should track async generations across effect reruns",
  );
  assert.match(
    effectSource,
    /const activeWorkspaceAppId = activeWorkspace\.id\?\.trim\(\) \|\| deps\.activeWorkspaceId\(\)\.trim\(\);[\s\S]*const activeWorkspaceId =[\s\S]*deps\.resolveConversationServerWorkspaceId\(activeWorkspaceAppId\) \|\|[\s\S]*activeWorkspaceAppId\.startsWith\("ws-"\) \? activeWorkspaceAppId : ""[\s\S]*\(deps\.vesloServerWorkspaceId\(\) \?\? ""\)\.trim\(\);/,
    "inactive workspace healing should resolve the active server workspace id before listing workspaces",
  );
  assert.match(
    effectSource,
    /const healGeneration = \+\+inactiveWorkspaceBaseUrlHealGeneration;[\s\S]*const isCurrentInactiveWorkspaceHeal = \(\) =>[\s\S]*!\(options\?\.isCancelled\?\.\(\) \?\? false\) &&[\s\S]*healGeneration === inactiveWorkspaceBaseUrlHealGeneration;/,
    "inactive workspace healing should invalidate older async runs",
  );
  assert.match(
    effectSource,
    /if \(!isCurrentInactiveWorkspaceHeal\(\)\) return;[\s\S]*if \(workspace\.id === activeWorkspaceId\) continue;[\s\S]*if \(!isCurrentInactiveWorkspaceHeal\(\)\) return;\s*await vesloClient\.patchConfig/s,
    "inactive workspace healing should check generation before patching and skip the active workspace",
  );
});
