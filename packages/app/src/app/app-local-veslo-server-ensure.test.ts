import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const connectionSource = readFileSync(new URL("./context/veslo-server-connection.ts", import.meta.url), "utf8");

test("local Veslo server ensure is not gated by an existing OpenCode client", () => {
  const effectStart = connectionSource.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const ensureCall = "void ensureLocalVesloServerRunning()";
  const ensureIdx = connectionSource.indexOf(ensureCall, effectStart);
  assert.notStrictEqual(ensureIdx, -1, "local Veslo server ensure call is missing");

  const effectGuards = connectionSource.slice(effectStart, ensureIdx);
  assert.doesNotMatch(
    effectGuards,
    /if\s*\(\s*!deps\.routedClient\?\.\(\)\s*\)\s*return/,
    "local Veslo server startup must not depend on an OpenCode client that may require the server first",
  );
});

test("local Veslo server ensure only deduplicates after a successful ensure", () => {
  const effectStart = connectionSource.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const ensureCall = "void ensureLocalVesloServerRunning()";
  const ensureIdx = connectionSource.indexOf(ensureCall, effectStart);
  assert.notStrictEqual(ensureIdx, -1, "local Veslo server ensure call is missing");

  const effectEnd = connectionSource.indexOf("return {", ensureIdx);
  assert.notStrictEqual(effectEnd, -1, "local Veslo server ensure effect end marker is missing");
  const effectSource = connectionSource.slice(effectStart, effectEnd);

  assert.doesNotMatch(
    effectSource.slice(0, ensureIdx - effectStart),
    /lastLocalVesloEnsureKey\s*=\s*nextKey/,
    "transient startup failures must not mark a local server ensure key as handled",
  );
  assert.match(
    effectSource,
    /\.then\(\(ok\) => \{[\s\S]*if \(ok\) \{[\s\S]*lastLocalVesloEnsureKey = scheduledKey;/,
    "local server ensure deduplication should be recorded only after a successful ensure",
  );
});

test("local Veslo workspace readiness uses only the server-owned workspace id", () => {
  const resolutionEffectStart = source.indexOf("const active = workspaceStore.activeWorkspaceDisplay();");
  assert.notStrictEqual(resolutionEffectStart, -1, "Veslo workspace resolution effect is missing");

  const localBranchStart = source.indexOf('if (active.workspaceType === "local") {', resolutionEffectStart);
  assert.notStrictEqual(localBranchStart, -1, "local Veslo workspace resolution branch is missing");

  const localBranchEnd = source.indexOf("return;", localBranchStart);
  assert.notStrictEqual(localBranchEnd, -1, "local Veslo workspace resolution branch end marker is missing");
  const localBranch = source.slice(localBranchStart, localBranchEnd);

  assert.match(localBranch, /setVesloServerWorkspaceId\(active\.vesloWorkspaceId\?\.trim\(\) \|\| null\);/);
  assert.doesNotMatch(
    localBranch,
    /active\.id|workspaceStore\.activeWorkspaceId|listWorkspaces|entry\.path|entry\.directory|entry\.opencode\?\.directory/,
  );
});

test("local Veslo server ensure effect is registered after the real implementation is assigned", () => {
  const effectStart = connectionSource.indexOf("void ensureLocalVesloServerRunning()");
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const implementationStart = connectionSource.indexOf("const ensureLocalVesloServerRunning = async");
  assert.notStrictEqual(implementationStart, -1, "local Veslo server ensure implementation is missing");

  assert.ok(
    effectStart > implementationStart,
    "local Veslo server ensure effect must not call the initial no-op implementation",
  );
});
