import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../context/send-runtime-readiness.ts", import.meta.url), "utf8");

function ensureManagedAiBootstrapReadySource(): string {
  const start = source.indexOf("const ensureManagedAiBootstrapReady = async");
  const end = source.indexOf("async function ensureLocalRuntimeReachableForSend", start);
  assert.ok(start >= 0 && end > start, "ensureManagedAiBootstrapReady source should be present");
  return source.slice(start, end);
}

test("send runtime readiness delegates managed AI bootstrap decisions to the controller", () => {
  assert.match(
    source,
    /import \{\s*resolveManagedAiBootstrapCurrentConfigCheck,\s*resolveManagedAiBootstrapWaitDecision,\s*\} from "\.\.\/controllers\/managed-ai-bootstrap-readiness-controller";/,
    "send-runtime-readiness should import managed AI bootstrap readiness controller helpers",
  );
});

test("ensureManagedAiBootstrapReady executes controller decisions", () => {
  const ensureSource = ensureManagedAiBootstrapReadySource();

  assert.match(
    ensureSource,
    /const currentConfigCheck = resolveManagedAiBootstrapCurrentConfigCheck\(\{[\s\S]*accessBusy: deps\.managedAiAccessBusy\(\),[\s\S]*bootstrapPendingCount: deps\.managedAiBootstrapPendingCount\(\),[\s\S]*reloadBusy: deps\.reloadBusy\(\),[\s\S]*\}\);/,
    "current runtime config validation should be delegated",
  );

  assert.match(
    ensureSource,
    /currentConfigCheck\.type === "check-current-config"[\s\S]*deps\.hasUsableManagedAiRuntimeConfigForSend\(targetWorkspace\)/,
    "current runtime config validation should only run when the controller requests it",
  );

  assert.match(
    ensureSource,
    /const waitDecision = resolveManagedAiBootstrapWaitDecision\(\{[\s\S]*managedProfilePresent: hasManagedProfile,[\s\S]*bootstrapBusy: deps\.managedAiBootstrapBusy\(\),[\s\S]*canUseCurrentManagedConfig,[\s\S]*\}\);[\s\S]*hasManagedProfile: waitDecision\.hasManagedProfile,/,
    "wait readiness options should be derived by the controller",
  );
});
