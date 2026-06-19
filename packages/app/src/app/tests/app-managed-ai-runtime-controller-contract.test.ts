import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

function managedAiAccessRefreshEffectSource(): string {
  const nonce = source.indexOf("managedAiAccessRefreshNonce();");
  const start = source.lastIndexOf("createEffect(() => {", nonce);
  const end = source.indexOf("  createEffect(() => {", nonce + 1);
  assert.ok(nonce >= 0 && start >= 0 && end > start, "managed AI access refresh effect should be present");
  return source.slice(start, end);
}

test("app delegates managed AI access refresh decisions to the runtime controller", () => {
  assert.match(
    source,
    /import \{\s*resolveManagedAiAccessRefreshFailure,\s*resolveManagedAiAccessRefreshPreflight,\s*resolveManagedAiAccessRefreshSuccess,\s*\} from "\.\/controllers\/managed-ai-runtime-controller";/,
    "app.tsx should import managed AI runtime controller helpers",
  );
});

test("managed AI access refresh effect executes controller decisions", () => {
  const effectSource = managedAiAccessRefreshEffectSource();

  assert.match(
    effectSource,
    /const refreshPreflight = resolveManagedAiAccessRefreshPreflight\(\{[\s\S]*hasGatewayClient: Boolean\(gatewayClient\),[\s\S]*managedAiBaseUrl,[\s\S]*userToken,[\s\S]*deferForLocalGateway:[\s\S]*cachedAccessPresent: Boolean\(cachedAccess\),[\s\S]*freshCachedAccessPresent: Boolean\(proofCachedAccess\),[\s\S]*\}\);/,
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
    /const failureDecision = resolveManagedAiAccessRefreshFailure\(\{[\s\S]*cachedAccessPresent: Boolean\(cachedAccess\),[\s\S]*errorMessage: describeRequestError\(error, t\(AI_ACCESS_LOAD_FAILED_MESSAGE_KEY, currentLocale\(\)\)\),[\s\S]*\}\);/,
    "failed access refresh state transition should be delegated",
  );
});

test("desktop managed AI proof cache stores policy metadata without gateway tokens", () => {
  const proofWriteCall = source.match(/void accessProofAiWrite\(\{[\s\S]*?\}\)\.catch/);
  assert.ok(proofWriteCall, "desktop proof cache write should be present");

  assert.match(
    proofWriteCall[0],
    /void accessProofAiWrite\(\{[\s\S]*cacheKey,[\s\S]*proof: \{[\s\S]*providerId: profile\.providerId,[\s\S]*defaultModel: profile\.defaultModel,[\s\S]*allowedModels: profile\.allowedModels,[\s\S]*updatedAt: profile\.updatedAt,[\s\S]*\},[\s\S]*\}\)/,
    "desktop proof cache should write only profile metadata",
  );
  assert.doesNotMatch(
    proofWriteCall[0],
    /gatewayAccessToken/,
    "desktop proof cache must not persist gateway access tokens",
  );
});
