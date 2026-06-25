import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");

test("settings devtools expose configured and effective runtime sandbox state", () => {
  assert.match(source, /resolveEffectiveRuntimeSandboxState/);
  assert.match(source, /const runtimeSandboxState = createMemo/);
  assert.match(source, /configuredSandbox: props\.vesloServerCapabilities\?\.sandbox/);
  assert.match(source, /engineInfo: props\.engineInfo/);
  assert.match(source, /orchestratorEngines: props\.orchestratorStatus\?\.engines \?\? null/);
  assert.match(source, /runtimeSandbox: runtimeSandboxReport\(\)/);
  assert.match(source, />Runtime sandbox</);
  assert.match(source, /Configured backend \{runtimeSandboxState\(\)\.configuredBackend\}/);
  assert.match(source, /Effective backend \{runtimeSandboxState\(\)\.effectiveBackend\}/);
  assert.match(source, /Engine child \{runtimeSandboxState\(\)\.childKind \?\? "unknown"\}/);
  assert.match(source, /Fallback \{runtimeSandboxState\(\)\.sandboxFallback/);
});
