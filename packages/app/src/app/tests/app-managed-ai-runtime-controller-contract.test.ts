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
    /const refreshPreflight = resolveManagedAiAccessRefreshPreflight\(\{[\s\S]*hasGatewayClient: Boolean\(gatewayClient\),[\s\S]*managedAiBaseUrl,[\s\S]*userToken,[\s\S]*deferForLocalGateway:[\s\S]*cachedAccessPresent: Boolean\(cachedAccess\),[\s\S]*\}\);/,
    "access refresh preflight should be delegated to the runtime controller",
  );
  assert.match(
    effectSource,
    /const successDecision = resolveManagedAiAccessRefreshSuccess\(\{[\s\S]*profile,[\s\S]*gatewayAccessToken,[\s\S]*reason,[\s\S]*\}\);/,
    "successful access refresh state transition should be delegated",
  );
  assert.match(
    effectSource,
    /const failureDecision = resolveManagedAiAccessRefreshFailure\(\{[\s\S]*cachedAccessPresent: Boolean\(cachedAccess\),[\s\S]*errorMessage: describeRequestError\(error, "Failed to load AI access"\),[\s\S]*\}\);/,
    "failed access refresh state transition should be delegated",
  );
});
