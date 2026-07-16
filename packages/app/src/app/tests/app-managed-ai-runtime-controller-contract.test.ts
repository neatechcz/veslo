import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const storeSource = readFileSync(
  new URL("../context/managed-ai-access-store.ts", import.meta.url),
  "utf8",
);

function managedAiAccessRefreshEffectSource(): string {
  const nonce = storeSource.indexOf("managedAiAccessRefreshNonce();");
  const start = storeSource.lastIndexOf("effect(() => {", nonce);
  const end = storeSource.indexOf("  effect(() => {", nonce + 1);
  assert.ok(nonce >= 0 && start >= 0 && end > start, "managed AI access refresh effect should be present");
  return storeSource.slice(start, end);
}

test("app delegates managed AI access refresh decisions to the runtime controller", () => {
  assert.match(
    appSource,
    /createManagedAiAccessStore\(\{/,
    "app.tsx should compose the managed AI access store",
  );
  assert.match(
    storeSource,
    /import \{\s*resolveManagedAiAccessRefreshFailure,\s*resolveManagedAiAccessRefreshPreflight,\s*resolveManagedAiAccessRefreshSuccess,\s*\} from "\.\.\/controllers\/managed-ai-runtime-controller";/,
    "managed AI access store should import runtime controller helpers",
  );
});

test("managed AI access refresh effect executes controller decisions", () => {
  const effectSource = managedAiAccessRefreshEffectSource();

  assert.match(
    effectSource,
    /const refreshPreflight = resolveManagedAiAccessRefreshPreflight\(\{[\s\S]*hasGatewayClient: Boolean\(gatewayClient\),[\s\S]*managedAiBaseUrl,[\s\S]*userToken,[\s\S]*deferForLocalGateway(?:,|:)[\s\S]*cachedAccessPresent: Boolean\(cachedAccess\),[\s\S]*freshCachedAccessPresent: Boolean\(proofCachedAccess\?\.gatewayAccessToken\),[\s\S]*\}\);/,
    "access refresh preflight should be delegated to the runtime controller",
  );
  assert.match(
    effectSource,
    /if \(refreshPreflight\.type === "use-cache"\) \{[\s\S]*setManagedAiAccess\(cachedAccess\.profile\);[\s\S]*setManagedAiAccessBusy\(false\);[\s\S]*return;[\s\S]*\}/,
    "fresh local proof cache should short-circuit the network access refresh",
  );
  assert.match(
    effectSource,
    /const successDecision = resolveManagedAiAccessRefreshSuccess\(\{[\s\S]*profile,[\s\S]*gatewayAccessToken,[\s\S]*reason,[\s\S]*\}\);/,
    "successful access refresh state transition should be delegated",
  );
  assert.match(
    effectSource,
    /const failureDecision = resolveManagedAiAccessRefreshFailure\(\{[\s\S]*cachedAccessPresent: Boolean\(cachedAccess\),[\s\S]*errorMessage: options\.describeRequestError\([\s\S]*options\.translate\(AI_ACCESS_LOAD_FAILED_MESSAGE_KEY\),[\s\S]*\}\);/,
    "failed access refresh state transition should be delegated",
  );
});

test("desktop managed AI proof cache stores policy metadata without gateway tokens", () => {
  const start = storeSource.indexOf("export const writeManagedAiAccessCache = (");
  const end = storeSource.indexOf("export const clearManagedAiAccessCache", start);
  assert.ok(start >= 0 && end > start, "managed AI cache writer should be present");
  const cacheWriterSource = storeSource.slice(start, end);

  assert.match(
    cacheWriterSource,
    /void resolved\.proofCache\?\.write\?\.\(\{[\s\S]*cacheKey,[\s\S]*proof: \{[\s\S]*providerId: profile\.providerId,[\s\S]*effectiveModel: profile\.effectiveModel,[\s\S]*updatedAt: profile\.updatedAt,[\s\S]*\},[\s\S]*\}\)/,
    "desktop proof cache should write only profile metadata",
  );
  assert.doesNotMatch(
    cacheWriterSource.slice(cacheWriterSource.indexOf("if (resolved.isTauriRuntime())"), cacheWriterSource.indexOf("if (!resolved.storage)")),
    /gatewayAccessToken/,
    "desktop proof cache must not persist gateway access tokens",
  );
});
