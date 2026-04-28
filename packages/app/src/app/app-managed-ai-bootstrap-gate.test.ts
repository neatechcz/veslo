import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("sendPrompt waits for managed bootstrap readiness before reading client", () => {
  assert.match(
    source,
    /async function sendPrompt\(draft\?: ComposerDraft\)[\s\S]*?await ensureManagedAiBootstrapReady\(\);\s*const c = client\(\);/s,
    "sendPrompt should wait for managed bootstrap readiness before grabbing the local client",
  );
});

test("createSessionAndOpen waits for managed bootstrap readiness before reading client", () => {
  assert.match(
    source,
    /async function createSessionAndOpen\(\)[\s\S]*?await ensureManagedAiBootstrapReady\(\);\s*const c = client\(\);/s,
    "createSessionAndOpen should wait for managed bootstrap readiness before grabbing the local client",
  );
});

test("managed AI bootstrap writes config with the managed gateway token when present and otherwise falls back to the DEN auth token", () => {
  assert.match(
    source,
    /const managedProfile = managedAiAccess\(\);[\s\S]*?const gatewayClient = gatewayVesloServerClient\(\);\s*const gatewayClientToken = gatewayClient\?\.token\?\.trim\(\) \?\? "";\s*const gatewayAccessToken = managedAiGatewayAccessToken\(\) \|\| denGatewayAccessToken\(\);/s,
    "managed AI config writes should prefer the managed gateway token and fall back to the DEN auth token when no separate token is provided",
  );
});

test("managed AI bootstrap preserves existing managed routing instead of downgrading to model-only config on transient access gaps", () => {
  assert.match(
    source,
    /shouldPreserveManagedAiConfig\(\{\s*content: configFile\.content,[\s\S]*?const content = formatConfigWithDefaultModel\(configFile\.content, nextModel\);/s,
    "managed AI config writes should preserve existing gateway routing before falling back to a model-only config",
  );
});

test("managed AI access refresh keeps the proxied gateway access token when using the local Veslo server client", () => {
  assert.doesNotMatch(
    source,
    /gatewayClient!\.getMyAiAccess\(userToken\)\.then\(\(response\) => \(\{\s*aiAccess: response\.aiAccess,\s*accessToken: null,\s*\}\)\)/s,
    "managed AI refresh should not discard the access token returned by the local Veslo server proxy",
  );
});

test("managed AI bootstrap skips veslo-server config patches when the computed managed config is unchanged", () => {
  assert.match(
    source,
    /const currentOpencodeContent = JSON\.stringify\(config\.opencode \?\? \{\}, null, 2\);[\s\S]*?const content = formatManagedAiAccessConfig\([\s\S]*?const desiredSnapshot = getConfigSnapshot\(content\);[\s\S]*?if \(lastKnownConfigSnapshot\(\) === desiredSnapshot\) return;[\s\S]*?if \(managedConfigContentsMatchForServerPatch\(currentOpencodeContent, content\)\) \{\s*setLastKnownConfigSnapshot\(desiredSnapshot\);\s*return;\s*\}[\s\S]*?await vesloClient\.patchConfig/s,
    "managed AI config writes through veslo-server should no-op when the generated config only differs by server-redacted secrets, while still tracking the real secret-bearing snapshot",
  );
});

test("managed AI reload coalescing records the server token only after a successful reload", () => {
  const reloadBlocks = source.match(
    /if \(\s*shouldAutoReloadManagedAiConfig\(\{[\s\S]*?\}\) &&\s*lastReloadedForServerToken\(\) !== gatewayClientToken\s*\) \{\s*const managedAiReloaded = await reloadWorkspaceEngine\(\);\s*if \(managedAiReloaded\) \{\s*setLastReloadedForServerToken\(gatewayClientToken\);\s*\}\s*\}/g,
  );

  assert.equal(
    reloadBlocks?.length,
    2,
    "both managed AI reload branches should mark the server token only after reloadWorkspaceEngine reports success",
  );
});
