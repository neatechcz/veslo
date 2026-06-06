import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("local Veslo server ensure is not gated by an existing OpenCode client", () => {
  const effectStart = source.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const ensureCall = "void ensureLocalVesloServerRunning()";
  const ensureIdx = source.indexOf(ensureCall, effectStart);
  assert.notStrictEqual(ensureIdx, -1, "local Veslo server ensure call is missing");

  const effectGuards = source.slice(effectStart, ensureIdx);
  assert.doesNotMatch(
    effectGuards,
    /if\s*\(\s*!client\(\)\s*\)\s*return/,
    "local Veslo server startup must not depend on an OpenCode client that may require the server first",
  );
});

test("local Veslo server ensure only deduplicates after a successful ensure", () => {
  const effectStart = source.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const ensureCall = "void ensureLocalVesloServerRunning()";
  const ensureIdx = source.indexOf(ensureCall, effectStart);
  assert.notStrictEqual(ensureIdx, -1, "local Veslo server ensure call is missing");

  const effectEnd = source.indexOf("const restartLocalServer = async () => {", ensureIdx);
  assert.notStrictEqual(effectEnd, -1, "local Veslo server ensure effect end marker is missing");
  const effectSource = source.slice(effectStart, effectEnd);

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

test("local Veslo workspace readiness matches all server path candidates", () => {
  const resolutionEffectStart = source.indexOf("const vesloUrl = vesloServerUrl().trim();");
  assert.notStrictEqual(resolutionEffectStart, -1, "Veslo workspace resolution effect is missing");

  const localBranchStart = source.indexOf('if (active.workspaceType === "local") {', resolutionEffectStart);
  assert.notStrictEqual(localBranchStart, -1, "local Veslo workspace resolution branch is missing");

  const localBranchEnd = source.indexOf("void resolveWorkspace();", localBranchStart);
  assert.notStrictEqual(localBranchEnd, -1, "local Veslo workspace resolution branch end marker is missing");
  const localBranch = source.slice(localBranchStart, localBranchEnd);

  assert.match(localBranch, /entry\.path/);
  assert.match(localBranch, /entry\.directory/);
  assert.match(localBranch, /entry\.opencode\?\.directory/);
});

test("local Veslo server ensure effect is registered after the real implementation is assigned", () => {
  const effectStart = source.indexOf('let lastLocalVesloEnsureKey = "";');
  assert.notStrictEqual(effectStart, -1, "local Veslo server ensure effect is missing");

  const assignmentStart = source.indexOf("ensureLocalVesloServerRunning = async (options) => {");
  assert.notStrictEqual(assignmentStart, -1, "local Veslo server ensure assignment is missing");

  assert.ok(
    effectStart > assignmentStart,
    "local Veslo server ensure effect must not call the initial no-op implementation",
  );
});
