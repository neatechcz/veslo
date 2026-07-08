import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const identitiesSource = readFileSync(new URL("../../pages/identities.tsx", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../../../../../opencode-router/src/bridge.ts", import.meta.url), "utf8");

function extractStringConst(source: string, name: string): string {
  const match = source.match(new RegExp(`const ${name} = "([^"]+)";`));
  assert.ok(match?.[1], `${name} not found`);
  return match[1];
}

test("identities messaging agent path matches OpenCode Router bridge path", () => {
  const uiPath = extractStringConst(identitiesSource, "OPENCODE_ROUTER_AGENT_FILE_PATH");
  const bridgePath = extractStringConst(bridgeSource, "OPENCODE_ROUTER_AGENT_FILE_RELATIVE_PATH");

  assert.equal(uiPath, bridgePath);
  assert.equal(uiPath, ".opencode/agents/opencode-router.md");
  assert.equal(identitiesSource.includes(".opencode/agents/veslo-code-router.md"), false);
});

test("identities page uses the messaging identities domain facade for router requests", () => {
  assert.match(identitiesSource, /client\.identities\./);
  assert.equal(
    /client\.(?:opencodeRouterHealth|getOpenCodeRouter|setOpenCodeRouter|upsertOpenCodeRouter|deleteOpenCodeRouter|sendOpenCodeRouter)/.test(
      identitiesSource,
    ),
    false,
  );
});

test("identities page narrows router payloads without explicit any", () => {
  const unsafeTypeToken = "a" + "ny";

  assert.doesNotMatch(identitiesSource, new RegExp(String.raw`:\s*${unsafeTypeToken}\b`));
  assert.doesNotMatch(identitiesSource, new RegExp(String.raw`${unsafeTypeToken}\[\]`));
  assert.doesNotMatch(identitiesSource, new RegExp(String.raw`as\s+${unsafeTypeToken}\b`));
  assert.doesNotMatch(identitiesSource, new RegExp(String.raw`Record<string,\s*${unsafeTypeToken}>`));
  assert.match(identitiesSource, /stringField\(healthRes\.json, "message"\)/);
  assert.match(identitiesSource, /getTelegramUsernameFromResult\(result\.telegram\)/);
});
